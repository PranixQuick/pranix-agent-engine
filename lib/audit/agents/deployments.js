// lib/audit/agents/deployments.js — audit_deployments handler.
//
// Inputs: { product_name }
// Read-only checks (uses VERCEL_TOKEN):
//   1. Project reachable
//   2. Last 20 deployments — failure rate
//   3. Latest production deployment state == READY
//   4. Time since last successful production deploy

import { httpRequest } from "../../clients/http.js";
import { runAudit } from "../runner.js";
import { getProject } from "../../registry.js";
import { missingEnv, apiFailure, healthy, grade } from "../findings.js";

const API = "https://api.vercel.com";

function vHeaders() {
  return {
    "authorization": `Bearer ${process.env.VERCEL_TOKEN}`,
    "user-agent":    "pranix-agent-engine/audit",
  };
}
function teamSuffix() {
  const t = process.env.VERCEL_TEAM_ID;
  return t ? `&teamId=${encodeURIComponent(t)}` : "";
}
function teamFirst() {
  const t = process.env.VERCEL_TEAM_ID;
  return t ? `?teamId=${encodeURIComponent(t)}` : "";
}

export async function auditDeployments(task) {
  const product_name = task.input?.product_name;
  if (!product_name) return { ok: false, retryable: false, error: "input.product_name required" };

  return runAudit(task, { agent: "deployments", product: product_name, scope: { product_name } }, async (ctx) => {
    if (!process.env.VERCEL_TOKEN) {
      ctx.find(missingEnv("VERCEL_TOKEN", product_name));
      return { reason: "VERCEL_TOKEN missing" };
    }
    const proj = await getProject(product_name);
    if (proj.error) {
      ctx.find({ severity: "critical", category: "deployments", resource: product_name,
        title: proj.error, body: "Cannot audit deployments without registry row." });
      return { reason: proj.error };
    }
    const projectId = proj.project.vercel_project_id;
    if (!projectId) {
      ctx.find({ severity: "critical", category: "deployments", resource: product_name,
        title: `${product_name}: vercel_project_id is null in project_registry`,
        body: "No way to query deployments." });
      return { reason: "no vercel_project_id" };
    }

    // 1. Project reachable
    const r0 = await httpRequest(`${API}/v9/projects/${encodeURIComponent(projectId)}${teamFirst()}`, {
      headers: vHeaders(), timeoutMs: 10000,
    });
    if (!r0.ok) {
      ctx.find(apiFailure("deployments", projectId, `GET project ${projectId} failed: ${r0.status}: ${r0.data?.error?.message || r0.text}`, { status: r0.status }));
      return { reason: "vercel project not reachable" };
    }

    if (ctx.deadlineReached()) return null;

    // 2. Last 20 deployments → failure rate
    const r1 = await httpRequest(`${API}/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=20${teamSuffix()}`, {
      headers: vHeaders(), timeoutMs: 12000,
    });
    if (!r1.ok) {
      ctx.find(apiFailure("deployments", projectId, `GET deployments failed: ${r1.status}`, { status: r1.status }));
    } else {
      const deps = r1.data?.deployments || [];
      const completed = deps.filter(d => ["READY", "ERROR", "CANCELED"].includes((d.readyState || d.state || "").toUpperCase()));
      const failed    = completed.filter(d => ["ERROR", "CANCELED"].includes((d.readyState || d.state || "").toUpperCase()));
      const rate = completed.length ? failed.length / completed.length : 0;
      const sev = grade(rate, { warn: 0.15, error: 0.40, critical: 0.70 });
      if (sev !== "info") {
        ctx.find({
          severity: sev, category: "deployments", resource: projectId,
          title: `${product_name}: ${(rate * 100).toFixed(0)}% deployment failure rate (last ${completed.length})`,
          body: `${failed.length} of last ${completed.length} deployments ended in ERROR or CANCELED.`,
          evidence: { sample_failed: failed.slice(0, 3).map(d => ({ uid: d.uid, state: d.readyState || d.state, target: d.target, created: d.createdAt })) },
          remediation_action: "vercel_redeploy",
          remediation_input:  { project_name },
        });
      }
    }

    if (ctx.deadlineReached()) return null;

    // 3. Latest production deployment ready?
    const r2 = await httpRequest(`${API}/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=1&target=production${teamSuffix()}`, {
      headers: vHeaders(), timeoutMs: 10000,
    });
    if (r2.ok) {
      const last = r2.data?.deployments?.[0];
      if (!last) {
        ctx.find({
          severity: "warn", category: "deployments", resource: projectId,
          title: `${product_name}: no production deployment found`,
          body: "Vercel project has zero production-target deployments.",
        });
      } else {
        const state = (last.readyState || last.state || "").toUpperCase();
        const ageMin = Math.floor((Date.now() - (last.createdAt || 0)) / 60000);
        if (state !== "READY") {
          ctx.find({
            severity: state === "ERROR" ? "error" : "warn",
            category: "deployments", resource: projectId,
            title: `${product_name}: latest production deployment in ${state}`,
            body: `Last prod deployment ${last.uid} state=${state} created ${ageMin}min ago.`,
            evidence: { uid: last.uid, state, target: last.target, created: last.createdAt },
            remediation_action: "vercel_redeploy",
            remediation_input:  { project_name },
          });
        } else {
          // ageMin > 30 days → info; > 90 days → warn (stale prod)
          const ageDays = Math.floor(ageMin / 1440);
          const sev = grade(ageDays, { warn: 90, error: 180 });
          if (sev !== "info") {
            ctx.find({
              severity: sev, category: "deployments", resource: projectId,
              title: `${product_name}: production deployment is ${ageDays} days old`,
              body: "No fresh production deploy in a long time.",
              evidence: { uid: last.uid, age_days: ageDays },
            });
          } else {
            ctx.find(healthy("deployments", projectId, `Latest prod deployment READY (${ageMin}min old).`));
          }
        }
      }
    }

    return { vercel_project_id: projectId };
  });
}
