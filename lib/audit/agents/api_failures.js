// lib/audit/agents/api_failures.js — audit_api_failures handler.

import { httpRequest } from "../../clients/http.js";
import { runAudit } from "../runner.js";
import { getProject, resolveVercelToken, resolveVercelTeamId } from "../../registry.js";
import { missingEnv, apiFailure, healthy, grade } from "../findings.js";

const API = "https://api.vercel.com";

function vHeaders(token) { return { "authorization": `Bearer ${token}`, "user-agent": "pranix-agent-engine/audit" }; }

function relativeToIso(rel) {
  if (!rel) return undefined;
  if (rel.startsWith("PT") || rel.includes("T")) return rel;
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
    const proj = await getProject(product_name);
    if (proj.error) {
      ctx.find({ severity: "critical", category: "api_failures", resource: product_name, title: proj.error });
      return { reason: proj.error };
    }
    const projectId = proj.project.vercel_project_id;
    if (!projectId) {
      ctx.find({ severity: "critical", category: "api_failures", resource: product_name,
        title: `${product_name}: no vercel_project_id` });
      return { reason: "no project id" };
    }
    const tokRes = resolveVercelToken(proj.project);
    if (tokRes.error) { ctx.find(missingEnv(tokRes.env_name || "VERCEL_TOKEN", product_name)); return { reason: tokRes.error }; }
    const teamId = resolveVercelTeamId(proj.project);

    const sinceIso = relativeToIso(since);
    const params = new URLSearchParams({
      projectId, limit: "200", environment: "production",
    });
    if (sinceIso) params.set("since", sinceIso);

    const teamQS = teamId ? `&teamId=${encodeURIComponent(teamId)}` : "";
    const url = `${API}/v1/projects/${encodeURIComponent(projectId)}/runtime-logs?${params.toString()}${teamQS}`;
    const r = await httpRequest(url, { headers: vHeaders(tokRes.token), timeoutMs: 15000 });

    if (r.status === 404 || r.status === 405) {
      ctx.find({
        severity: "info", category: "api_failures", resource: projectId,
        title: `${product_name}: runtime logs endpoint returned ${r.status}`,
        body:  "Vercel runtime logs may not be available on this plan/region.",
      });
      return { reason: "runtime logs unavailable" };
    }
    if (!r.ok) {
      ctx.find(apiFailure("api_failures", projectId, `runtime logs ${r.status}: ${r.data?.error?.message || r.text}`, { status: r.status, token_env: tokRes.env_name }));
      return { reason: "logs fetch failed" };
    }

    const logs = Array.isArray(r.data?.logs) ? r.data.logs : (Array.isArray(r.data) ? r.data : []);
    const total  = logs.length;
    const errors = logs.filter(l => {
      const lvl = (l.level || "").toLowerCase();
      const sc  = l.statusCode || l.status_code;
      return lvl === "error" || lvl === "fatal" || (typeof sc === "number" && sc >= 500);
    });

    const rate = total ? errors.length / total : 0;
    const sev  = grade(rate, { warn: 0.02, error: 0.10, critical: 0.30 });
    if (sev !== "info") {
      ctx.find({
        severity: sev, category: "api_failures", resource: projectId,
        title: `${product_name}: ${(rate * 100).toFixed(1)}% error rate (${errors.length}/${total} logs in ${since})`,
        body:  `Production runtime errors over the last ${since}.`,
        evidence: { total, errors: errors.length, since: sinceIso },
      });
    } else if (total > 0) {
      ctx.find(healthy("api_failures", projectId, `Error rate ${(rate * 100).toFixed(2)}% across ${total} logs.`));
    }

    const byRoute = new Map();
    for (const e of errors) {
      const p = e.requestPath || e.path || e.url || "(unknown)";
      byRoute.set(p, (byRoute.get(p) || 0) + 1);
    }
    const top = [...byRoute.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [path, count] of top) {
      if (count < 5) break;
      ctx.find({
        severity: count >= 50 ? "error" : "warn",
        category: "api_failures", resource: `${projectId}${path}`,
        title:    `${product_name}: route ${path} — ${count} errors in last ${since}`,
        evidence: { route: path, count, since: sinceIso },
      });
    }

    return { vercel_project_id: projectId, since: sinceIso, total_logs: total, error_count: errors.length, token_env: tokRes.env_name };
  });
}
