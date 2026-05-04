// lib/audit/agents/schema.js — audit_schema_drift handler.
// Phase D-multi-account: per-product service-role key resolved from project_registry.

import { httpRequest } from "../../clients/http.js";
import { runAudit } from "../runner.js";
import { getProject, resolveSupabaseKey } from "../../registry.js";
import { deferred, apiFailure, healthy } from "../findings.js";

function supabaseHeaders(serviceKey) {
  return {
    "apikey":        serviceKey,
    "authorization": `Bearer ${serviceKey}`,
    "user-agent":    "pranix-agent-engine/audit",
  };
}

const PRODUCT_KEY_TABLES = {
  cart2save:  ["products", "deals", "users"],
  quickscanz: ["scans", "warranties", "products"],
  quietkeep:  ["keeps", "users", "voice_samples"],
  vidyagrid:  ["questions", "diagnostics", "sessions"],
  schoolos:   ["students", "schools", "attendance"],
  pranix_agents: ["tasks", "worker_runs", "audit_runs"],
};

export async function auditSchemaDrift(task) {
  const product_name = task.input?.product_name;
  if (!product_name) return { ok: false, retryable: false, error: "input.product_name required" };

  return runAudit(task, { agent: "schema", product: product_name, scope: { product_name } }, async (ctx) => {
    const proj = await getProject(product_name);
    if (proj.error) {
      ctx.find({ severity: "critical", category: "schema", resource: product_name, title: proj.error });
      return { reason: proj.error };
    }
    const sbId = proj.project.supabase_project_id;
    if (!sbId) {
      ctx.find(deferred("schema", product_name, "no supabase_project_id in project_registry", "this product may not use Supabase"));
      return { reason: "no supabase_project_id" };
    }

    const keyRes = resolveSupabaseKey(proj.project);
    if (keyRes.error) {
      ctx.find(deferred("schema", product_name, keyRes.error, `set ${keyRes.env_name || 'supabase_key_env'} in worker env`));
      return { reason: keyRes.error };
    }
    const serviceKey = keyRes.token;
    const baseUrl = `https://${sbId}.supabase.co`;

    // 1. Liveness
    const r0 = await httpRequest(`${baseUrl}/rest/v1/?select=*`, {
      headers: supabaseHeaders(serviceKey), timeoutMs: 8000,
    });
    if (!r0.ok && (r0.status === 503 || r0.status === 0)) {
      ctx.find({
        severity: "error", category: "schema", resource: sbId,
        title: `${product_name}: Supabase project unreachable (${r0.status})`,
        body: `Likely paused/inactive. Cannot audit schema until restored.`,
        evidence: { supabase_id: sbId, status: r0.status, key_env: keyRes.env_name },
      });
      return { reason: "supabase unreachable" };
    }
    if (ctx.deadlineReached()) return null;

    // 2. Probe key tables
    const targets = PRODUCT_KEY_TABLES[product_name] || [];
    let reachableCount = 0;
    for (const t of targets) {
      if (ctx.deadlineReached()) break;
      const r = await httpRequest(`${baseUrl}/rest/v1/${encodeURIComponent(t)}?select=*&limit=0`, {
        headers: { ...supabaseHeaders(serviceKey), "prefer": "count=exact" },
        timeoutMs: 6000,
      });
      if (r.ok) {
        reachableCount++;
      } else if (r.status === 404 || r.status === 406) {
        ctx.find({
          severity: "warn", category: "schema", resource: `${sbId}:${t}`,
          title: `${product_name}: expected table '${t}' not reachable via REST (${r.status})`,
          body:  "Table missing OR not exposed to PostgREST OR RLS denied.",
          evidence: { supabase_id: sbId, table: t, status: r.status },
        });
      } else if (r.status === 401 || r.status === 403) {
        ctx.find({
          severity: "error", category: "schema", resource: sbId,
          title: `${product_name}: Supabase auth rejected service-role key`,
          body:  `${r.status} on '${t}'. Service role key in ${keyRes.env_name} may be wrong/rotated.`,
          evidence: { status: r.status, table: t, key_env: keyRes.env_name },
        });
        return { reason: "auth rejected" };
      } else {
        ctx.find(apiFailure("schema", `${sbId}:${t}`, `GET ${t} status=${r.status}`, { status: r.status }));
      }
    }

    if (reachableCount > 0 && reachableCount === targets.length) {
      ctx.find(healthy("schema", sbId, `All ${targets.length} key tables reachable.`));
    }

    return { supabase_project_id: sbId, key_env: keyRes.env_name, tables_checked: targets.length, tables_reachable: reachableCount };
  });
}
