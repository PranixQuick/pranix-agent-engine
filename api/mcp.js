// api/mcp/[...path].ts
import { randomUUID as randomUUID2 } from "node:crypto";

// lib/auth.ts
import { createHash } from "node:crypto";

// lib/db.ts
import { createClient } from "@supabase/supabase-js";
var SUPABASE_URL = process.env.PMCP_CONTROL_PLANE_URL ?? process.env.SUPABASE_URL ?? "https://mvdjyjccvioxircxuzgz.supabase.co";
var SERVICE_KEY = process.env.PMCP_CONTROL_PLANE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? "";
if (!SERVICE_KEY) {
  console.error("[pranix-mcp] WARNING: No Supabase service key found. Set PMCP_CONTROL_PLANE_SERVICE_KEY or SUPABASE_SERVICE_KEY.");
}
var db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
  db: { schema: "public" }
});

// lib/auth.ts
function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
async function resolveClient(bearerToken) {
  if (!bearerToken || !bearerToken.startsWith("pmcp_")) return null;
  const hash = sha256Hex(bearerToken);
  const { data, error } = await db.from("mcp_clients").select("id, client_name, is_founder, vendor_hint, default_scopes, rate_limit_per_hour, active").eq("token_hash", hash).single();
  if (error || !data || !data.active) return null;
  void db.from("mcp_clients").update({ last_used_at: (/* @__PURE__ */ new Date()).toISOString() }).eq("id", data.id);
  return {
    client_id: data.id,
    client_name: data.client_name,
    is_founder: data.is_founder,
    vendor_hint: data.vendor_hint,
    default_scopes: data.default_scopes,
    rate_limit_per_hour: data.rate_limit_per_hour
  };
}
async function authorize(auth, scope, resource) {
  if (auth.is_founder) return { ok: true, source: "founder" };
  if (scope === "read") {
    const { data } = await db.from("mcp_permission_templates").select("id, resource_pattern").eq("active", true).eq("scope", "read");
    const match = (data ?? []).some((row) => matchPattern(row.resource_pattern, resource));
    return match ? { ok: true, source: "baseline_template" } : { ok: false, reason: `resource_not_in_baseline_read:${resource}` };
  }
  const { data: grants } = await db.from("mcp_access_grants").select("id, resource_pattern, expires_at").eq("client_id", auth.client_id).eq("scope", scope).is("revoked_at", null).gt("expires_at", (/* @__PURE__ */ new Date()).toISOString());
  for (const g of grants ?? []) {
    if (matchPattern(g.resource_pattern, resource)) {
      return { ok: true, source: "ephemeral_grant", expires_at: g.expires_at };
    }
  }
  return { ok: false, reason: `no_active_${scope}_grant_for_${resource}` };
}
async function resolveRouting(token) {
  if (!token || !token.startsWith("rt_")) return null;
  const { data } = await db.from("mcp_active_routing").select("routing_token, resolved_project, resolved_workflow, resolved_roles, classifier_method, classifier_confidence, expires_at").eq("routing_token", token).single();
  if (!data) return null;
  void db.rpc("increment_routing_usage", { p_token: token }).then(() => {
  }, () => {
  });
  return {
    routing_token: data.routing_token,
    project: data.resolved_project,
    workflow: data.resolved_workflow,
    roles: data.resolved_roles ?? [],
    method: data.classifier_method,
    confidence: Number(data.classifier_confidence ?? 0),
    expires_at: data.expires_at
  };
}
async function isRoutingExempt(toolName) {
  const { data } = await db.from("mcp_routing_exempt_tools").select("tool_name").eq("tool_name", toolName).maybeSingle();
  return !!data;
}
function matchPattern(pattern, resource) {
  if (pattern === "*") return true;
  if (pattern === resource) return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(resource);
}

// lib/audit.ts
async function writeAudit(entry) {
  try {
    await db.from("mcp_audit_logs").insert({
      client_id: entry.auth?.client_id ?? null,
      client_name: entry.auth?.client_name ?? null,
      tool_name: entry.tool_name,
      scope_used: entry.scope_used,
      resource: entry.resource ?? null,
      input_size: entry.input_size ?? null,
      output_size: entry.output_size ?? null,
      status_code: entry.status_code,
      latency_ms: entry.latency_ms,
      error_kind: entry.error_kind ?? null,
      ip: entry.ip ?? null,
      request_id: entry.request_id,
      job_id: entry.job_id ?? null
    });
  } catch (e) {
    console.error("[audit] failed to write audit row:", e.message);
  }
}

