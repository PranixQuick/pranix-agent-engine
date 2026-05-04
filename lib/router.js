// lib/router.js — Phase D founder command router.
//
// Pipeline:
//   1. Parse natural-language command via Claude (parseIntent).
//   2. Resolve route from agent_routes (intent → ordered agent list).
//   3. Call each agent's plan(scope, ctx) → flat list of PlannedAction.
//   4. Compute approval requirement (ANY action requires_approval=true → block).
//   5. Persist into command_invocations.
//   6. If no approval needed → enqueue tasks immediately.
//      Else → write a founder_alert with an approval link.

import { supabase, alert } from "./supabase.js";
import { parseIntent } from "./clients/anthropic.js";

import * as infra      from "./agents/infra.js";
import * as repo       from "./agents/repo.js";
import * as deployment from "./agents/deployment.js";
import * as debugging  from "./agents/debugging.js";
import * as compliance from "./agents/compliance.js";

const AGENTS = { infra, repo, deployment, debugging, compliance };

function generateToken() {
  // 32 hex chars; not cryptographically perfect for high-stakes auth but fine
  // for a single-use approval bound to a row id (DB also gates state transitions).
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2, "0")).join("");
}

async function listKnownProducts() {
  const { data } = await supabase.from("project_registry").select("project_name");
  return (data || []).map(r => r.project_name);
}

async function listKnownIntents() {
  const { data } = await supabase.from("agent_routes").select("intent").eq("is_active", true);
  return (data || []).map(r => r.intent);
}

async function getRoute(intent) {
  const { data } = await supabase
    .from("agent_routes")
    .select("agents, default_scope")
    .eq("intent", intent).eq("is_active", true).maybeSingle();
  return data || null;
}

/**
 * Build a planning context that agents share.
 */
function buildPlanCtx(allProducts) {
  return {
    allProducts,
    async resolveProducts(scope) {
      if (!scope || !scope.products) return [];
      if (scope.products === "all") return allProducts.filter(p => p !== "pranix_site"); // exclude marketing site by default
      if (Array.isArray(scope.products)) {
        return scope.products.filter(p => allProducts.includes(p));
      }
      return [];
    },
  };
}

/**
 * Run a command end-to-end. Returns a worker-handler-compatible result.
 *
 * input.text   — raw founder utterance (required)
 * input.skip_approval — if true, treat any 'requires_approval' action as approved (DANGEROUS)
 *
 * The function ALWAYS persists a command_invocations row. Even on parse failure.
 */
