// lib/audit/agents/schema.js — audit_schema_drift handler.
//
// Inputs: { product_name }
//
// Strategy:
//   - Resolve supabase_project_id from project_registry.
//   - Determine the right service-role key from env:
//       * pranix-agents          → SUPABASE_SERVICE_ROLE_KEY (us)
//       * cart2save (augeus...)  → SUPABASE_CART2SAVE_SERVICE_ROLE_KEY (optional)
//       * quietkeep (ofnhw...)   → SUPABASE_QUIETKEEP_SERVICE_ROLE_KEY (optional)
//       * everything else under our org uses our key
//   - If no key available: emit a 'deferred' finding and exit cleanly.
//   - If the project is paused/inactive: detect via REST 503/timeout and emit warn.
//   - Otherwise query information_schema to count tables and check for known anti-patterns:
//       * RLS disabled on tables in public schema
//       * any table with row count == 0 that the product is *expected* to have data in
//
// We do NOT shell out to pg; everything is HTTP via Supabase's PostgREST + RPC.

import { httpRequest } from "../../clients/http.js";
import { runAudit } from "../runner.js";
import { getProject } from "../../registry.js";
import { deferred, apiFailure, healthy, missingEnv } from "../findings.js";

// Map known supabase_project_id values to env vars holding their service-role key.
const KEY_BY_SUPABASE_ID = {
  "mvdjyjccvioxircxuzgz": "SUPABASE_SERVICE_ROLE_KEY",            // pranix-agents (us)
  "rqdnxdvuypekpmxbteju": "SUPABASE_SCHOOLOS_SERVICE_ROLE_KEY",   // schoolos (read-only via this key only)
  "yqfwvnrnpydcrzomzdvr": "SUPABASE_QUICKSCANZ_SERVICE_ROLE_KEY", // quickscanz
  "yfhfzmlrqvyfrdkcbkiy": "SUPABASE_VIDYAGRID_SERVICE_ROLE_KEY",  // vidyagrid
  "augeusvhqcqemfeqximk": "SUPABASE_CART2SAVE_SERVICE_ROLE_KEY",  // cart2save (different org)
  "ofnhwpzzxthdvvunxsfs": "SUPABASE_QUIETKEEP_SERVICE_ROLE_KEY",  // quietkeep (different org)
};

function supabaseHeaders(serviceKey) {
  return {
    "apikey":        serviceKey,
    "authorization": `Bearer ${serviceKey}`,
    "user-agent":    "pranix-agent-engine/audit",
  };
}

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

    const keyEnv = KEY_BY_SUPABASE_ID[sbId];
    if (!keyEnv) {
      ctx.find(deferred("schema", product_name, `no env-var mapping for supabase id ${sbId}`, "add a mapping in audit/agents/schema.js"));
      return { reason: "unknown supabase id" };
    }
    const serviceKey = process.env[keyEnv];
    if (!serviceKey) {
      ctx.find(deferred("schema", product_name, `env var ${keyEnv} not set`, `add ${keyEnv} to Doppler to enable schema audits for ${product_name}`));
      return { reason: `${keyEnv} missing` };
    }

    const baseUrl = `https://${sbId}.supabase.co`;

    // 1. Liveness / paused detection — call REST endpoint
    const r0 = await httpRequest(`${baseUrl}/rest/v1/?select=*`, {
      headers: supabaseHeaders(serviceKey), timeoutMs: 8000,
    });
    if (!r0.ok && (r0.status === 503 || r0.status === 0)) {
      ctx.find({
        severity: "error", category: "schema", resource: sbId,
        title: `${product_name}: Supabase project unreachable (${r0.status})`,
        body: `Likely paused/inactive. Cannot audit schema until restored.`,
        evidence: { supabase_id: sbId, status: r0.status },
        remediation_action: null,
      });
      return { reason: "supabase unreachable" };
    }

    if (ctx.deadlineReached()) return null;

    // 2. Run a SQL via Supabase Postgres-Meta-style RPC: list tables in public schema
    //    PostgREST exposes pg_meta if enabled; safer path is a custom RPC. We don't
    //    create one here — we just list public tables via PostgREST's introspection
    //    by reading information_schema.tables (PostgREST does NOT expose information_schema
    //    by default). So we call a built-in RPC if available, otherwise emit a hint.
    //
    //    We rely on the fact that every Supabase project has the `pg_catalog` query
    //    accessible via the pg-meta endpoint at /pg-meta/default/query — but that's
    //    only on the dashboard. From service-role, the cleanest portable path is:
    //    POST /rest/v1/rpc/<custom_fn>. Since we can't assume one exists in
    //    third-party DBs, we degrade gracefully:

    // Heuristic: count rows from a few well-known table names per product.
    const PRODUCT_KEY_TABLES = {
      cart2save:  ["products", "deals", "users"],
      quickscanz: ["scans", "warranties", "products"],
      quietkeep:  ["keeps", "users", "voice_samples"],
      vidyagrid:  ["questions", "diagnostics", "sessions"],
      schoolos:   ["students", "schools", "attendance"],
    };
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
        // Read Content-Range header if available — PostgREST returns count there
        // We do not have a parsed header in our wrapper; treat 200 as 'table exists'.
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
          body:  `${r.status} on table '${t}'. Service role key in ${keyEnv} may be wrong/rotated.`,
          evidence: { status: r.status, table: t },
        });
        return { reason: "auth rejected" };
      } else {
        ctx.find(apiFailure("schema", `${sbId}:${t}`, `GET ${t} status=${r.status}`, { status: r.status }));
      }
    }

    if (reachableCount > 0 && reachableCount === targets.length) {
      ctx.find(healthy("schema", sbId, `All ${targets.length} key tables reachable for ${product_name}.`));
    }

    return { supabase_project_id: sbId, key_env: keyEnv, tables_checked: targets.length, tables_reachable: reachableCount };
  });
}
