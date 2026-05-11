// lib/agents/verifier.js — ESM
// Capabilities:
//   verify_deployment(input) — poll Vercel deployment lifecycle and record outcome
//   http_smoke_test(input)   — run smoke_test_definitions against a base URL
//
// All write paths land in:
//   - deployment_verifications (audit trail)
//   - smoke_test_results       (audit trail)
//   - founder_alerts           (dashboard surfacing)
//
// Token routing: Vercel token by project's account_tier on project_registry.
//   account_tier='primary'   → VERCEL_TOKEN          (Account 2 / pranixailabs)
//   account_tier='secondary' → VERCEL_SECONDARY_TOKEN (Account 1 / prashanthrangineni)

import { supabase, alert } from "../supabase.js";

const VERCEL_API = "https://api.vercel.com";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function vercelTokenForTier(tier) {
  if (tier === "secondary") {
    if (!process.env.VERCEL_SECONDARY_TOKEN) throw new Error("VERCEL_SECONDARY_TOKEN not set");
    return process.env.VERCEL_SECONDARY_TOKEN;
  }
  if (!process.env.VERCEL_TOKEN) throw new Error("VERCEL_TOKEN not set");
  return process.env.VERCEL_TOKEN;
}

async function resolveProject(input) {
  const { project_name, vercel_project_id } = input || {};
  if (!project_name && !vercel_project_id) {
    const err = new Error("Need project_name or vercel_project_id");
    err.status = 400; // mark as 4xx so safeError → retryable:false
    throw err;
  }
  let q = supabase.from("project_registry").select("project_name, vercel_project_id, account_tier, url");
  if (project_name)        q = q.eq("project_name", project_name);
  else                     q = q.eq("vercel_project_id", vercel_project_id);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`project_registry: ${error.message}`);
  if (!data)  throw new Error(`No project_registry row for ${project_name || vercel_project_id}`);
  if (!data.vercel_project_id) throw new Error(`No vercel_project_id on ${data.project_name}`);
  return data;
}