// tools/routing/route_task.ts
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
var SYSTEM_PROMPT_LLM_CLASSIFIER = `You classify operational tasks for a multi-product startup.
Pick exactly one project from the provided list, or "ambiguous" if the task could plausibly apply to two or more.
Reply with ONLY a single JSON object: {"project": "<name|ambiguous>", "workflow": "<workflow_name|null>", "confidence": 0.0-1.0, "reasoning": "<one sentence>"}.
No prose, no markdown, no code fences.`;
async function loadProjects() {
  const { data, error } = await db.from("project_registry").select("project_name, product_type, domains, routing_keywords, workflows, account_tier").neq("account_tier", "incubation");
  if (error) throw error;
  return data ?? [];
}
function scoreProject(p, task) {
  const lc = task.toLowerCase();
  let score = 0;
  const matched = [];
  for (const d of p.domains ?? []) {
    if (lc.includes(String(d).toLowerCase())) {
      score += 10;
      matched.push(`domain:${d}`);
    }
  }
  if (lc.includes(p.project_name.toLowerCase())) {
    score += 5;
    matched.push(`name:${p.project_name}`);
  }
  let kw_hits = 0;
  for (const kw of p.routing_keywords ?? []) {
    if (lc.includes(String(kw).toLowerCase())) {
      kw_hits += 1;
      matched.push(`kw:${kw}`);
    }
  }
  score += kw_hits;
  return { score, keyword_hits: kw_hits, matched_keywords: matched };
}
function matchWorkflow(workflows, task) {
  const lc = task.toLowerCase();
  let best = null;
  for (const wf of workflows ?? []) {
    let hits = 0;
    for (const kw of wf.keywords ?? []) {
      if (lc.includes(String(kw).toLowerCase())) hits += 1;
    }
    if (hits > 0 && (best === null || hits > best.hits)) {
      best = { name: wf.name, roles: wf.roles_required ?? [], hits };
    }
  }
  return best ? { name: best.name, roles: best.roles } : { name: null, roles: [] };
}
async function classifyViaLlm(taskText, projects) {
  const apiKey = process.env.PMCP_ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { project: null, workflow: null, confidence: 0, reasoning: "llm_unavailable:missing_PMCP_ANTHROPIC_API_KEY" };
  }
  const anthropic = new Anthropic({ apiKey });
  const projectsBrief = projects.filter((p) => p.account_tier !== "placeholder").map((p) => `- ${p.project_name} (${p.product_type ?? "?"}): ${(p.routing_keywords ?? []).slice(0, 6).join(", ")}`).join("\n");
  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: SYSTEM_PROMPT_LLM_CLASSIFIER,
      messages: [{
        role: "user",
        content: `Projects:
${projectsBrief}

Task: ${taskText}`
      }]
    });
    const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    const parsed = JSON.parse(text);
    return {
      project: parsed.project === "ambiguous" ? null : parsed.project,
      workflow: parsed.workflow,
      confidence: Number(parsed.confidence ?? 0.5),
      reasoning: parsed.reasoning ?? ""
    };
  } catch (e) {
    return { project: null, workflow: null, confidence: 0, reasoning: `llm_failed:${e.message}` };
  }
}
var routeTaskTool = {
  name: "mcp_route_task",
  description: "Universal task router. Resolves a natural-language operational task to a project, workflow, and required roles. Every non-meta tool call requires the routing_token this returns. Returns 'ambiguous' status with alternatives if confidence is low \u2014 call again with hint_project to disambiguate.",
  inputSchema: {
    type: "object",
    required: ["task_text"],
    properties: {
      task_text: { type: "string", minLength: 1, maxLength: 4e3, description: "The operational task in natural language." },
      hint_project: { type: "string", description: "Optional: pre-narrow to a known project_name." }
    }
  },
  scope: "read",
  exempt_from_routing: true,
  rate_limit: "60/min/client",
  async handler(rawInput, ctx) {
    const input = rawInput;
    if (!input.task_text || input.task_text.length < 1) {
      throw new Error("task_text is required");
    }
    const projects = await loadProjects();
    const activeProjects = projects.filter((p) => p.account_tier !== "placeholder");
    if (input.hint_project) {
      const hinted = projects.find((p) => p.project_name === input.hint_project);
      if (!hinted) {
        return { error: "unknown_hint_project", available_projects: projects.map((p) => p.project_name) };
      }
      const wf = matchWorkflow(hinted.workflows, input.task_text);
      return await persistDecision(ctx, input, hinted.project_name, wf.name, wf.roles, "founder_override", 1, null);
    }
    const scored = activeProjects.map((p) => ({ p, ...scoreProject(p, input.task_text) })).sort((a, b) => b.score - a.score);
    const top = scored[0];
    const second = scored[1];
    if (!top || top.score === 0) {
      const llm = await classifyViaLlm(input.task_text, activeProjects);
      if (llm.project) {
        const proj = activeProjects.find((p) => p.project_name === llm.project);
        const wf = proj ? matchWorkflow(proj.workflows, input.task_text) : { name: null, roles: [] };
        return await persistDecision(ctx, input, llm.project, llm.workflow ?? wf.name, wf.roles, "llm", llm.confidence, null);
      }
      return await persistDecision(ctx, input, null, null, [], "ambiguous", 0.2, {
        candidates: scored.slice(0, 3).map((s) => ({ project: s.p.project_name, score: s.score })),
        llm_reasoning: llm.reasoning
      });
    }
    const clear = !second || top.score >= second.score * 2 || top.score >= 10;
    if (clear) {
      const wf = matchWorkflow(top.p.workflows, input.task_text);
      const confidence = Math.min(0.95, 0.6 + 0.05 * top.keyword_hits);
      return await persistDecision(ctx, input, top.p.project_name, wf.name, wf.roles, "keyword", confidence, null);
    }
    return await persistDecision(ctx, input, null, null, [], "ambiguous", 0.4, {
      candidates: scored.slice(0, 3).map((s) => ({
        project: s.p.project_name,
        score: s.score,
        matched: s.matched_keywords.slice(0, 5)
      }))
    });
  }
};
async function persistDecision(ctx, input, resolvedProject, workflow, roles, method, confidence, alternatives) {
  const token = "rt_" + randomUUID();
  const { error } = await db.from("mcp_routing_decisions").insert({
    routing_token: token,
    client_id: ctx.auth.client_id,
    task_text: input.task_text,
    resolved_project: resolvedProject,
    resolved_workflow: workflow,
    resolved_roles: roles,
    classifier_method: method,
    classifier_confidence: confidence,
    alternatives
  });
  if (error) throw error;
  return {
    routing_token: token,
    project: resolvedProject,
    workflow,
    roles,
    method,
    confidence,
    alternatives,
    expires_at_minutes: 240,
    instructions: method === "ambiguous" ? "Task is ambiguous. Call mcp_route_task again with hint_project=<name>, OR ask the user to clarify which product this is about." : `Pass routing_token=${token} in subsequent tool calls for this task. Token valid for 4 hours.`
  };
}

// tools/routing/list_projects.ts
var listProjectsTool = {
  name: "mcp_list_projects",
  description: "List all Pranix projects with their product_type, account_tier, and current state. Used by AI clients to disambiguate before routing.",
  inputSchema: {
    type: "object",
    properties: {
      include_placeholders: { type: "boolean", default: false }
    }
  },
  scope: "read",
  exempt_from_routing: true,
  async handler(rawInput, _ctx) {
    const input = rawInput ?? {};
    let q = db.from("project_registry").select("project_name, product_type, account_tier, domains, deployment_health, current_phase").order("account_tier", { ascending: true }).order("project_name", { ascending: true });
    if (!input.include_placeholders) {
      q = q.neq("account_tier", "placeholder").neq("account_tier", "incubation");
    }
    const { data, error } = await q;
    if (error) throw error;
    return { projects: data ?? [], count: (data ?? []).length };
  }
};

