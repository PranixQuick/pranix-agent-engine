// lib/audit/agents/api_failures.js — audit_api_failures handler.
//
// Inputs: { product_name, since?: '24h' | '1h' | ISO-string }
//
// Read-only checks (uses VERCEL_TOKEN):
//   - Pull last N runtime logs filtered by level=error and statusCode 5xx
//   - Group by route (request path) and emit findings per hot route
//   - Emit overall error rate finding if > thresholds
//
// Vercel API: GET /v1/projects/{projectId}/runtime-logs (Pro plan feature)
// We use the same path the Vercel MCP get_runtime_logs uses; if it 404s on the
// account we degrade gracefully.

import { httpRequest } from "../../clients/http.js";
import { runAudit } from "../runner.js";
import { getProject } from "../../registry.js";
import { missingEnv, apiFailure, healthy, grade } from "../findings.js";

const API = "https://api.vercel.com";

function vHeaders() { return { "authorization": `Bearer ${process.env.VERCEL_TOKEN}`, "user-agent": "pranix-agent-engine/audit" }; }
function teamFirst()  { const t=process.env.VERCEL_TEAM_ID; return t ? `?teamId=${encodeURIComponent(t)}` : ""; }
function teamPrefix() { const t=process.env.VERCEL_TEAM_ID; return t ? `&teamId=${encodeURIComponent(t)}` : ""; }

function relativeToIso(rel) {
  if (!rel) return undefined;
  if (rel.startsWith("PT") || rel.includes("T")) return rel; // already ISO
  const m = /^(\d+)([hmd])$/.exec(rel);
  if (!m) return rel;
  const [, n, unit] = m;
  const ms = parseInt(n, 10) * (unit === "h" ? 3600 : unit === "m" ? 60 : 86400) * 1000;
  return new Date(Date.now() - ms).toISOString();
}

export async function auditApiFailures(task) {
  const product_name = task.input?.product_name;
  if (!product_name) return { ok: false, retryable: false, error: "input.product_name required" };
  const since = task.input?.since || "24h";

  return runAudit(task, { agent: "api_failures", product: product_name, scope: { product_name, since } }, async (ctx) => {
    if (!process.env.VERCEL_TOKEN) {
      ctx.find(missingEnv("VERCEL_TOKEN", product_name));
      return { reason: "VERCEL_TOKEN missing" };
    }
    const proj = await getProject(product_name);
    if (proj.error) {
      ctx.find({ severity: "critical", category: "api_failures", resource: product_name, title: proj.error });
      return { reason: proj.error };
    }
    const projectId = proj.project.vercel_project_id;
    if (!projectId) {
      ctx.find({ severity: "critical", category: "api_failures", resource: product_name,
        title: `${product_name}: no vercel_project_id`, body: "Cannot fetch logs." });
      return { reason: "no project id" };
    }

    const sinceIso = relativeToIso(since);
    const params = new URLSearchParams({
      projectId,
      limit: "200",
      environment: "production",
    });
    if (sinceIso) params.set("since", sinceIso);

    // Vercel runtime-logs endpoint
    const teamQS = process.env.VERCEL_TEAM_ID ? `&teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : "";
    const url = `${API}/v1/projects/${encodeURIComponent(projectId)}/runtime-logs?${params.toString()}${teamQS}`;
    const r = await httpRequest(url, { headers: vHeaders(), timeoutMs: 15000 });

    if (r.status === 404 || r.status === 405) {
      ctx.find({
        severity: "info", category: "api_failures", resource: projectId,
        title: `${product_name}: runtime logs endpoint returned ${r.status}`,
        body:  "Vercel runtime logs may not be available on this plan/region.",
      });
      return { reason: "runtime logs unavailable" };
    }
    if (!r.ok) {
      ctx.find(apiFailure("api_failures", projectId, `runtime logs ${r.status}: ${r.data?.error?.message || r.text}`, { status: r.status }));
      return { reason: "logs fetch failed" };
    }

    const logs = Array.isArray(r.data?.logs) ? r.data.logs : (Array.isArray(r.data) ? r.data : []);
    const total  = logs.length;
    const errors = logs.filter(l => {
      const lvl = (l.level || "").toLowerCase();
      const sc  = l.statusCode || l.status_code;
      return lvl === "error" || lvl === "fatal" || (typeof sc === "number" && sc >= 500);
    });

    // Overall error rate
    const rate = total ? errors.length / total : 0;
    const sev  = grade(rate, { warn: 0.02, error: 0.10, critical: 0.30 });
    if (sev !== "info") {
      ctx.find({
        severity: sev, category: "api_failures", resource: projectId,
        title: `${product_name}: ${(rate * 100).toFixed(1)}% error rate (${errors.length}/${total} logs in ${since})`,
        body:  `Production runtime errors over the last ${since}.`,
        evidence: { total, errors: errors.length, since: sinceIso },
        remediation_action: null,
      });
    } else if (total > 0) {
      ctx.find(healthy("api_failures", projectId, `Error rate ${(rate * 100).toFixed(2)}% across ${total} logs in last ${since}.`));
    }

    // Top hot routes
    const byRoute = new Map();
    for (const e of errors) {
      const p = e.requestPath || e.path || e.url || "(unknown)";
      byRoute.set(p, (byRoute.get(p) || 0) + 1);
    }
    const top = [...byRoute.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [path, count] of top) {
      if (count < 5) break;   // ignore noise
      ctx.find({
        severity: count >= 50 ? "error" : "warn",
        category: "api_failures", resource: `${projectId}${path}`,
        title:    `${product_name}: route ${path} — ${count} errors in last ${since}`,
        body:     `Hot path with elevated 5xx/error volume.`,
        evidence: { route: path, count, since: sinceIso },
      });
    }

    return { vercel_project_id: projectId, since: sinceIso, total_logs: total, error_count: errors.length };
  });
}
