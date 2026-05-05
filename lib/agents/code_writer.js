// lib/agents/code_writer.js
// Implements the new code_writer capabilities registered in agent_capabilities.
// Each handler returns { ok, result } | { ok:false, retryable, error }.

const W = require("../clients/github_writer");
const { sb } = require("../supabase");

// Resolve repo + token for a product. Looks at project_registry primary repo
// OR product_repos if a specific role is requested.
async function resolveTarget({ product_name, repo, role = null }) {
  if (repo) return { repo };

  if (role) {
    const { data, error } = await sb
      .from("product_repos")
      .select("github_repo, account_owner")
      .eq("project_name", product_name).eq("role", role).eq("is_active", true)
      .maybeSingle();
    if (error) throw new Error(`product_repos lookup: ${error.message}`);
    if (!data) throw new Error(`No product_repos row for ${product_name}/${role}`);
    return { repo: data.github_repo };
  }

  const { data, error } = await sb
    .from("project_registry")
    .select("github_repo, github_token_env, account_tier")
    .eq("project_name", product_name).maybeSingle();
  if (error) throw new Error(`project_registry lookup: ${error.message}`);
  if (!data?.github_repo) throw new Error(`No github_repo registered for ${product_name}`);
  return { repo: data.github_repo, project: data };
}

// Get the token env name appropriate for a repo. Repos owned by
// prashanthrangineni-sketch use GITHUB_SECONDARY_PAT; PranixQuick use GITHUB_PAT.
function tokenForRepo(repo) {
  const owner = repo.split("/")[0].toLowerCase();
  if (owner === "prashanthrangineni-sketch") return process.env.GITHUB_SECONDARY_PAT;
  if (owner === "pranixquick")               return process.env.GITHUB_PAT;
  // Fallback to primary
  return process.env.GITHUB_PAT;
}

// =====================================================================
// HANDLERS — wired in lib/handlers.js with the same names as action_registry
// =====================================================================

async function github_read_file(task) {
  const { product_name, repo, path, ref } = task.input || {};
  if (!path) return { ok: false, retryable: false, error: "path is required" };
  const { repo: resolvedRepo } = await resolveTarget({ product_name, repo });
  const token = tokenForRepo(resolvedRepo);
  const file  = await W.readFile({ token, repo: resolvedRepo, path, ref });
  return { ok: true, result: { repo: resolvedRepo, path, ...file } };
}

async function github_list_files(task) {
  const { product_name, repo, path, ref } = task.input || {};
  const { repo: resolvedRepo } = await resolveTarget({ product_name, repo });
  const token = tokenForRepo(resolvedRepo);
  const items = await W.listFiles({ token, repo: resolvedRepo, path: path || "", ref });
  return { ok: true, result: { repo: resolvedRepo, path: path || "", items } };
}

async function github_create_branch(task) {
  const { product_name, repo, branchName } = task.input || {};
  if (!branchName) return { ok: false, retryable: false, error: "branchName is required" };
  const { repo: resolvedRepo } = await resolveTarget({ product_name, repo });
  const token = tokenForRepo(resolvedRepo);
  const r = await W.createBranch({ token, repo: resolvedRepo, branchName });
  return { ok: true, result: { repo: resolvedRepo, branch: branchName, ref: r.ref } };
}

async function github_apply_patch(task) {
  const { product_name, repo, branch, path, content, message } = task.input || {};
  if (!branch || !path || content == null || !message) {
    return { ok: false, retryable: false, error: "branch, path, content, message all required" };
  }
  const { repo: resolvedRepo } = await resolveTarget({ product_name, repo });
  const token = tokenForRepo(resolvedRepo);
  const r = await W.applyFilePatch({ token, repo: resolvedRepo, branch, path, content, message });
  return { ok: true, result: { repo: resolvedRepo, branch, path, commit_sha: r.commit?.sha, html_url: r.commit?.html_url } };
}

async function github_create_pr(task) {
  const { product_name, repo, head, base, title, body } = task.input || {};
  if (!head || !title) return { ok: false, retryable: false, error: "head and title required" };
  const { repo: resolvedRepo } = await resolveTarget({ product_name, repo });
  const token = tokenForRepo(resolvedRepo);
  const pr = await W.createPR({ token, repo: resolvedRepo, head, base, title, body: body || "" });

  // Insert founder_alert so dashboard surfaces the PR
  await sb.from("founder_alerts").insert({
    level: "info",
    source: "code_writer",
    title: `PR #${pr.number} opened: ${title}`,
    body: `${resolvedRepo} · ${head} → ${pr.base?.ref || "default"}\n${pr.html_url}`,
    context: { repo: resolvedRepo, pr_number: pr.number, html_url: pr.html_url, head, base: pr.base?.ref },
  });

  return { ok: true, result: { repo: resolvedRepo, pr_number: pr.number, html_url: pr.html_url, head: pr.head.ref, base: pr.base.ref } };
}

async function github_merge_pr(task) {
  const { product_name, repo, prNumber, mergeMethod } = task.input || {};
  if (!prNumber) return { ok: false, retryable: false, error: "prNumber is required" };
  const { repo: resolvedRepo } = await resolveTarget({ product_name, repo });
  const token = tokenForRepo(resolvedRepo);
  const r = await W.mergePR({ token, repo: resolvedRepo, prNumber, mergeMethod });

  await sb.from("founder_alerts").insert({
    level: "info",
    source: "code_writer",
    title: `PR #${prNumber} merged in ${resolvedRepo}`,
    body: `Merged via ${mergeMethod || "squash"}. SHA: ${r.sha}`,
    context: { repo: resolvedRepo, pr_number: prNumber, sha: r.sha, merged: r.merged },
  });

  return { ok: true, result: { repo: resolvedRepo, pr_number: prNumber, merged: r.merged, sha: r.sha } };
}

module.exports = {
  github_read_file,
  github_list_files,
  github_create_branch,
  github_apply_patch,
  github_create_pr,
  github_merge_pr,
};
