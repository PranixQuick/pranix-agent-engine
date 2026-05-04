// lib/audit/agents/auth.js — audit_auth_flow handler.
//
// Inputs: { product_name }
//
// Strategy:
//   - We don't have credentials to perform real OTP/auth flows from the worker.
//   - What we CAN do: confirm the auth endpoints are reachable at the product URL,
//     confirm Supabase project is up (via /auth/v1/health), confirm key env vars exist.
//
// Currently scoped to: quietkeep, schoolos. Other products → returns 'not applicable'.

import { httpRequest } from "../../clients/http.js";
import { runAudit } from "../runner.js";
import { getProject } from "../../registry.js";
import { missingEnv, apiFailure, healthy, deferred } from "../findings.js";

const SUPPORTED = new Set(["quietkeep", "schoolos"]);

export async function auditAuthFlow(task) {
  const product_name = task.input?.product_name;
  if (!product_name) return { ok: false, retryable: false, error: "input.product_name required" };

  return runAudit(task, { agent: "auth", product: product_name, scope: { product_name } }, async (ctx) => {
    if (!SUPPORTED.has(product_name)) {
      ctx.find(deferred("auth", product_name, "no auth audit defined for this product", "extend lib/audit/agents/auth.js"));
      return { reason: "not applicable" };
    }

    const proj = await getProject(product_name);
    if (proj.error) {
      ctx.find({ severity: "critical", category: "auth", resource: product_name, title: proj.error });
      return { reason: proj.error };
    }
    const sbId   = proj.project.supabase_project_id;
    const prodUrl= proj.project.url;

    // 1. Supabase auth health (anon key NOT required for /auth/v1/health)
    if (sbId) {
      const r = await httpRequest(`https://${sbId}.supabase.co/auth/v1/health`, {
        timeoutMs: 8000,
      });
      if (r.ok) {
        ctx.find(healthy("auth", sbId, "Supabase /auth/v1/health responded 200."));
      } else if (r.status === 503 || r.status === 0) {
        ctx.find({
          severity: "error", category: "auth", resource: sbId,
          title: `${product_name}: Supabase auth unreachable (${r.status})`,
          body:  "Likely paused/inactive. Auth flows will fail end-to-end.",
          evidence: { supabase_id: sbId, status: r.status },
        });
      } else {
        ctx.find(apiFailure("auth", sbId, `auth health ${r.status}`, { status: r.status }));
      }
    } else {
      ctx.find({
        severity: "warn", category: "auth", resource: product_name,
        title: `${product_name}: no supabase_project_id in registry`,
        body:  "Cannot probe Supabase auth health.",
      });
    }

    if (ctx.deadlineReached()) return null;

    // 2. Public product URL — does the login route render?
    if (prodUrl) {
      const candidates = product_name === "quietkeep"
        ? ["/login", "/signin", "/auth/login", "/business/login"]
        : ["/login", "/signin"];
      let firstOk = null;
      for (const path of candidates) {
        if (ctx.deadlineReached()) break;
        const r = await httpRequest(prodUrl.replace(/\/$/, "") + path, { method: "HEAD", timeoutMs: 6000 });
        if (r.ok) { firstOk = path; break; }
      }
      if (!firstOk) {
        ctx.find({
          severity: "error", category: "auth", resource: prodUrl,
          title: `${product_name}: no login route responded 200`,
          body:  `Tried: ${candidates.join(", ")}.`,
          evidence: { url: prodUrl, candidates },
        });
      } else {
        ctx.find(healthy("auth", `${prodUrl}${firstOk}`, "Login route reachable."));
      }
    } else {
      ctx.find(deferred("auth", product_name, "no production URL in project_registry.url", "set the url column to enable login-route probe"));
    }

    return { product: product_name, supabase_id: sbId, prod_url: prodUrl };
  });
}
