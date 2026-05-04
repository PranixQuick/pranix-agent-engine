// lib/audit/agents/repo.js — audit_repo handler.
//
// Inputs (task.input):
//   { product_name: string, ref?: string }
//
// Read-only checks (uses GITHUB_PAT):
//   1. Repo exists + accessible
//   2. Default branch is 'main' or 'master' (else warn)
//   3. Last commit recency (>180d → warn, >365d → error)
//   4. Has at least one workflow file in .github/workflows/ (else info)
//   5. Recent workflow_runs success rate (last 30) — error if >50% failure
//   6. README + LICENSE presence (info-level if missing)
//   7. Open dependabot alerts count (best-effort; requires alerts:read)
//   8. Branch protection enabled? (best-effort)
//
// Network: every external call goes through httpRequest (timeouts + retry).

import { httpRequest } from "../../clients/http.js";
import { runAudit } from "../runner.js";
import { getProject } from "../../registry.js";
import { missingEnv, deferred, apiFailure, healthy, grade } from "../findings.js";

const API = "https://api.github.com";

function ghHeaders() {
  return {
    "authorization":         `Bearer ${process.env.GITHUB_PAT}`,
    "accept":                "application/vnd.github+json",
    "x-github-api-version":  "2022-11-28",
    "user-agent":            "pranix-agent-engine/audit",
  };
}

async function gh(path) {
  return httpRequest(`${API}${path}`, { headers: ghHeaders(), timeoutMs: 10000 });
}

export async function auditRepo(task) {
  const product_name = task.input?.product_name;
  if (!product_name) {
    return { ok: false, retryable: false, error: "input.product_name required" };
  }

  return runAudit(task, { agent: "repo", product: product_name, scope: { product_name } }, async (ctx) => {
    if (!process.env.GITHUB_PAT) {
      ctx.find(missingEnv("GITHUB_PAT", product_name));
      return { reason: "GITHUB_PAT missing" };
    }

    const proj = await getProject(product_name);
    if (proj.error) {
      ctx.find({
        severity: "critical", category: "repo", resource: product_name,
        title: `project_registry: '${product_name}' not found`,
        body: proj.error,
      });
      return { reason: proj.error };
    }
    const repo = proj.project.github_repo;
    if (!repo) {
      ctx.find({
        severity: "critical", category: "repo", resource: product_name,
        title: `${product_name}: github_repo column is null in project_registry`,
        body: "Cannot audit repo without owner/name mapping.",
        remediation_action: null,
      });
      return { reason: "no github_repo" };
    }

    // --- 1. Repo accessible? -----------------------------------------------
    const r0 = await gh(`/repos/${repo}`);
    if (!r0.ok) {
      ctx.find(apiFailure("repo", repo, `GET /repos/${repo} → ${r0.status}: ${r0.data?.message || r0.text}`, { status: r0.status }));
      return { reason: "repo unreachable" };
    }
    const meta = r0.data;
    const defaultBranch = meta.default_branch;
    const archived      = meta.archived === true;

    if (archived) {
      ctx.find({
        severity: "warn", category: "repo", resource: repo,
        title: `${repo} is archived`,
        body:  "Repository is archived on GitHub. No new commits possible.",
      });
    }

    // --- 2. Default branch -------------------------------------------------
    if (defaultBranch !== "main" && defaultBranch !== "master") {
      ctx.find({
        severity: "info", category: "repo", resource: repo,
        title: `${repo}: non-standard default branch '${defaultBranch}'`,
        body:  "Default branch is neither 'main' nor 'master'.",
        evidence: { default_branch: defaultBranch },
      });
    }

    if (ctx.deadlineReached()) return null;

    // --- 3. Last commit recency -------------------------------------------
    const r1 = await gh(`/repos/${repo}/commits?per_page=1&sha=${encodeURIComponent(defaultBranch)}`);
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

    // --- 4. Workflows present? --------------------------------------------
    const r2 = await gh(`/repos/${repo}/actions/workflows`);
    if (!r2.ok) {
      ctx.find(apiFailure("repo", repo, `GET workflows failed: ${r2.status}`, { status: r2.status }));
    } else {
      const wfCount = r2.data?.total_count ?? 0;
      if (wfCount === 0) {
        ctx.find({
          severity: "info", category: "repo", resource: repo,
          title: `${repo}: no GitHub Actions workflows`,
          body:  "Repo has zero workflow files in .github/workflows/.",
          remediation_action: null,
        });
      }
    }

    if (ctx.deadlineReached()) return null;

    // --- 5. Recent workflow run success rate ------------------------------
    const r3 = await gh(`/repos/${repo}/actions/runs?per_page=30`);
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
            body:  `Failed runs: ${failed.length} / ${completed.length}.`,
            evidence: { sample_failed: failed.slice(0, 3).map(r => ({ id: r.id, name: r.name, conclusion: r.conclusion, html_url: r.html_url })) },
            remediation_action: null,
          });
        }
      }
    }

    if (ctx.deadlineReached()) return null;

    // --- 6. README + LICENSE ---------------------------------------------
    const [readme, license] = await Promise.all([
      gh(`/repos/${repo}/readme`),
      gh(`/repos/${repo}/license`),
    ]);
    if (!readme.ok && readme.status === 404) {
      ctx.find({ severity: "info", category: "repo", resource: repo,
        title: `${repo}: missing README`, body: "No README file found at repo root." });
    }
    if (!license.ok && license.status === 404) {
      ctx.find({ severity: "info", category: "repo", resource: repo,
        title: `${repo}: missing LICENSE`, body: "No LICENSE file found at repo root." });
    }

    if (ctx.deadlineReached()) return null;

    // --- 7. Dependabot alerts (best-effort) -------------------------------
    const r4 = await gh(`/repos/${repo}/dependabot/alerts?state=open&per_page=10`);
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
          body: "Open Dependabot security alerts in this repository.",
          evidence: { counts, sample: alerts.slice(0, 3).map(a => ({ summary: a.security_advisory?.summary, severity: a.security_advisory?.severity, html_url: a.html_url })) },
        });
      } else if (alerts.length === 0) {
        ctx.find(healthy("repo", repo, "No open Dependabot alerts."));
      }
    } else if (r4.status !== 404 && r4.status !== 403) {
      // 403/404 are normal when alerts:read scope isn't granted; not actionable here
      ctx.find(apiFailure("repo", repo, `dependabot fetch failed: ${r4.status}`, { status: r4.status }));
    }

    // --- 8. Branch protection on default branch (best-effort) ------------
    const r5 = await gh(`/repos/${repo}/branches/${encodeURIComponent(defaultBranch)}/protection`);
    if (r5.status === 404) {
      ctx.find({
        severity: "warn", category: "repo", resource: `${repo}@${defaultBranch}`,
        title: `${repo}: '${defaultBranch}' has no branch protection`,
        body:  "Default branch can be force-pushed and merged without review.",
      });
    } else if (!r5.ok && r5.status !== 403) {
      // 403 = token lacks scope; not actionable from worker
      ctx.find(apiFailure("repo", repo, `branch protection fetch failed: ${r5.status}`, { status: r5.status }));
    }

    return { repo, default_branch: defaultBranch, archived };
  });
}
