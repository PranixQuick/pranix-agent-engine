// lib/audit/agents/env.js — audit_env_vars handler.
// Phase D-multi-account: tokens resolved per-product.

import { httpRequest } from "../../clients/http.js";
import { runAudit } from "../runner.js";
import { getProject, resolveVercelToken, resolveVercelTeamId, resolveGithubToken } from "../../registry.js";
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

function vHeaders(token) { return { "authorization": `Bearer ${token}`, "user-agent": "pranix-agent-engine/audit" }; }
function ghHeaders(token) {
  return {
    "authorization":         `Bearer ${token}`,
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
    const proj = await getProject(product_name);
    if (proj.error) {
      ctx.find({ severity: "critical", category: "env", resource: product_name, title: proj.error });
      return { reason: proj.error };
    }
    const projectId = proj.project.vercel_project_id;
    if (!projectId) {
      ctx.find({ severity: "critical", category: "env", resource: product_name,
        title: `${product_name}: no vercel_project_id` });
      return { reason: "no project id" };
    }
    const tokRes = resolveVercelToken(proj.project);
    if (tokRes.error) { ctx.find(missingEnv(tokRes.env_name || "VERCEL_TOKEN", product_name)); return { reason: tokRes.error }; }
    const teamId = resolveVercelTeamId(proj.project);
    const teamFirst = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";

    // 1. List env var names
    const r0 = await httpRequest(`${VERCEL_API}/v9/projects/${encodeURIComponent(projectId)}/env${teamFirst}`, {
      headers: vHeaders(tokRes.token), timeoutMs: 12000,
    });
    if (!r0.ok) {
      ctx.find(apiFailure("env", projectId, `GET env failed: ${r0.status}: ${r0.data?.error?.message || r0.text}`, { status: r0.status, token_env: tokRes.env_name }));
      return { reason: "vercel env unreachable" };
    }
    const envs = r0.data?.envs || [];
    const presentNames = new Set(envs.map(e => e.key));

    // 2. Required missing
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

    // 3. Risky misconfig
    const RISKY = /(SECRET|KEY|TOKEN|PASSWORD|PRIVATE)/i;
    for (const e of envs) {
      if (!RISKY.test(e.key)) continue;
      const targets = Array.isArray(e.target) ? e.target : (e.target ? [e.target] : []);
      if (targets.length > 0 && !targets.includes("production")) {
        ctx.find({
          severity: "warn", category: "env", resource: `${projectId}:${e.key}`,
          title: `${product_name}: secret-like env '${e.key}' has no production target`,
          body: `Targets: ${JSON.stringify(targets)}.`,
          evidence: { key: e.key, targets },
        });
      }
    }
    if (ctx.deadlineReached()) return { presentCount: envs.length };

    // 4. .env-file leak scan in repo
    const ghTok = resolveGithubToken(proj.project);
    if (!ghTok.error && proj.project.github_repo) {
      const repo = proj.project.github_repo;
      const r1 = await httpRequest(`${GITHUB_API}/repos/${repo}/contents/`, { headers: ghHeaders(ghTok.token), timeoutMs: 10000 });
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

    return { vercel_project_id: projectId, env_count: envs.length, expected_count: expected.length, token_env: tokRes.env_name };
  });
}
