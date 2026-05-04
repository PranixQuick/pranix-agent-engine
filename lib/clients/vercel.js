// lib/clients/vercel.js — Vercel REST API wrapper.
//
// Auth: VERCEL_TOKEN (Doppler-injected). Optional VERCEL_TEAM_ID for team-scoped
// projects (sent as ?teamId=team_xxx on every request when set).
//
// Endpoints used:
//   GET  /v6/deployments?projectId=...&limit=...
//   POST /v13/deployments  (create new — used for redeploy by reusing source)
//   GET  /v13/deployments/{idOrUrl}
//   POST /v9/projects/{projectId}/promote/{deploymentId}  (promote preview to production)

import { httpRequest } from "./http.js";

const API = "https://api.vercel.com";

function authHeaders() {
  const tok = process.env.VERCEL_TOKEN;
  if (!tok) throw new Error("VERCEL_TOKEN missing");
  return {
    "authorization": `Bearer ${tok}`,
    "user-agent": "pranix-agent-engine",
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

/**
 * Get the latest production deployment for a project.
 */
export async function getLatestProductionDeployment(projectId) {
  const url = `${API}/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=1&target=production&state=READY${teamSuffix()}`;
  const r = await httpRequest(url, { headers: authHeaders(), timeoutMs: 12000 });
  if (!r.ok) {
    return { ok: false, status: r.status, retryable: r.retryable, error: r.data?.error?.message || r.text };
  }
  const d = r.data?.deployments?.[0] ?? null;
  return { ok: true, deployment: d };
}

/**
 * Trigger a redeploy by recreating the latest production deployment from its
 * git source. Vercel doesn't have a single "redeploy" button in the API; the
 * canonical way is POST /v13/deployments with `gitSource` from the previous
 * deployment.
 */
export async function redeployLatest(projectId, projectName) {
  const latest = await getLatestProductionDeployment(projectId);
  if (!latest.ok) return latest;
  if (!latest.deployment) {
    return { ok: false, status: 404, retryable: false, error: "no prior production deployment to redeploy" };
  }

  const src = latest.deployment;

  // Build a minimal create-deployment payload that reuses the existing git source.
  const body = {
    name: projectName || src.name,
    target: "production",
    project: projectId,
    gitSource: src.gitSource ?? src.meta?.gitSource ?? undefined,
    meta: { triggered_by: "pranix-agent-engine", redeploy_of: src.uid },
  };
  // Some projects record gitSource under different keys; include common fallbacks
  if (!body.gitSource && src.meta?.githubCommitRef && src.meta?.githubRepo) {
    body.gitSource = {
      type: "github",
      ref: src.meta.githubCommitRef,
      repoId: src.meta.githubRepoId,
      sha: src.meta.githubCommitSha,
    };
  }

  if (!body.gitSource) {
    return { ok: false, status: 422, retryable: false, error: "could not derive gitSource from latest deployment" };
  }

  const url = `${API}/v13/deployments${teamFirst()}`;
  const r = await httpRequest(url, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 20000,
  });

  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      retryable: r.retryable,
      error: r.data?.error?.message || r.data?.error?.code || r.text,
    };
  }
  return {
    ok: true,
    deploymentId: r.data?.id,
    url: r.data?.url ? `https://${r.data.url}` : null,
    state: r.data?.readyState || r.data?.status,
    raw: r.data,
  };
}

/**
 * Get a single deployment's full state.
 */
export async function getDeployment(idOrUrl) {
  const id = encodeURIComponent(idOrUrl);
  const url = `${API}/v13/deployments/${id}${teamFirst()}`;
  const r = await httpRequest(url, { headers: authHeaders(), timeoutMs: 10000 });
  if (!r.ok) {
    return { ok: false, status: r.status, retryable: r.retryable, error: r.data?.error?.message || r.text };
  }
  return {
    ok: true,
    state: r.data.readyState || r.data.status,    // QUEUED|BUILDING|READY|ERROR|CANCELED
    url: r.data.url ? `https://${r.data.url}` : null,
    target: r.data.target,
    createdAt: r.data.createdAt,
    raw: r.data,
  };
}

/**
 * Promote an existing deployment to production.
 */
export async function promoteToProduction(projectId, deploymentId) {
  const url = `${API}/v9/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}${teamFirst()}`;
  const r = await httpRequest(url, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: "{}",
    timeoutMs: 15000,
  });
  if (!r.ok) {
    return { ok: false, status: r.status, retryable: r.retryable, error: r.data?.error?.message || r.text };
  }
  return { ok: true, raw: r.data };
    }
