// lib/audit/agents/repo.js — audit_repo handler.
//
// Phase D-multi-account: token resolved per-product from project_registry.

import { httpRequest } from "../../clients/http.js";
import { runAudit } from "../runner.js";
import { getProject, resolveGithubToken } from "../../registry.js";
import { missingEnv, deferred, apiFailure, healthy, grade } from "../findings.js";

const API = "https://api.github.com";

function ghHeaders(token) {
  return {
    "authorization":         `Bearer ${token}`,
    "accept":                "application/vnd.github+json",
    "x-github-api-version":  "2022-11-28",
    "user-agent":            "pranix-agent-engine/audit",
  };
}

async function gh(token, path) {
  return httpRequest(`${API}${path}`, { headers: ghHeaders(token), timeoutMs: 10000 });
}

export async function auditRepo(task) {
  const product_name = task.input?.product_name;
  if (!product_name) return { ok: false, retryable: false, error: "input.product_name required" };

  return runAudit(task, { agent: "repo", product: product_name, scope: { product_name } }, async (ctx) => {
    const proj = await getProject(product_name);
    if (proj.error) {
      ctx.find({ severity: "critical", category: "repo", resource: product_name, title: proj.error });
      return { reason: proj.error };
    }
    const repo = proj.project.github_repo;
    if (!repo) {
      ctx.find({
        severity: "critical", category: "repo", resource: product_name,
        title: `${product_name}: github_repo column is null in project_registry`,
        body: "Cannot audit repo without owner/name mapping.",
      });
      return { reason: "no github_repo" };
    }
    const tokRes = resolveGithubToken(proj.project);
    if (tokRes.error) {
      ctx.find(missingEnv(tokRes.env_name || "GITHUB_PAT", product_name));
      return { reason: tokRes.error };
    }
    const token = tokRes.token;

    // 1. Repo accessible
    const r0 = await gh(token, `/repos/${repo}`);
    if (!r0.ok) {
      const sev = r0.status === 404 ? "critical" : "error";
      ctx.find({
        severity: sev, category: "repo", resource: repo,
        title: `${repo}: GET /repos/${repo} → ${r0.status}`,
        body: r0.data?.message || r0.text,
        evidence: { status: r0.status, token_env: tokRes.env_name },
      });
      return { reason: "repo unreachable" };
    }
    const meta = r0.data;
    const defaultBranch = meta.default_branch;
    const archived      = meta.archived === true;

    if (archived) {
      ctx.find({ severity: "warn", category: "repo", resource: repo,
        title: `${repo} is archived`, body: "Repository is archived on GitHub." });
    }
    if (defaultBranch !== "main" && defaultBranch !== "master") {
      ctx.find({ severity: "info", category: "repo", resource: repo,
        title: `${repo}: non-standard default branch '${defaultBranch}'`,
        evidence: { default_branch: defaultBranch } });
    }
    if (ctx.deadlineReached()) return null;

    // 3. Last commit recency
    const r1 = await gh(token, `/repos/${repo}/commits?per_page=1&sha=${encodeURIComponent(defaultBranch)}`);
    if (!r1.ok) {
      ctx.find(apiFailure("repo", repo, `GET commits failed: ${r1.status}`, { status: r1.status }));
    } else {
      const last = r1.data?.[0];
      if (last) {
        const lastDate = new Date(last.commit?.committer?.date || last.commit?.author?.date);
        const ageDays = Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
        const sev = grade(ageDays, { warn: 90, error: 365 });
        if (sev !== "info") {
          ctx.find({
            severity: sev, category: "repo", resource: repo,
            title: `${repo}: last commit ${ageDays} days ago`,
            body:  `Most recent commit on '${defaultBranch}' is from ${lastDate.toISOString()}.`,
            evidence: { last_commit_sha: last.sha, age_days: ageDays },
          });
        }
      }
    }
    if (ctx.deadlineReached()) return null;

    // 4. Workflows
    const r2 = await gh(token, `/repos/${repo}/actions/workflows`);
    if (r2.ok) {
      const wfCount = r2.data?.total_count ?? 0;
      if (wfCount === 0) {
        ctx.find({ severity: "info", category: "repo", resource: repo,
          title: `${repo}: no GitHub Actions workflows`,
          body: "Repo has zero workflow files in .github/workflows/." });
      }
    } else {
      ctx.find(apiFailure("repo", repo, `GET workflows failed: ${r2.status}`, { status: r2.status }));
    }
    if (ctx.deadlineReached()) return null;

    // 5. Recent workflow run failure rate
    const r3 = await gh(token, `/repos/${repo}/actions/runs?per_page=30`);
    if (r3.ok) {
      const runs = r3.data?.workflow_runs || [];
      if (runs.length > 0) {
        const completed = runs.filter(r => r.status === "completed");
        const failed    = completed.filter(r => r.conclusion && r.conclusion !== "success" && r.conclusion !== "skipped");
        const failRate  = completed.length ? failed.length / completed.length : 0;
        const sev = grade(failRate, { warn: 0.20, error: 0.50, critical: 0.80 });
        if (sev !== "info") {
          ctx.find({
            severity: sev, category: "repo", resource: repo,
            title: `${repo}: ${(failRate * 100).toFixed(0)}% workflow failure rate (last ${completed.length})`,
            body:  `Failed: ${failed.length} / ${completed.length}.`,
            evidence: { sample_failed: failed.slice(0, 3).map(r => ({ id: r.id, name: r.name, conclusion: r.conclusion, html_url: r.html_url })) },
          });
        }
      }
    }
    if (ctx.deadlineReached()) return null;

    // 6. README + LICENSE
    const [readme, license] = await Promise.all([gh(token, `/repos/${repo}/readme`), gh(token, `/repos/${repo}/license`)]);
    if (!readme.ok && readme.status === 404) ctx.find({ severity: "info", category: "repo", resource: repo, title: `${repo}: missing README` });
    if (!license.ok && license.status === 404) ctx.find({ severity: "info", category: "repo", resource: repo, title: `${repo}: missing LICENSE` });
    if (ctx.deadlineReached()) return null;

    // 7. Dependabot alerts (best-effort)
    const r4 = await gh(token, `/repos/${repo}/dependabot/alerts?state=open&per_page=10`);
    if (r4.ok) {
      const alerts = Array.isArray(r4.data) ? r4.data : [];
      const counts = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const a of alerts) {
        const sev = (a.security_advisory?.severity || "low").toLowerCase();
        if (counts[sev] != null) counts[sev]++;
      }
      if (counts.critical > 0 || counts.high > 0) {
        ctx.find({
          severity: counts.critical > 0 ? "critical" : "error",
          category: "repo", resource: repo,
          title: `${repo}: dependabot alerts — ${counts.critical} critical, ${counts.high} high`,
          body: "Open Dependabot security alerts.",
          evidence: { counts, sample: alerts.slice(0, 3).map(a => ({ summary: a.security_advisory?.summary, severity: a.security_advisory?.severity, html_url: a.html_url })) },
        });
      } else if (alerts.length === 0) {
        ctx.find(healthy("repo", repo, "No open Dependabot alerts."));
      }
    }

    // 8. Branch protection (best-effort)
    const r5 = await gh(token, `/repos/${repo}/branches/${encodeURIComponent(defaultBranch)}/protection`);
    if (r5.status === 404) {
      ctx.find({
        severity: "warn", category: "repo", resource: `${repo}@${defaultBranch}`,
        title: `${repo}: '${defaultBranch}' has no branch protection`,
        body:  "Default branch can be force-pushed and merged without review.",
      });
    }

    return { repo, default_branch: defaultBranch, archived, token_env: tokRes.env_name };
  });
}