// tools/routing/list_roles.ts
var listRolesTool = {
  name: "mcp_list_roles",
  description: "List active roles in the role registry. AI clients use this to understand which roles can be selected for a task.",
  inputSchema: { type: "object", properties: {} },
  scope: "read",
  exempt_from_routing: true,
  async handler(_input, _ctx) {
    const { data, error } = await db.from("mcp_roles").select("role_name, display_name, description, allowed_tools, project_filter, required_scope, activation_keywords, is_temporary, expires_at").eq("active", true).order("role_name");
    if (error) throw error;
    return { roles: data ?? [], count: (data ?? []).length };
  }
};

// tools/routing/spawn_temporary_role.ts
var spawnTemporaryRoleTool = {
  name: "mcp_spawn_temporary_role",
  description: "Create a temporary role with a TTL. Use when an existing role doesn't fit the task. Founder-only (non-founder clients get 403). Max TTL 24h, enforced by DB CHECK.",
  inputSchema: {
    type: "object",
    required: ["role_name", "display_name", "allowed_tools", "ttl_minutes"],
    properties: {
      role_name: { type: "string", pattern: "^temp_[a-z0-9_]+$", description: "Must start with 'temp_'." },
      display_name: { type: "string" },
      description: { type: "string" },
      allowed_tools: { type: "array", items: { type: "string" } },
      project_filter: { type: "array", items: { type: "string" }, default: [] },
      required_scope: { type: "string", enum: ["read", "test", "write", "admin"], default: "read" },
      ttl_minutes: { type: "integer", minimum: 5, maximum: 1440 }
    }
  },
  scope: "admin",
  exempt_from_routing: true,
  async handler(rawInput, ctx) {
    if (!ctx.auth.is_founder) {
      return { error: "forbidden", reason: "spawn_temporary_role is founder-only" };
    }
    const input = rawInput;
    const expires_at = new Date(Date.now() + input.ttl_minutes * 60 * 1e3).toISOString();
    const { data, error } = await db.from("mcp_roles").insert({
      role_name: input.role_name,
      display_name: input.display_name,
      description: input.description ?? null,
      allowed_tools: input.allowed_tools,
      project_filter: input.project_filter ?? [],
      required_scope: input.required_scope ?? "read",
      activation_keywords: [],
      is_temporary: true,
      expires_at,
      created_by: ctx.auth.client_id
    }).select("id, role_name, expires_at").single();
    if (error) return { error: "insert_failed", detail: error.message };
    return { ok: true, role: data };
  }
};