async function vFetch(token, path) {
  const r = await fetch(`${VERCEL_API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) {
    const e = new Error(`Vercel ${path} → ${r.status}`);
    e.status = r.status;
    e.body = body;
    throw e;
  }
  return body;
}

// classifyHttpError — Track A revised (OPTION_1_TRACK_A_REVISED):
// Structured `reason` field on DLQ entries + 401/403 founder alert.
// Note: 429 is retryable (rate-limit), classified as "transient".
//
// reason values:
//   "auth_error"        — 401  (credential missing/invalid/expired)
//   "permission_denied" — 403
//   "file_not_found"    — 404
//   "client_error"      — other 4xx (not 429)
//   "transient"         — 5xx/429/network/timeout
function classifyHttpError(status) {
  if (status === 401) return "auth_error";
  if (status === 403) return "permission_denied";
  if (status === 404) return "file_not_found";
  if (status === 429) return "transient";
  if (status && status >= 400 && status < 500) return "client_error";
  return "transient";
}

function safeError(e) {
  const status = e?.status;
  const reason = classifyHttpError(status);
  const errorStr = `${e.message}${e.body?.error?.message ? " — " + e.body.error.message : ""}`;

  // 401/403: emit founder alert to prevent silent credential-stuffing (Track A revised).
  if (status === 401 || status === 403) {
    alert({
      level: "critical",
      source: "engine:auth_failure",
      title: `Engine auth failure: Vercel returned ${status}`,
      body: errorStr,
      context: { provider: "vercel", status, reason },
    }).catch(() => {});
  }

  if (status && status >= 400 && status < 500 && status !== 429) {
    return { ok: false, retryable: false, reason, error: errorStr };
  }
  return { ok: false, retryable: true, reason, error: e?.message || String(e) };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// verify_deployment
// ---------------------------------------------------------------------------
//
// Inputs (any one resolves the deployment):
//   { project_name, commit_sha }                          — find latest deploy for sha
//   { project_name, vercel_deployment_id }                — direct
//   { vercel_project_id, ... }                            — alternative
//   { project_name }                                       — find latest preview
//
// Optional:
//   poll_max_sec  (default 600)
//   poll_interval (default 15s)

export async function verify_deployment(task) {
  const startedAt = Date.now();
  let proj = null, token = null;
  try {
    const input = task.input || {};
    proj = await resolveProject(input);
    token = vercelTokenForTier(proj.account_tier);

    const teamQuery = `?teamId=${encodeURIComponent(proj.account_tier === "secondary" ? "" : "team_9BU3hGKRvYLIACE0GCWDMsV0")}`;
    const teamSuffix = proj.account_tier === "secondary" ? "" : teamQuery;

    let depId = input.vercel_deployment_id;
    let lookupVia = depId ? "direct_id" : null;

    if (!depId) {
      const list = await vFetch(token, `/v6/deployments?projectId=${proj.vercel_project_id}&limit=20${teamSuffix.replace("?","&")}`);
      const arr = list?.deployments || [];
      if (input.commit_sha) {
        const sha = input.commit_sha.slice(0, 7);
        const m = arr.find(d => (d.meta?.githubCommitSha || "").startsWith(sha) ||
                                (d.meta?.gitlabCommitSha  || "").startsWith(sha));
        if (!m) return { ok: false, retryable: false, error: `No deployment found for commit ${input.commit_sha} on ${proj.project_name}` };
        depId = m.uid;
        lookupVia = "commit_sha";
      } else if (input.git_ref) {
        const m = arr.find(d => d.meta?.githubCommitRef === input.git_ref);
        if (!m) return { ok: false, retryable: false, error: `No deployment found for ref ${input.git_ref}` };
        depId = m.uid;
        lookupVia = "git_ref";
      } else {
        if (!arr.length) return { ok: false, retryable: false, error: "No deployments found for project" };
        depId = arr[0].uid;
        lookupVia = "latest";
      }
    }

    const { data: vrow } = await supabase.from("deployment_verifications").insert({
      task_id: task.id || null,
      project_name: proj.project_name,
      vercel_project_id: proj.vercel_project_id,
      vercel_deployment_id: depId,
      commit_sha: input.commit_sha || null,
      git_ref: input.git_ref || null,
      initial_state: "polling",
    }).select().maybeSingle();
    const verifId = vrow?.id;

    const pollMax = (task.input?.poll_max_sec ?? 600) * 1000;
    const interval = (task.input?.poll_interval ?? 15) * 1000;
    const deadline = Date.now() + pollMax;
    let pollCount = 0;
    let dep = null;
    let lastState = null;

    while (Date.now() < deadline) {
      pollCount++;
      dep = await vFetch(token, `/v13/deployments/${depId}${teamSuffix}`);
      const state = dep.readyState || dep.state;
      lastState = state;
      if (state === "READY" || state === "ERROR" || state === "CANCELED") break;
      await sleep(interval);
    }

    const finalState = lastState || "TIMEOUT";
    const buildDurationSec = dep?.ready && dep?.buildingAt ? Math.round((dep.ready - dep.buildingAt)/1000) : null;
    const url = dep?.url ? `https://${dep.url}` : null;
    const errMsg = (finalState === "ERROR")
      ? (dep?.errorMessage || dep?.errorCode || "deployment errored")
      : (finalState === "CANCELED" ? "deployment canceled" : null);

    if (verifId) {
      await supabase.from("deployment_verifications").update({
        final_state: finalState,
        build_duration_sec: buildDurationSec,
        poll_count: pollCount,
        url, error_message: errMsg,
        raw: dep,
        completed_at: new Date().toISOString(),
      }).eq("id", verifId);
    }

    const level = finalState === "READY" ? "info" : (finalState === "TIMEOUT" ? "warn" : "error");
    await alert({
      level, source: "verify_deployment",
      title: `${proj.project_name}: deploy ${finalState}${buildDurationSec ? ` in ${buildDurationSec}s` : ""}`,
      body: errMsg ? errMsg : (url || null),
      context: {
        project: proj.project_name,
        deployment_id: depId,
        state: finalState,
        url,
        commit_sha: input.commit_sha,
        git_ref: input.git_ref,
        lookup_via: lookupVia,
        polls: pollCount,
      },
    });

    return {
      ok: finalState === "READY",
      retryable: false,
      result: {
        project: proj.project_name,
        deployment_id: depId,
        state: finalState,
        url,
        build_duration_sec: buildDurationSec,
        commit_sha: input.commit_sha || dep?.meta?.githubCommitSha || null,
        polls: pollCount,
        error: errMsg,
      },
    };
  } catch (e) { return safeError(e); }
}

