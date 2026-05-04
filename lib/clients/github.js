// lib/clients/github.js — GitHub REST API v3 wrapper.
//
// Phase D-multi-account: token is passed in by the caller. The caller
// resolves the right token from the project_registry row via
// resolveGithubToken(project) in lib/registry.js.
//
// Endpoints used:
//   POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches
//   GET  /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs
//   GET  /repos/{owner}/{repo}/actions/runs/{run_id}

import { httpRequest } from "./http.js";

const API = "https://api.github.com";

function ghHeaders(token) {
  if (!token) throw new Error("github token required");
  return {
    "authorization":         `Bearer ${token}`,
    "accept":                "application/vnd.github+json",
    "x-github-api-version":  "2022-11-28",
    "user-agent":            "pranix-agent-engine",
  };
}

/**
 * Trigger a workflow_dispatch.
 */
export async function dispatchWorkflow(token, repo, workflowId, ref = "main", inputs = {}) {
  if (!repo || !workflowId) {
    return { ok: false, status: 0, retryable: false, error: "repo + workflowId required" };
  }
  const url = `${API}/repos/${repo}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`;
  const r = await httpRequest(url, {
    method: "POST",
    headers: { ...ghHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ ref, inputs }),
    timeoutMs: 12000,
  });
  if (r.ok || r.status === 204) return { ok: true, status: r.status };
  return {
    ok: false,
    status: r.status,
    retryable: r.retryable,
    error: r.data?.message || r.text || `github dispatch failed status=${r.status}`,
  };
}

export async function findRecentDispatchRun(token, repo, workflowId, sinceIso) {
  const params = new URLSearchParams({ per_page: "5", event: "workflow_dispatch" });
  if (sinceIso) params.set("created", `>=${sinceIso}`);
  const url = `${API}/repos/${repo}/actions/workflows/${encodeURIComponent(workflowId)}/runs?${params.toString()}`;
  const r = await httpRequest(url, { headers: ghHeaders(token), timeoutMs: 10000 });
  if (!r.ok) return { ok: false, status: r.status, retryable: r.retryable, error: r.data?.message || r.text };
  const run = r.data?.workflow_runs?.[0] ?? null;
  return { ok: true, run };
}

export async function getRunStatus(token, repo, runId) {
  const url = `${API}/repos/${repo}/actions/runs/${runId}`;
  const r = await httpRequest(url, { headers: ghHeaders(token), timeoutMs: 10000 });
  if (!r.ok) return { ok: false, status: r.status, retryable: r.retryable, error: r.data?.message || r.text };
  return {
    ok: true,
    status: r.data.status,
    conclusion: r.data.conclusion,
    html_url: r.data.html_url,
    run_id: r.data.id,
    head_sha: r.data.head_sha,
    head_branch: r.data.head_branch,
    created_at: r.data.created_at,
    updated_at: r.data.updated_at,
  };
}

/**
 * Generic GET — used by audit_repo for arbitrary read-only paths.
 */
export async function ghGet(token, path, timeoutMs = 10000) {
  return httpRequest(`${API}${path}`, { headers: ghHeaders(token), timeoutMs });
}