// tools/intake/submit.ts
import Anthropic2 from "@anthropic-ai/sdk";
async function normalizeText(input) {
  if (!input.text) return { status: "failed", method: "text_passthrough", normalized_text: null, error: "missing_text" };
  return { status: "succeeded", method: "text_passthrough", normalized_text: input.text };
}
async function normalizeUrl(input) {
  if (!input.url) return { status: "failed", method: "url_fetch", normalized_text: null, error: "missing_url" };
  return {
    status: "succeeded",
    method: "url_fetch",
    normalized_text: `[url] ${input.url}${input.hint ? " \u2014 " + input.hint : ""}`
  };
}
async function normalizeGithubLink(input) {
  if (!input.url) return { status: "failed", method: "url_fetch", normalized_text: null, error: "missing_url" };
  const m = input.url.match(/github\.com\/([^/]+)\/([^/?#]+)/);
  const repo = m ? `${m[1]}/${m[2]}` : "(unparsed)";
  return {
    status: "succeeded",
    method: "url_fetch",
    normalized_text: `[github] repo=${repo} url=${input.url}${input.hint ? " \u2014 " + input.hint : ""}`
  };
}
async function normalizeScreenshot(input) {
  const apiKey = process.env.PMCP_ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      status: "degraded",
      method: "degraded",
      normalized_text: input.hint ? `[screenshot] ${input.hint}` : "[screenshot] (vision unavailable; no PMCP_ANTHROPIC_API_KEY)",
      degraded_reason: "missing_secret:PMCP_ANTHROPIC_API_KEY"
    };
  }
  if (!input.base64_data || !input.mime) {
    return { status: "failed", method: "vision_ocr", normalized_text: null, error: "missing_base64_data_or_mime" };
  }
  try {
    const anthropic = new Anthropic2({ apiKey });
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: input.mime, data: input.base64_data } },
          { type: "text", text: "Describe the operational issue or task shown in this screenshot. Focus on visible text, UI state, error messages, URLs. Output one paragraph, no preamble." }
        ]
      }]
    });
    const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    return { status: "succeeded", method: "vision_ocr", normalized_text: text };
  } catch (e) {
    return { status: "failed", method: "vision_ocr", normalized_text: null, error: e.message };
  }
}
async function normalizeVoiceNote(input) {
  const apiKey = process.env.PMCP_SARVAM_API_KEY;
  if (!apiKey) {
    return {
      status: "degraded",
      method: "degraded",
      normalized_text: input.hint ?? "[voice_note] (STT unavailable; paste PMCP_SARVAM_API_KEY to enable)",
      degraded_reason: "missing_secret:PMCP_SARVAM_API_KEY"
    };
  }
  return { status: "degraded", method: "degraded", normalized_text: "[voice_note] (STT wiring deferred to Phase 3)", degraded_reason: "stt_not_yet_implemented" };
}
async function normalizeLog(input) {
  if (!input.text) return { status: "failed", method: "log_extract", normalized_text: null, error: "missing_text" };
  const lines = input.text.split("\n").map((l) => l.trim()).filter(Boolean);
  const dedup = [...new Set(lines)].join("\n").slice(0, 2e3);
  return { status: "succeeded", method: "log_extract", normalized_text: `[log] ${dedup}` };
}
async function normalizeApk(input) {
  return {
    status: "degraded",
    method: "degraded",
    normalized_text: input.hint ?? "[apk] (static analysis wiring deferred to Phase 3)",
    degraded_reason: "apk_parser_not_yet_implemented"
  };
}
async function normalizeOther(input, kind) {
  return {
    status: "degraded",
    method: "degraded",
    normalized_text: `[${kind}] ${input.hint ?? input.text ?? input.url ?? "(no text)"}`,
    degraded_reason: `kind_${kind}_handler_deferred`
  };
}
async function normalize(input) {
  switch (input.intake_kind) {
    case "text":
      return normalizeText(input);
    case "url":
      return normalizeUrl(input);
    case "product_link":
      return normalizeUrl(input);
    case "github_link":
      return normalizeGithubLink(input);
    case "play_store_link":
      return normalizeUrl(input);
    case "screenshot":
      return normalizeScreenshot(input);
    case "voice_note":
      return normalizeVoiceNote(input);
    case "log":
      return normalizeLog(input);
    case "apk":
      return normalizeApk(input);
    case "screen_recording":
      return normalizeOther(input, "screen_recording");
    case "document":
      return normalizeOther(input, "document");
    case "file_other":
      return normalizeOther(input, "file_other");
  }
}
var intakeSubmitTool = {
  name: "mcp_intake_submit",
  description: "Multi-Input Intake. Submit text, URL, screenshot, voice note, APK, log, etc. The intake layer normalizes to text and auto-calls route_task. Returns: { intake_id, normalization, routing }. routing.routing_token can be used for subsequent tool calls.",
  inputSchema: {
    type: "object",
    required: ["intake_kind"],
    properties: {
      intake_kind: {
        type: "string",
        enum: ["text", "url", "screenshot", "screen_recording", "voice_note", "apk", "log", "document", "product_link", "github_link", "play_store_link", "file_other"]
      },
      text: { type: "string", description: "For intake_kind=text/log" },
      url: { type: "string", format: "uri", description: "For intake_kind=url/product_link/github_link/play_store_link" },
      base64_data: { type: "string", description: "For screenshot/voice_note/apk/document" },
      mime: { type: "string", description: "Required when base64_data is present" },
      storage_path: { type: "string", description: "Optional: pre-uploaded file path" },
      hint: { type: "string", description: "Optional founder hint to attach to the routable text" }
    }
  },
  scope: "read",
  exempt_from_routing: true,
  rate_limit: "30/min/client",
  async handler(rawInput, ctx) {
    const input = rawInput;
    const { data: intakeRow, error: insertErr } = await db.from("mcp_intakes").insert({
      client_id: ctx.auth.client_id,
      intake_kind: input.intake_kind,
      raw_payload: {
        ...input.text !== void 0 ? { text: input.text } : {},
        ...input.url !== void 0 ? { url: input.url } : {},
        ...input.storage_path !== void 0 ? { storage_path: input.storage_path } : {},
        ...input.mime !== void 0 ? { mime: input.mime } : {},
        ...input.hint !== void 0 ? { hint: input.hint } : {},
        // base64 NOT stored to keep audit small
        ...input.base64_data !== void 0 ? { has_base64: true, bytes: input.base64_data.length } : {}
      },
      normalization_status: "running"
    }).select("id").single();
    if (insertErr || !intakeRow) throw insertErr ?? new Error("intake_insert_failed");
    const norm = await normalize(input);
    await db.from("mcp_intakes").update({
      normalized_text: norm.normalized_text,
      normalization_method: norm.method,
      normalization_status: norm.status,
      normalization_error: norm.error ?? null,
      normalized_at: (/* @__PURE__ */ new Date()).toISOString()
    }).eq("id", intakeRow.id);
    let routing = null;
    if (norm.normalized_text && norm.status !== "failed") {
      try {
        routing = await routeTaskTool.handler(
          { task_text: norm.normalized_text },
          ctx
        );
        const routingObj = routing;
        if (routingObj.routing_token) {
          const { data: rd } = await db.from("mcp_routing_decisions").select("id").eq("routing_token", routingObj.routing_token).single();
          if (rd) {
            await db.from("mcp_intakes").update({
              routing_decision_id: rd.id,
              routed_at: (/* @__PURE__ */ new Date()).toISOString()
            }).eq("id", intakeRow.id);
          }
        }
      } catch (e) {
        routing = { error: "auto_route_failed", detail: e.message };
      }
    }
    return {
      intake_id: intakeRow.id,
      normalization: {
        status: norm.status,
        method: norm.method,
        normalized_text: norm.normalized_text,
        degraded_reason: norm.degraded_reason,
        error: norm.error
      },
      routing,
      instructions: norm.status === "succeeded" ? "Use routing.routing_token in subsequent tool calls." : norm.status === "degraded" ? `Intake processed in degraded mode (${norm.degraded_reason}). Routing still attempted on best-effort normalized text.` : "Intake failed. Resubmit with corrected input."
    };
  }
};

// tools/intake/status.ts
var intakeStatusTool = {
  name: "mcp_intake_status",
  description: "Read the status of a previously submitted intake.",
  inputSchema: {
    type: "object",
    required: ["intake_id"],
    properties: { intake_id: { type: "string", format: "uuid" } }
  },
  scope: "read",
  exempt_from_routing: true,
  async handler(rawInput, ctx) {
    const { intake_id } = rawInput;
    const { data, error } = await db.from("mcp_intakes").select("id, intake_kind, normalization_status, normalization_method, normalized_text, normalization_error, routing_decision_id, created_at, normalized_at, routed_at").eq("id", intake_id).eq("client_id", ctx.auth.is_founder ? ctx.auth.client_id : ctx.auth.client_id).single();
    if (error || !data) return { error: "not_found" };
    return data;
  }
};