// ---------------------------------------------------------------------------
// http_smoke_test
// ---------------------------------------------------------------------------

export async function http_smoke_test(task) {
  const startedAt = Date.now();
  try {
    const input = task.input || {};
    const project_name = input.project_name;
    if (!project_name) return { ok: false, retryable: false, error: "project_name required" };

    let base_url = input.base_url;
    if (!base_url) {
      const { data: reg } = await supabase.from("project_registry")
        .select("url").eq("project_name", project_name).maybeSingle();
      base_url = reg?.url;
    }
    if (!base_url) return { ok: false, retryable: false, error: `No base_url for ${project_name} (pass base_url or set project_registry.url)` };
    base_url = base_url.replace(/\/+$/, "");

    const { data: defs, error: defErr } = await supabase
      .from("smoke_test_definitions")
      .select("*").eq("project_name", project_name).eq("is_active", true);
    if (defErr) throw new Error(`smoke_test_definitions: ${defErr.message}`);
    if (!defs?.length) return { ok: false, retryable: false, error: `No smoke tests defined for ${project_name}` };

    const timeoutMs = input.timeout_ms || 15000;
    const results = [];
    for (const d of defs) {
      const url = base_url + d.path;
      const t0 = Date.now();
      let res = { name: d.name, path: d.path, url, critical: d.is_critical, passed: false, status: null, duration_ms: 0, error: null, missing_strings: [], forbidden_strings: [] };
      try {
        const ctrl = new AbortController();
        const tt = setTimeout(() => ctrl.abort(), timeoutMs);
        const r = await fetch(url, { redirect: "follow", signal: ctrl.signal, headers: { "user-agent": "pranix-smoke-test" }});
        clearTimeout(tt);
        res.status = r.status;
        const body = await r.text();

        const statusOk = r.status === d.expect_status;
        const missing = (d.expect_strings || []).filter(s => !body.includes(s));
        const forbidden = (d.forbid_strings || []).filter(s => body.includes(s));
        res.missing_strings = missing;
        res.forbidden_strings = forbidden;
        res.passed = statusOk && missing.length === 0 && forbidden.length === 0;
        if (!statusOk) res.error = `HTTP ${r.status} (expected ${d.expect_status})`;
        else if (missing.length) res.error = `missing strings: ${missing.join(", ")}`;
        else if (forbidden.length) res.error = `forbidden strings present: ${forbidden.join(", ")}`;
      } catch (e) {
        res.error = e?.name === "AbortError" ? "timeout" : (e?.message || String(e));
      }
      res.duration_ms = Date.now() - t0;
      results.push(res);
    }

    const total = results.length;
    const passed = results.filter(r => r.passed).length;
    const failed = total - passed;
    const criticalFailed = results.filter(r => !r.passed && r.critical).length;
    const durationMs = Date.now() - startedAt;

    await supabase.from("smoke_test_results").insert({
      task_id: task.id || null,
      project_name, base_url,
      total, passed, failed,
      duration_ms: durationMs,
      results,
      triggered_by: input.triggered_by || "manual",
    });

    const level = criticalFailed > 0 ? "error" : (failed > 0 ? "warn" : "info");
    await alert({
      level, source: "http_smoke_test",
      title: `${project_name}: smoke ${passed}/${total} passed${criticalFailed ? ` (${criticalFailed} critical fail)` : ""}`,
      body: failed > 0 ? results.filter(r => !r.passed).map(r => `${r.name}: ${r.error}`).join("\n") : `All ${total} checks passed against ${base_url}`,
      context: { project: project_name, base_url, total, passed, failed, critical_failed: criticalFailed },
    });

    return {
      ok: criticalFailed === 0,
      retryable: false,
      result: { project: project_name, base_url, total, passed, failed, critical_failed: criticalFailed, results },
    };
  } catch (e) { return safeError(e); }
}
