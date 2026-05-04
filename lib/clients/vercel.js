// lib/clients/vercel.js — Vercel REST API wrapper.
//
// Phase D-multi-account: caller passes token + (optional) teamId.

import { httpRequest } from "./http.js";

const API = "https://api.vercel.com";

function vHeaders(token) {
  if (!token) throw new Error("vercel token required");
  return {
    "authorization": `Bearer ${token}`,
    "user-agent":    "pranix-agent-engine",
  };
}
function teamSuffix(teamId) { return teamId ? `&teamId=${encodeURIComponent(teamId)}` : ""; }
function teamFirst(teamId)  { return teamId ? `?teamId=${encodeURIComponent(teamId)}` : ""; }

export async function getLatestProductionDeployment(token, teamId, projectId) {
  const url = `${API}/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=1&target=production&state=READY${teamSuffix(teamId)}`;
  const r = await httpRequest(url, { headers: vHeaders(token), timeoutMs: 12000 });
  if (!r.ok) return { ok: false, status: r.status, retryable: r.retryable, error: r.data?.error?.message || r.text };
  const d = r.data?.deployments?.[0] ?? null;
  return { ok: true, deployment: d };
}

export async function redeployLatest(token, teamId, projectId, projectName) {
  const latest = await getLatestProductionDeployment(token, teamId, projectId);
  if (!latest.ok) return latest;
  if (!latest.deployment) {
    return { ok: false, status: 404, retryable: false, error: "no prior production deployment to redeploy" };
  }

  const src = latest.deployment;
  const body = {
    name: projectName || src.name,
    target: "production",
    project: projectId,
    gitSource: src.gitSource ?? src.meta?.gitSource ?? undefined,
    meta: { triggered_by: "pranix-agent-engine", redeploy_of: src.uid },
  };
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

  const url = `${API}/v13/deployments${teamFirst(teamId)}`;
  const r = await httpRequest(url, {
    method: "POST",
    headers: { ...vHeaders(token), "content-type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 20000,
  });
  if (!r.ok) {
    return { ok: false, status: r.status, retryable: r.retryable, error: r.data?.error?.message || r.data?.error?.code || r.text };
  }
  return {
    ok: true,
    deploymentId: r.data?.id,
    url: r.data?.url ? `https://${r.data.url}` : null,
    state: r.data?.readyState || r.data?.status,
    raw: r.data,
  };
}

export async function getDeployment(token, teamId, idOrUrl) {
  const id = encodeURIComponent(idOrUrl);
  const url = `${API}/v13/deployments/${id}${teamFirst(teamId)}`;
  const r = await httpRequest(url, { headers: vHeaders(token), timeoutMs: 10000 });
  if (!r.ok) return { ok: false, status: r.status, retryable: r.retryable, error: r.data?.error?.message || r.text };
  return {
    ok: true,
    state: r.data.readyState || r.data.status,
    url: r.data.url ? `https://${r.data.url}` : null,
    target: r.data.target,
    createdAt: r.data.createdAt,
    raw: r.data,
  };
}

export async function promoteToProduction(token, teamId, projectId, deploymentId) {
  const url = `${API}/v9/projects/${encodeURIComponent(projectId)}/promote/${encodeURIComponent(deploymentId)}${teamFirst(teamId)}`;
  const r = await httpRequest(url, {
    method: "POST",
    headers: { ...vHeaders(token), "content-type": "application/json" },
    body: "{}",
    timeoutMs: 15000,
  });
  if (!r.ok) return { ok: false, status: r.status, retryable: r.retryable, error: r.data?.error?.message || r.text };
  return { ok: true, raw: r.data };
}

/**
 * Generic GET — used by audit handlers for arbitrary read-only paths.
 */
export async function vGet(token, teamId, path, timeoutMs = 12000) {
  // Append teamId if path doesn't already have it
  const sep = path.includes("?") ? "&" : "?";
  const fullPath = teamId ? `${path}${sep}teamId=${encodeURIComponent(teamId)}` : path;
  return httpRequest(`${API}${fullPath}`, { headers: vHeaders(token), timeoutMs });
}
