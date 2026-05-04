// lib/audit/agents/full_product.js — audit_full_product handler.
//
// This handler does NOT do its own audit work. It enqueues N child tasks
// (one per applicable audit agent for the named product) and returns immediately.
// The worker drains them in subsequent ticks. The dashboard groups results by
// scope.full_product_id (a uuid we generate here and stamp on each child).

import { supabase } from "../../supabase.js";

// Per-product, which agents should run.
const PRODUCT_AGENTS = {
  cart2save:  ["repo", "deployments", "env", "schema", "api_failures", "affiliate"],
  quickscanz: ["repo", "deployments", "env", "schema", "api_failures", "notifications"],
  quietkeep:  ["repo", "deployments", "env", "schema", "api_failures", "auth"],
  vidyagrid:  ["repo", "deployments", "env", "schema", "api_failures"],
  schoolos:   ["repo", "deployments", "env", "schema", "api_failures", "auth"],
  pranix_site:["repo", "deployments", "env", "api_failures"],
};

const AGENT_TO_ACTION = {
  repo:           "audit_repo",
  deployments:    "audit_deployments",
  env:            "audit_env_vars",
  schema:         "audit_schema_drift",
  api_failures:   "audit_api_failures",
  affiliate:      "audit_affiliate_health",
  notifications:  "audit_notifications",
  auth:           "audit_auth_flow",
};

export async function auditFullProduct(task) {
  const product_name = task.input?.product_name;
  if (!product_name) return { ok: false, retryable: false, error: "input.product_name required" };

  const agents = PRODUCT_AGENTS[product_name];
  if (!agents || agents.length === 0) {
    return { ok: false, retryable: false, error: `no audit plan defined for product '${product_name}'` };
  }

  // One UUID groups every child audit run together
  const full_product_id = crypto.randomUUID();
  const today = new Date().toISOString().slice(0, 10);

  const rows = agents.map((agent, i) => {
    const action = AGENT_TO_ACTION[agent];
    return {
      action,
      input: { product_name, full_product_id, parent_task_id: task.id },
      state: "pending",
      priority: 5,
      // Deterministic key: one child task per (product, agent, day)
      idempotency_key: `audit_${product_name}_${agent}_${today}`,
      max_attempts: 2,
      // Stagger the available_at so we don't slam external APIs all at once
      available_at: new Date(Date.now() + i * 5_000).toISOString(),
    };
  });

  // Insert the children. Ignore duplicates (today's audit already exists).
  let scheduled = 0, deduped = 0;
  for (const row of rows) {
    const { error } = await supabase.from("tasks").insert(row);
    if (!error) scheduled++;
    else if (error.code === "23505") deduped++;
    else {
      return { ok: false, retryable: true, error: `failed to enqueue child audit: ${error.message}` };
    }
  }

  return {
    ok: true,
    result: {
      full_product_id,
      product_name,
      day: today,
      agents_scheduled: scheduled,
      agents_deduped:   deduped,
      total_planned:    agents.length,
    },
  };
}