// tools/access/request_grant.ts
var requestGrantTool = {
  name: "mcp_access_request_grant",
  description: "Request an ephemeral test/write/admin grant. Founder receives a pending request and must approve via mcp_access_approve_grant. Max TTL 24h (DB-enforced).",
  inputSchema: {
    type: "object",
    required: ["scope", "resource_pattern", "requested_task", "ttl_minutes"],
    properties: {
      scope: { type: "string", enum: ["test", "write", "admin"] },
      resource_pattern: { type: "string" },
      requested_task: { type: "string", maxLength: 1e3 },
      ttl_minutes: { type: "integer", minimum: 5, maximum: 1440 }
    }
  },
  scope: "read",
  exempt_from_routing: true,
  async handler(rawInput, ctx) {
    const input = rawInput;
    const expires_at = new Date(Date.now() + input.ttl_minutes * 60 * 1e3).toISOString();
    const granted_at = (/* @__PURE__ */ new Date()).toISOString();
    const { data, error } = await db.from("mcp_access_grants").insert({
      client_id: ctx.auth.client_id,
      scope: input.scope,
      resource_pattern: input.resource_pattern,
      reason: null,
      requested_task: input.requested_task,
      granted_at,
      expires_at,
      revoked_at: granted_at
      // pending = revoked-at-creation; approve unsets this
    }).select("id, scope, resource_pattern, expires_at").single();
    if (error) return { error: "insert_failed", detail: error.message };
    await db.from("founder_alerts").insert({
      level: "warn",
      source: "mcp_v1:access_request",
      title: `Access request: ${ctx.auth.client_name} \u2192 ${input.scope} on ${input.resource_pattern}`,
      body: `Reason: ${input.requested_task}
TTL: ${input.ttl_minutes} min
Grant ID: ${data.id}
Approve via mcp_access_approve_grant.`,
      context: { grant_id: data.id, client_id: ctx.auth.client_id, scope: input.scope }
    });
    return {
      grant_id: data.id,
      status: "pending_approval",
      expires_at_if_approved: data.expires_at,
      instructions: "Founder must call mcp_access_approve_grant with grant_id to activate."
    };
  }
};

// tools/access/approve_grant.ts
var approveGrantTool = {
  name: "mcp_access_approve_grant",
  description: "Founder-only. Approve a pending grant created by mcp_access_request_grant.",
  inputSchema: {
    type: "object",
    required: ["grant_id"],
    properties: {
      grant_id: { type: "string", format: "uuid" },
      reason: { type: "string" },
      override_ttl_minutes: { type: "integer", minimum: 5, maximum: 1440 }
    }
  },
  scope: "admin",
  exempt_from_routing: true,
  async handler(rawInput, ctx) {
    if (!ctx.auth.is_founder) return { error: "forbidden", reason: "approve_grant is founder-only" };
    const input = rawInput;
    const { data: existing, error: readErr } = await db.from("mcp_access_grants").select("id, scope, resource_pattern, granted_at, expires_at, revoked_at, client_id").eq("id", input.grant_id).single();
    if (readErr || !existing) return { error: "not_found" };
    if (existing.revoked_at === null) return { error: "already_active_or_already_approved" };
    const newExpiry = input.override_ttl_minutes ? new Date(Date.now() + input.override_ttl_minutes * 60 * 1e3).toISOString() : existing.expires_at;
    const { data, error } = await db.from("mcp_access_grants").update({
      granted_by: ctx.auth.client_id,
      granted_at: (/* @__PURE__ */ new Date()).toISOString(),
      expires_at: newExpiry,
      revoked_at: null,
      reason: input.reason ?? null
    }).eq("id", input.grant_id).select("id, scope, resource_pattern, expires_at").single();
    if (error) return { error: "update_failed", detail: error.message };
    return { ok: true, grant: data };
  }
};

// tools/github/read_repo_tree.ts
import { Octokit } from "@octokit/rest";
var _octokit = null;
function octokit() {
  if (_octokit) return _octokit;
  const auth = process.env.PMCP_GITHUB_PAT;
  if (!auth) throw new Error("PMCP_GITHUB_PAT not set");
  _octokit = new Octokit({ auth });
  return _octokit;
}
var githubReadRepoTreeTool = {
  name: "github_read_repo_tree",
  description: "List files and directories in a Pranix-owned GitHub repo. Requires routing_token. Read-only.",
  inputSchema: {
    type: "object",
    required: ["repo"],
    properties: {
      repo: { type: "string", pattern: "^[\\w.-]+/[\\w.-]+$" },
      ref: { type: "string", default: "HEAD" },
      path: { type: "string", default: "" },
      max_depth: { type: "integer", minimum: 1, maximum: 10, default: 3 }
    }
  },
  scope: "read",
  rate_limit: "60/min/client",
  async handler(rawInput, _ctx) {
    const input = rawInput;
    const [owner, repo] = input.repo.split("/");
    if (!owner || !repo) throw new Error("repo must be owner/name");
    const gh = octokit();
    const refData = await gh.rest.repos.getCommit({ owner, repo, ref: input.ref ?? "HEAD" });
    const treeSha = refData.data.commit.tree.sha;
    const tree = await gh.rest.git.getTree({ owner, repo, tree_sha: treeSha, recursive: "1" });
    const prefix = input.path && input.path.length > 0 ? input.path.replace(/\/$/, "") + "/" : "";
    const maxDepth = input.max_depth ?? 3;
    const files = [];
    for (const entry of tree.data.tree ?? []) {
      const p = entry.path ?? "";
      if (prefix && !p.startsWith(prefix)) continue;
      const relativeFromPrefix = prefix ? p.slice(prefix.length) : p;
      const depth = relativeFromPrefix === "" ? 0 : relativeFromPrefix.split("/").length;
      if (depth > maxDepth) continue;
      files.push({ path: p, type: entry.type ?? "?", size: entry.size });
    }
    return {
      repo: input.repo,
      ref: input.ref ?? "HEAD",
      tree_sha: treeSha,
      path_prefix: prefix || "(root)",
      max_depth: maxDepth,
      file_count: files.length,
      files,
      truncated: tree.data.truncated ?? false
    };
  }
};