export async function routeCommand(task) {
  const text = task.input?.text;
  if (!text || typeof text !== "string") {
    return { ok: false, retryable: false, error: "input.text required" };
  }

  // 1. Open command_invocations row
  const { data: opened, error: openErr } = await supabase.rpc("open_command_invocation", { p_command_text: text });
  if (openErr || !opened) {
    return { ok: false, retryable: true, error: `open_command_invocation failed: ${openErr?.message}` };
  }
  const cmd_id = opened;

  // 2. Parse intent
  const knownProducts = await listKnownProducts();
  const knownIntents  = await listKnownIntents();
  const parsed = await parseIntent(text, knownProducts, knownIntents);

  if (!parsed.ok) {
    await supabase.from("command_invocations").update({
      status: "errored", parsed_intent: { error: parsed.error },
    }).eq("id", cmd_id);
    return { ok: false, retryable: !!parsed.retryable, error: `intent parse failed: ${parsed.error}` };
  }

  const intent = parsed.parsed.intent;
  const scope  = parsed.parsed.scope || {};

  if (intent === "unknown") {
    await supabase.from("command_invocations").update({
      status: "errored",
      parsed_intent: parsed.parsed,
    }).eq("id", cmd_id);
    await alert({
      level: "warn", source: "router",
      title: "Founder command not understood",
      body:  `Could not parse: "${text}"`,
      context: { command_id: cmd_id, parsed: parsed.parsed },
    });
    return { ok: false, retryable: false, error: "unknown intent" };
  }

  // 3. Resolve route
  const route = await getRoute(intent);
  if (!route) {
    await supabase.from("command_invocations").update({
      status: "errored",
      parsed_intent: { ...parsed.parsed, route_error: `no route for intent '${intent}'` },
    }).eq("id", cmd_id);
    return { ok: false, retryable: false, error: `no agent_routes row for intent '${intent}'` };
  }

  // 4. Build effective scope and plan
  const effectiveScope = { ...route.default_scope, ...scope, intent };
  const ctx = buildPlanCtx(knownProducts);

  const planned = [];
  for (const agentName of route.agents) {
    const agent = AGENTS[agentName];
    if (!agent) continue;
    try {
      const part = await agent.plan(effectiveScope, ctx);
      for (const p of part) planned.push(p);
    } catch (e) {
      planned.push({
        agent: agentName, action_name: null, input: null,
        requires_approval: false,
        plan_error: e?.message || String(e),
      });
    }
  }

  if (planned.length === 0) {
    await supabase.from("command_invocations").update({
      status: "completed",
      parsed_intent: parsed.parsed,
      planned_actions: [],
      result_summary: { reason: "no actions planned", scope: effectiveScope },
    }).eq("id", cmd_id);
    return { ok: true, result: { command_id: cmd_id, planned: 0, intent } };
  }

  // 5. Approval gate
  const needsApproval = planned.some(p => p.requires_approval) && !task.input?.skip_approval;
  const token = needsApproval ? generateToken() : null;

  await supabase.from("command_invocations").update({
    parsed_intent:   parsed.parsed,
    planned_actions: planned,
    status:          needsApproval ? "pending_approval" : "approved",
    approval_token:  token,
  }).eq("id", cmd_id);

  if (needsApproval) {
    const baseUrl = process.env.PUBLIC_BASE_URL || "https://pranix-agent-engine.vercel.app";
    const approveUrl = `${baseUrl}/api/approve_command?id=${cmd_id}&token=${token}`;
    await alert({
      level: "warn", source: "router",
      title: "Founder approval required",
      body: `Command "${text}" planned ${planned.length} action(s); ${planned.filter(p=>p.requires_approval).length} require approval.\nApprove: ${approveUrl}`,
      context: { command_id: cmd_id, intent, planned, approve_url: approveUrl },
    });
    return { ok: true, result: { command_id: cmd_id, status: "pending_approval", planned: planned.length, requires_approval: true } };
  }

  // 6. No approval → enqueue execution task
  const { data: execTask, error: execErr } = await supabase
    .from("tasks")
    .insert({
      action: "execute_command_plan",
      input: { command_id: cmd_id },
      state: "pending",
      priority: 3,
      idempotency_key: `cmd_exec_${cmd_id}`,
      max_attempts: 2,
    })
    .select("id")
    .single();

  if (execErr) {
    return { ok: false, retryable: true, error: `failed to enqueue executor: ${execErr.message}` };
  }

  await supabase.from("command_invocations").update({
    status: "executing",
    executed_task_ids: [execTask.id],
  }).eq("id", cmd_id);

  return {
    ok: true,
    result: { command_id: cmd_id, status: "executing", planned: planned.length, executor_task_id: execTask.id },
  };
}

/**
 * executeCommandPlan — drains a previously approved command_invocations row.
 * Looks up planned_actions, enqueues them as tasks, updates the invocation row.
 */
export async function executeCommandPlan(task) {
  const command_id = task.input?.command_id;
  if (!command_id) return { ok: false, retryable: false, error: "input.command_id required" };

  const { data: cmd, error } = await supabase
    .from("command_invocations")
    .select("id, status, planned_actions, executed_task_ids")
    .eq("id", command_id).maybeSingle();
  if (error || !cmd) return { ok: false, retryable: false, error: error?.message || "command not found" };
  if (!["approved", "executing"].includes(cmd.status)) {
    return { ok: false, retryable: false, error: `command status='${cmd.status}'; cannot execute` };
  }

  const actions = Array.isArray(cmd.planned_actions) ? cmd.planned_actions : [];
  const enqueued = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (!a?.action_name) continue;
    const idem = `cmd_${command_id}_step_${i}`;
    const { data: inserted, error: insErr } = await supabase
      .from("tasks")
      .insert({
        action: a.action_name,
        input: { ...(a.input || {}), command_id },
        state: "pending",
        priority: 5,
        available_at: new Date(Date.now() + i * 2000).toISOString(),
        idempotency_key: idem,
        max_attempts: 2,
      })
      .select("id")
      .single();
    if (insErr) {
      if (insErr.code === "23505") continue;  // already enqueued — fine
      return { ok: false, retryable: true, error: `enqueue failed at step ${i}: ${insErr.message}` };
    }
    enqueued.push(inserted.id);
  }

  await supabase.from("command_invocations").update({
    status: "completed",
    executed_task_ids: [...(cmd.executed_task_ids || []), ...enqueued],
    result_summary: { enqueued_count: enqueued.length, planned_count: actions.length },
  }).eq("id", command_id);

  return { ok: true, result: { command_id, enqueued: enqueued.length, planned: actions.length } };
}
