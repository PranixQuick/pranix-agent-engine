// lib/clients/github.js — GitHub REST API v3 wrapper.
//
// Auth: Personal Access Token in process.env.GITHUB_PAT (Doppler-injected).
//   - Fine-grained PAT scoped to the repos in project_registry.
//   - Required scopes: actions:write (workflow_dispatch), actions:read (run status), contents:read.
//
// Docs:
//   POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches
//   GET  /repos/{owner}/{repo}/actions/runs?per_page=1
//   GET  /repos/{owner}/{repo}/actions/runs/{run_id}

import { httpRequest } from "./http.js";

const API = "https://api.github.com";

function authHeaders() {
  const pat = process.env.GITHUB_PAT;
  if (!pat) throw new Error("GITHUB_PAT missing");
  return {
    "authorization": `Bearer ${pat}`,
    "accept": "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "pranix-agent-engine",
  };
}

/**
 * Trigger a workflow_dispatch.
 * @param {string} repo         "owner/name"
 * @param {string} workflowId   YAML filename (e.g. "deploy.yml") OR numeric workflow id
 * @param {string} ref          branch or tag (default "main")
 * @param {object} inputs       workflow inputs
 * @returns {Promise<{ok, status, retryable, error?}>}
 *
 * NOTE: GitHub's dispatch endpoint returns 204 No Content on success, with NO run id.
 * To correlate, callers should immediately poll /actions/runs?per_page=1&event=workflow_dispatch.
 */
export async function dispatchWorkflow(repo, workflowId, ref = "main", inputs = {}) {
  if (!repo || !workflowId) {
    return { ok: false, status: 0, retryable: false, error: "repo + workflowId required" };
  }
  const url = `${API}/repos/${repo}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`;
  const r = await httpRequest(url, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
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

/**
 * Find the workflow run created by our most recent dispatch.
 * GitHub doesn't return a run id from /dispatches, so we list runs filtered by
 * event=workflow_dispatch and (optionally) by workflow filename, then take the
 * newest with created_at >= since.
 */
export async function findRecentDispatchRun(repo, workflowId, sinceIso) {
  const params = new URLSearchParams({
    per_page: "5",
    event: "workflow_dispatch",
  });
  if (sinceIso) params.set("created", `>=${sinceIso}`);

  const url = `${API}/repos/${repo}/actions/workflows/${encodeURIComponent(workflowId)}/runs?${params.toString()}`;
  const r = await httpRequest(url, { headers: authHeaders(), timeoutMs: 10000 });
  if (!r.ok) {
    return { ok: false, status: r.status, retryable: r.retryable, error: r.data?.message || r.text };
  }
  const run = r.data?.workflow_runs?.[0] ?? null;
  return { ok: true, run };
}

/**
 * Get full status of a specific run.
 */
export async function getRunStatus(repo, runId) {
  const url = `${API}/repos/${repo}/actions/runs/${runId}`;
  const r = await httpRequest(url, { headers: authHeaders(), timeoutMs: 10000 });
  if (!r.ok) {
    return { ok: false, status: r.status, retryable: r.retryable, error: r.data?.message || r.text };
  }
  return {
    ok: true,
    status: r.data.status,           // queued | in_progress | completed
    conclusion: r.data.conclusion,   // success | failure | cancelled | timed_out | skipped | null
    html_url: r.data.html_url,
    run_id: r.data.id,
    head_sha: r.data.head_sha,
    head_branch: r.data.head_branch,
    created_at: r.data.created_at,
    updated_at: r.data.updated_at,
  };
}