// tools/supabase/list_tables.ts
import { createClient as createClient2 } from "@supabase/supabase-js";
var PROJECT_KEY_ENV = {
  "mvdjyjccvioxircxuzgz": "PMCP_CONTROL_PLANE_SERVICE_KEY",
  "augeusvhqcqemfeqximk": "SUPABASE_CART2SAVE_SERVICE_ROLE_KEY",
  "rqdnxdvuypekpmxbteju": "SUPABASE_SCHOOLOS_SERVICE_ROLE_KEY",
  "yqfwvnrnpydcrzomzdvr": "SUPABASE_QUICKSCANZ_SERVICE_ROLE_KEY",
  "yfhfzmlrqvyfrdkcbkiy": "SUPABASE_VIDYAGRID_SERVICE_ROLE_KEY",
  "ofnhwpzzxthdvvunxsfs": "SUPABASE_QUIETKEEP_SERVICE_ROLE_KEY"
};
function clientFor(projectId) {
  const envName = PROJECT_KEY_ENV[projectId];
  if (!envName) throw new Error(`unknown_project:${projectId}`);
  const key = process.env[envName];
  if (!key) throw new Error(`missing_secret:${envName}`);
  return createClient2(`https://${projectId}.supabase.co`, key, { auth: { persistSession: false } });
}
var supabaseListTablesTool = {
  name: "supabase_list_tables",
  description: "List tables in a Pranix-owned Supabase project. Read-only.",
  inputSchema: {
    type: "object",
    required: ["project_id"],
    properties: {
      project_id: { type: "string", enum: Object.keys(PROJECT_KEY_ENV) },
      schema: { type: "string", default: "public" }
    }
  },
  scope: "read",
  async handler(rawInput, _ctx) {
    const { project_id, schema = "public" } = rawInput;
    const sb = clientFor(project_id);
    const { data, error } = await sb.rpc("exec_sql", {
      query: `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema='${schema}' ORDER BY table_name`
    }).single();
    if (error) {
      const resp = await fetch(`https://${project_id}.supabase.co/rest/v1/?apikey=${process.env[PROJECT_KEY_ENV[project_id]]}`);
      return { project_id, schema, note: "REST introspection used; for full schema use supabase_inspect_schema", endpoint_ok: resp.ok };
    }
    return { project_id, schema, tables: data };
  }
};

// tools/supabase/inspect_schema.ts
var PROJECT_KEY_ENV2 = {
  "mvdjyjccvioxircxuzgz": "PMCP_CONTROL_PLANE_SERVICE_KEY",
  "augeusvhqcqemfeqximk": "SUPABASE_CART2SAVE_SERVICE_ROLE_KEY",
  "rqdnxdvuypekpmxbteju": "SUPABASE_SCHOOLOS_SERVICE_ROLE_KEY",
  "yqfwvnrnpydcrzomzdvr": "SUPABASE_QUICKSCANZ_SERVICE_ROLE_KEY",
  "yfhfzmlrqvyfrdkcbkiy": "SUPABASE_VIDYAGRID_SERVICE_ROLE_KEY",
  "ofnhwpzzxthdvvunxsfs": "SUPABASE_QUIETKEEP_SERVICE_ROLE_KEY"
};
var supabaseInspectSchemaTool = {
  name: "supabase_inspect_schema",
  description: "Inspect columns + constraints for a table in a Pranix Supabase project.",
  inputSchema: {
    type: "object",
    required: ["project_id", "table"],
    properties: {
      project_id: { type: "string", enum: Object.keys(PROJECT_KEY_ENV2) },
      table: { type: "string", pattern: "^[a-zA-Z0-9_]+$" },
      schema: { type: "string", default: "public" }
    }
  },
  scope: "read",
  async handler(rawInput, _ctx) {
    const { project_id, table, schema = "public" } = rawInput;
    const envName = PROJECT_KEY_ENV2[project_id];
    if (!envName) return { error: "unknown_project", project_id };
    const key = process.env[envName];
    if (!key) return { error: "missing_secret", env_var: envName, note: "Phase F Section 3 founder action required" };
    const cols = await fetch(
      `https://${project_id}.supabase.co/rest/v1/?select=*`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    return {
      project_id,
      schema,
      table,
      api_reachable: cols.ok,
      note: "Phase 3 V1: REST introspection. Use the gateway's planned safe_read_query for richer column metadata against information_schema."
    };
  }
};

// tools/supabase/safe_read_query.ts
var PROJECT_KEY_ENV3 = {
  "mvdjyjccvioxircxuzgz": "PMCP_CONTROL_PLANE_SERVICE_KEY",
  "augeusvhqcqemfeqximk": "SUPABASE_CART2SAVE_SERVICE_ROLE_KEY",
  "rqdnxdvuypekpmxbteju": "SUPABASE_SCHOOLOS_SERVICE_ROLE_KEY",
  "yqfwvnrnpydcrzomzdvr": "SUPABASE_QUICKSCANZ_SERVICE_ROLE_KEY",
  "yfhfzmlrqvyfrdkcbkiy": "SUPABASE_VIDYAGRID_SERVICE_ROLE_KEY",
  "ofnhwpzzxthdvvunxsfs": "SUPABASE_QUIETKEEP_SERVICE_ROLE_KEY"
};
function isSelectOnly(sql) {
  const stripped = sql.trim().replace(/\s+/g, " ");
  if (!/^SELECT\b/i.test(stripped)) return false;
  if (stripped.includes(";")) return false;
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|VACUUM|REINDEX)\b/i.test(stripped)) return false;
  return true;
}
var supabaseSafeReadQueryTool = {
  name: "supabase_safe_read_query",
  description: "Execute a SELECT-only SQL query against a Pranix-owned Supabase project. Rejects any modifying statement. 10s timeout, 1000-row cap.",
  inputSchema: {
    type: "object",
    required: ["project_id", "query"],
    properties: {
      project_id: { type: "string", enum: Object.keys(PROJECT_KEY_ENV3) },
      query: { type: "string", maxLength: 4e3 }
    }
  },
  scope: "read",
  rate_limit: "30/min/client",
  async handler(rawInput, _ctx) {
    const { project_id, query } = rawInput;
    if (!isSelectOnly(query)) return { error: "non_select_rejected", note: "Only single-statement SELECT queries allowed." };
    const envName = PROJECT_KEY_ENV3[project_id];
    if (!envName) return { error: "unknown_project" };
    const key = process.env[envName];
    if (!key) return { error: "missing_secret", env_var: envName };
    const resp = await fetch(`https://${project_id}.supabase.co/rest/v1/rpc/safe_select`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_query: query })
    });
    if (resp.status === 404) {
      return {
        error: "safe_select_rpc_missing",
        project_id,
        remediation_sql: `
CREATE OR REPLACE FUNCTION public.safe_select(p_query TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE result JSONB;
BEGIN
  EXECUTE format('SELECT jsonb_agg(t) FROM (%s LIMIT 1000) t', p_query) INTO result;
  RETURN COALESCE(result, '[]'::jsonb);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', SQLERRM);
END $$;
GRANT EXECUTE ON FUNCTION public.safe_select(TEXT) TO service_role;`,
        note: "Run the remediation_sql against this project's SQL editor to enable safe queries."
      };
    }
    if (!resp.ok) return { error: "query_failed", status: resp.status, body: await resp.text() };
    const rows = await resp.json();
    return { project_id, query, row_count: Array.isArray(rows) ? rows.length : 0, rows };
  }
};

