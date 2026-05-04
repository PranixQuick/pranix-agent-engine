// lib/audit/agents/env.js — audit_env_vars handler.
//
// Inputs: { product_name, expected?: string[] }   // expected = required env var names
//
// Read-only checks (uses VERCEL_TOKEN, optional GITHUB_PAT):
//   1. List Vercel env vars for project (NAMES ONLY — never read decrypted values).
//   2. For each name in `expected`, find missing ones → 'error' finding.
//   3. Find env vars with name patterns that look risky (e.g. *_SECRET, *_KEY, *_TOKEN)
//      but with `target` including 'preview' AND no Production target — that's misconfig.
//   4. (best-effort) GitHub: scan default branch top-level for .env / .env.* files
//      committed to the repo — any match is 'critical'.
//
// Per-product expected sets are encoded inline below. Override via task.input.expected.

import { httpRequest } from "../../clients/http.js";
import { runAudit } from "../runner.js";
import { getProject } from "../../registry.js";
import { missingEnv, apiFailure, healthy } from "../findings.js";

const VERCEL_API = "https://api.vercel.com";
const GITHUB_API = "https://api.github.com";

const EXPECTED_BY_PRODUCT = {
  cart2save:  ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CUELINKS_TOKEN"],
  quickscanz: ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_ONESIGNAL_APP_ID"],
  quietkeep:  ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SARVAM_API_KEY"],
  vidyagrid:  ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
  schoolos:   ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY"],
};

function vHeaders() {
  return { "authorization": `Bearer ${process.env.VERCEL_TOKEN}`, "user-agent": "pranix-agent-engine/audit" };
}
function teamFirst()  { const t=process.env.VERCEL_TEAM_ID; return t ? `?teamId=${encodeURIComponent(t)}` : ""; }
function teamPrefix() { const t=process.env.VERCEL_TEAM_ID; return t ? `&teamId=${encodeURIComponent(t)}` : ""; }

function ghHeaders() {
  return {
    "authorization":         `Bearer ${process.env.GITHUB_PAT}`,
    "accept":                "application/vnd.github+json",
    "x-github-api-version":  "2022-11-28",
    "user-agent":            "pranix-agent-engine/audit",
  };
}

export async function auditEnvVars(task) {
  const product_name = task.input?.product_name;
  if (!product_name) return { ok: false, retryable: false, error: "input.product_name required" };
  const expected = task.input?.expected || EXPECTED_BY_PRODUCT[product_name] || [];

  return runAudit(task, { agent: "env", product: product_name, scope: { product_name, expected } }, async (ctx) => {
    if (!process.env.VERCEL_TOKEN) {
      ctx.find(missingEnv("VERCEL_TOKEN", product_name));
      return { reason: "VERCEL_TOKEN missing" };
    }
    const proj = await getProject(product_name);
    if (proj.error) {
      ctx.find({ severity: "critical", category: "env", resource: product_name, title: proj.error });
      return { reason: proj.error };
    }
    const projectId = proj.project.vercel_project_id;
    if (!projectId) {
      ctx.find({ severity: "critical", category: "env", resource: product_name,
        title: `${product_name}: no vercel_project_id`, body: "Cannot audit env without it." });
      return { reason: "no project id" };
    }

    // 1. List env var names
    const r0 = await httpRequest(`${VERCEL_API}/v9/projects/${encodeURIComponent(projectId)}/env${teamFirst()}`, {
      headers: vHeaders(), timeoutMs: 12000,
    });
    if (!r0.ok) {
      ctx.find(apiFailure("env", projectId, `GET env failed: ${r0.status}: ${r0.data?.error?.message || r0.text}`, { status: r0.status }));
      return { reason: "vercel env unreachable" };
    }
    const envs = r0.data?.envs || [];
    const presentNames = new Set(envs.map(e => e.key));

    // 2. Required-but-missing
    for (const need of expected) {
      if (!presentNames.has(need)) {
        ctx.find({
          severity: "error", category: "env", resource: `${projectId}:${need}`,
          title: `${product_name}: missing required env var ${need}`,
          body:  `Expected env key '${need}' is not configured on the Vercel project.`,
          evidence: { product: product_name, missing: need },
        });
      }
    }

    // 3. Misconfig: secret-like names targeted at preview only (no production)
    const RISKY = /(SECRET|KEY|TOKEN|PASSWORD|PRIVATE)/i;
    for (const e of envs) {
      if (!RISKY.test(e.key)) continue;
      const targets = Array.isArray(e.target) ? e.target : (e.target ? [e.target] : []);
      if (targets.length > 0 && !targets.includes("production")) {
        ctx.find({
          severity: "warn", category: "env", resource: `${projectId}:${e.key}`,
          title: `${product_name}: secret-like env '${e.key}' has no production target`,
          body: `Targets: ${JSON.stringify(targets)}. If this should be a prod secret, it's missing from production.`,
          evidence: { key: e.key, targets },
        });
      }
    }

    if (ctx.deadlineReached()) return { presentCount: envs.length };

    // 4. GitHub: any committed .env files at repo root?
    if (process.env.GITHUB_PAT && proj.project.github_repo) {
      const repo = proj.project.github_repo;
      const r1 = await httpRequest(`${GITHUB_API}/repos/${repo}/contents/`, { headers: ghHeaders(), timeoutMs: 10000 });
      if (r1.ok && Array.isArray(r1.data)) {
        const offenders = r1.data.filter(x => /^\.env(\..*)?$/.test(x.name));
        for (const f of offenders) {
          ctx.find({
            severity: "critical", category: "env", resource: `${repo}:${f.name}`,
            title: `${repo}: ${f.name} committed to repo`,
            body:  `An env file '${f.name}' exists in the repo root. Likely leaked credentials.`,
            evidence: { path: f.path, html_url: f.html_url, sha: f.sha },
          });
        }
        if (offenders.length === 0) {
          ctx.find(healthy("env", repo, "No .env files committed at repo root."));
        }
      }
    }

    if (expected.length > 0 && expected.every(n => presentNames.has(n))) {
      ctx.find(healthy("env", projectId, `All ${expected.length} required env keys present.`));
    }

    return { vercel_project_id: projectId, env_count: envs.length, expected_count: expected.length };
  });
}