// tools/vercel/get_deployment.ts
var TEAM_ID = "team_9BU3hGKRvYLIACE0GCWDMsV0";
async function vercelFetch(path) {
  const token = process.env.PMCP_VERCEL_TOKEN;
  if (!token) throw new Error("missing_secret:PMCP_VERCEL_TOKEN");
  const url = path.includes("?") ? `${path}&teamId=${TEAM_ID}` : `${path}?teamId=${TEAM_ID}`;
  const resp = await fetch(`https://api.vercel.com${url}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`vercel_api_${resp.status}:${await resp.text()}`);
  return resp.json();
}
var vercelGetDeploymentTool = {
  name: "vercel_get_deployment",
  description: "Get a Vercel deployment by id or URL. Pranix team scoped.",
  inputSchema: {
    type: "object",
    required: ["id_or_url"],
    properties: { id_or_url: { type: "string" } }
  },
  scope: "read",
  async handler(rawInput, _ctx) {
    const { id_or_url } = rawInput;
    return await vercelFetch(`/v13/deployments/${encodeURIComponent(id_or_url)}`);
  }
};

// tools/vercel/read_logs.ts
var TEAM_ID2 = "team_9BU3hGKRvYLIACE0GCWDMsV0";
async function vercelFetch2(path) {
  const token = process.env.PMCP_VERCEL_TOKEN;
  if (!token) throw new Error("missing_secret:PMCP_VERCEL_TOKEN");
  const sep = path.includes("?") ? "&" : "?";
  const resp = await fetch(`https://api.vercel.com${path}${sep}teamId=${TEAM_ID2}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error(`vercel_api_${resp.status}:${await resp.text()}`);
  return resp.json();
}
var vercelReadBuildLogsTool = {
  name: "vercel_read_build_logs",
  description: "Read build logs for a Vercel deployment.",
  inputSchema: {
    type: "object",
    required: ["deployment_id"],
    properties: { deployment_id: { type: "string" } }
  },
  scope: "read",
  async handler(rawInput, _ctx) {
    const { deployment_id } = rawInput;
    return await vercelFetch2(`/v3/deployments/${deployment_id}/events`);
  }
};
var vercelReadRuntimeLogsTool = {
  name: "vercel_read_runtime_logs",
  description: "Read runtime logs for a Vercel project (recent traffic).",
  inputSchema: {
    type: "object",
    required: ["project_id"],
    properties: {
      project_id: { type: "string" },
      since: { type: "string", default: "1h" },
      limit: { type: "integer", default: 50, minimum: 1, maximum: 200 }
    }
  },
  scope: "read",
  async handler(rawInput, _ctx) {
    const { project_id, since = "1h", limit = 50 } = rawInput;
    return await vercelFetch2(`/v1/projects/${project_id}/logs?since=${since}&limit=${limit}`);
  }
};

// tools/doppler/inspect.ts
async function dopplerFetch(path) {
  const token = process.env.PMCP_DOPPLER_TOKEN;
  if (!token) throw new Error("missing_secret:PMCP_DOPPLER_TOKEN");
  const resp = await fetch(`https://api.doppler.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, accept: "application/json" }
  });
  if (!resp.ok) throw new Error(`doppler_api_${resp.status}`);
  return resp.json();
}
var dopplerListProjectsTool = {
  name: "doppler_list_projects",
  description: "List Doppler projects accessible by the gateway's token.",
  inputSchema: { type: "object", properties: {} },
  scope: "read",
  async handler(_input, _ctx) {
    return await dopplerFetch("/v3/projects");
  }
};
var dopplerListConfigNamesTool = {
  name: "doppler_list_config_names",
  description: "List secret NAMES (not values) in a Doppler project + config.",
  inputSchema: {
    type: "object",
    required: ["project", "config"],
    properties: { project: { type: "string" }, config: { type: "string" } }
  },
  scope: "read",
  async handler(rawInput, _ctx) {
    const { project, config } = rawInput;
    const data = await dopplerFetch(`/v3/configs/config/secrets/names?project=${encodeURIComponent(project)}&config=${encodeURIComponent(config)}`);
    return { project, config, names: data.names ?? [] };
  }
};
var dopplerDetectDriftTool = {
  name: "doppler_detect_drift",
  description: "Compare two Doppler configs (e.g. dev vs prod) \u2014 returns missing/extra secret names.",
  inputSchema: {
    type: "object",
    required: ["project", "config_a", "config_b"],
    properties: {
      project: { type: "string" },
      config_a: { type: "string" },
      config_b: { type: "string" }
    }
  },
  scope: "read",
  async handler(rawInput, _ctx) {
    const { project, config_a, config_b } = rawInput;
    const [a, b] = await Promise.all([
      dopplerFetch(`/v3/configs/config/secrets/names?project=${project}&config=${config_a}`),
      dopplerFetch(`/v3/configs/config/secrets/names?project=${project}&config=${config_b}`)
    ]);
    const namesA = new Set(a.names);
    const namesB = new Set(b.names);
    return {
      project,
      only_in_a: [...namesA].filter((n) => !namesB.has(n)),
      only_in_b: [...namesB].filter((n) => !namesA.has(n)),
      common_count: [...namesA].filter((n) => namesB.has(n)).length
    };
  }
};

// lib/tool-registry.ts
var ALL_TOOLS = [
  routeTaskTool,
  listProjectsTool,
  listRolesTool,
  spawnTemporaryRoleTool,
  intakeSubmitTool,
  intakeStatusTool,
  requestGrantTool,
  approveGrantTool,
  githubReadRepoTreeTool,
  supabaseListTablesTool,
  supabaseInspectSchemaTool,
  supabaseSafeReadQueryTool,
  vercelGetDeploymentTool,
  vercelReadBuildLogsTool,
  vercelReadRuntimeLogsTool,
  dopplerListProjectsTool,
  dopplerListConfigNamesTool,
  dopplerDetectDriftTool
];
function listTools() {
  return ALL_TOOLS;
}
function getTool(name) {
  return ALL_TOOLS.find((t) => t.name === name) ?? null;
}

// api/mcp/[...path].ts
function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function rpcResult(id, result) {
  return jsonResp({ jsonrpc: "2.0", id, result });
}
function rpcError(id, code, message, data) {
  return jsonResp({ jsonrpc: "2.0", id, error: { code, message, data } }, 200);
}
function inferResource(toolName, params) {
  if (toolName.startsWith("github_") && typeof params.repo === "string") return `github:repo:${params.repo}`;
  if (toolName.startsWith("supabase_") && typeof params.project_id === "string") return `supabase:project:${params.project_id}`;
  if (toolName.startsWith("vercel_") && typeof params.project_id === "string") return `vercel:project:${params.project_id}`;
  if (toolName.startsWith("doppler_") && typeof params.project === "string") return `doppler:project:${params.project}:config-names`;
  if (toolName.startsWith("browser_") && typeof params.url === "string") {
    try {
      return `browser:domain:${new URL(params.url).hostname}`;
    } catch {
      return `browser:domain:invalid`;
    }
  }
  return `tool:${toolName}`;
}
async function handler(req) {
  const request_id = randomUUID2();
  const startedAt = Date.now();
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/health")) {
    return jsonResp({ ok: true, gateway: "pranix-mcp-gateway", version: "1.0.0", request_id });
  }
  if (req.method !== "POST") return jsonResp({ error: "method_not_allowed" }, 405);
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const auth = await resolveClient(bearer);
  if (!auth) {
    await writeAudit({ auth: null, tool_name: "(auth)", scope_used: "(none)", status_code: 401, latency_ms: Date.now() - startedAt, error_kind: "auth_fail", request_id });
    return jsonResp({ error: "unauthorized" }, 401);
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32700, "parse_error");
  }
  const { id = null, method, params = {} } = body;
  if (method === "list_tools") {
    const tools = listTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema
    }));
    await writeAudit({ auth, tool_name: "list_tools", scope_used: "read", status_code: 200, latency_ms: Date.now() - startedAt, request_id });
    return rpcResult(id, { tools });
  }
  if (method === "call_tool") {
    const toolName = params.name;
    const args = params.arguments ?? {};
    if (!toolName) return rpcError(id, -32602, "invalid_params: missing 'name'");
    const tool = getTool(toolName);
    if (!tool) return rpcError(id, -32601, `tool_not_found: ${toolName}`);
    const resource = inferResource(toolName, args);
    const authz = await authorize(auth, tool.scope, resource);
    if (!authz.ok) {
      await writeAudit({ auth, tool_name: toolName, scope_used: tool.scope, resource, status_code: 403, latency_ms: Date.now() - startedAt, error_kind: "authz_fail", request_id });
      return rpcError(id, -32e3, `authz_denied: ${authz.reason}`);
    }
    const exempt = tool.exempt_from_routing ?? await isRoutingExempt(toolName);
    let routing = null;
    if (!exempt) {
      const routingToken = args["routing_token"] ?? args["_routing_token"] ?? req.headers.get("x-pmcp-routing-token");
      if (!routingToken) {
        await writeAudit({ auth, tool_name: toolName, scope_used: tool.scope, resource, status_code: 428, latency_ms: Date.now() - startedAt, error_kind: "routing_token_missing", request_id });
        return rpcError(id, -32001, "routing_token_required: call mcp_route_task or mcp_intake_submit first, then pass routing_token");
      }
      routing = await resolveRouting(routingToken);
      if (!routing) {
        await writeAudit({ auth, tool_name: toolName, scope_used: tool.scope, resource, status_code: 428, latency_ms: Date.now() - startedAt, error_kind: "routing_token_invalid_or_expired", request_id });
        return rpcError(id, -32001, "routing_token_invalid_or_expired");
      }
    }
    try {
      const output = await tool.handler(args, { auth, routing, request_id });
      const outBytes = JSON.stringify(output).length;
      await writeAudit({ auth, tool_name: toolName, scope_used: tool.scope, resource, status_code: 200, latency_ms: Date.now() - startedAt, output_size: outBytes, request_id });
      return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(output) }] });
    } catch (e) {
      const msg = e.message;
      await writeAudit({ auth, tool_name: toolName, scope_used: tool.scope, resource, status_code: 500, latency_ms: Date.now() - startedAt, error_kind: "tool_error", request_id });
      return rpcError(id, -32603, `tool_error: ${msg}`);
    }
  }
  return rpcError(id, -32601, `method_not_found: ${method}`);
}
export {
  handler as default
};
