// lib/agents/code_writer.js — ESM
// Handlers for the 6 capabilities registered in agent_capabilities for agent_name='code_writer'.
//
// Dispatch contract (same as all engine handlers, per lib/handlers.js comment):
//   { ok: true,  result: <jsonb> }                 → complete_task
//   { ok: false, retryable: true,  error: "..." }  → fail_task w/ backoff
//   { ok: false, retryable: false, error: "..." }  → fail_task → DLQ
//
// Token resolution: by repo owner.
//   prashanthrangineni-sketch/* → GITHUB_SECONDARY_PAT
//   PranixQuick/*               → GITHUB_PAT
// The secondary PAT covers Account 1 repos (Cart2Save, QuietKeep, website, etc).

import { supabase, alert } from "../supabase.js";
import {
  readFile, listFiles, createBranch, applyFilePatch, createPR, mergePR,
} from "../clients/github_writer.js";

// -------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------

async function resolveRepo({ product_name, repo, role = null }) {
  if (repo) return { repo };

  if (role && product_name) {
    const { data, error } = await supabase
      .from("product_repos")
      .select("github_repo")
      .eq("project_name", product_name).eq("role", role).eq("is_active", true)
      .maybeSingle();
    if (error) throw new Error(`product_repos lookup: ${error.message}`);
    if (!data) throw new Error(`No product_repos row for ${product_name}/${role}`);
    return { repo: data.github_repo };
  }

  if (product_name) {
    const { data, error } = await supabase
      .from("project_registry")
      .select("github_repo")
      .eq("project_name", product_name).maybeSingle();
    if (error) throw new Error(`project_registry lookup: ${error.message}`);
    if (!data?.github_repo) throw new Error(`No github_repo registered for ${product_name}`);
    return { repo: data.github_repo };
  }

  throw new Error("Must provide repo OR product_name (with optional role)");
}

function tokenForRepo(repo) {
  const owner = repo.split("/")[0]?.toLowerCase();
  if (owner === "prashanthrangineni-sketch") {
    if (!process.env.GITHUB_SECONDARY_PAT) throw new Error("GITHUB_SECONDARY_PAT not set");
    return process.env.GITHUB_SECONDARY_PAT;
  }
  if (owner === "pranixquick") {
    if (!process.env.GITHUB_PAT) throw new Error("GITHUB_PAT not set");
    return process.env.GITHUB_PAT;
  }
  // Default to primary
  if (!process.env.GITHUB_PAT) throw new Error("GITHUB_PAT not set");
  return process.env.GITHUB_PAT;
}

function safeError(e) {
  // GitHub HTTP errors carry .status; treat 4xx as non-retryable, 5xx/network as retryable.
  const status = e?.status;
  if (status && status >= 400 && status < 500) {
    return { ok: false, retryable: false, error: `${e.message}${e.body?.message ? " — " + e.body.message : ""}` };
  }
  return { ok: false, retryable: true, error: e?.message || String(e) };
}

// -------------------------------------------------------------------------
// handlers (one per registered action)
// -------------------------------------------------------------------------

export async function github_read_file(task) {
  try {
    const { product_name, repo, role, path, ref } = task.input || {};
    if (!path) return { ok: false, retryable: false, error: "path is required" };
    const { repo: r } = await resolveRepo({ product_name, repo, role });
    const token = tokenForRepo(r);
    const file = await readFile({ token, repo: r, path, ref });
    return { ok: true, result: { repo: r, path, ...file } };
  } catch (e) { return safeError(e); }
}

export async function github_list_files(task) {
  try {
    const { product_name, repo, role, path, ref } = task.input || {};
    const { repo: r } = await resolveRepo({ product_name, repo, role });
    const token = tokenForRepo(r);
    const items = await listFiles({ token, repo: r, path: path || "", ref });
    return { ok: true, result: { repo: r, path: path || "", items } };
  } catch (e) { return safeError(e); }
}

export async function github_create_branch(task) {
  try {
    const { product_name, repo, role, branchName } = task.input || {};
    if (!branchName) return { ok: false, retryable: false, error: "branchName is required" };
    const { repo: r } = await resolveRepo({ product_name, repo, role });
    const token = tokenForRepo(r);
    const created = await createBranch({ token, repo: r, branchName });
    return { ok: true, result: { repo: r, branch: branchName, ref: created.ref } };
  } catch (e) { return safeError(e); }
}

export async function github_apply_patch(task) {
  try {
    const { product_name, repo, role, branch, path, content, message } = task.input || {};
    if (!branch || !path || content == null || !message) {
      return { ok: false, retryable: false, error: "branch, path, content, message all required" };
    }
    const { repo: r } = await resolveRepo({ product_name, repo, role });
    const token = tokenForRepo(r);
    const out = await applyFilePatch({ token, repo: r, branch, path, content, message });
    return { ok: true, result: { repo: r, branch, path, commit_sha: out.commit?.sha, html_url: out.commit?.html_url } };
  } catch (e) { return safeError(e); }
}

export async function github_create_pr(task) {
  try {
    const { product_name, repo, role, head, base, title, body } = task.input || {};
    if (!head || !title) return { ok: false, retryable: false, error: "head and title required" };
    const { repo: r } = await resolveRepo({ product_name, repo, role });
    const token = tokenForRepo(r);
    const pr = await createPR({ token, repo: r, head, base, title, body: body || "" });

    // Surface PR to founder dashboard
    await alert({
      level: "info",
      source: "code_writer",
      title: `PR #${pr.number} opened: ${title}`,
      body: `${r} · ${head} → ${pr.base?.ref || "default"}\n${pr.html_url}`,
      context: { repo: r, pr_number: pr.number, html_url: pr.html_url, head, base: pr.base?.ref },
    });

    return { ok: true, result: { repo: r, pr_number: pr.number, html_url: pr.html_url, head: pr.head.ref, base: pr.base.ref } };
  } catch (e) { return safeError(e); }
}

export async function github_merge_pr(task) {
  try {
    const { product_name, repo, role, prNumber, mergeMethod } = task.input || {};
    if (!prNumber) return { ok: false, retryable: false, error: "prNumber is required" };
    const { repo: r } = await resolveRepo({ product_name, repo, role });
    const token = tokenForRepo(r);
    const out = await mergePR({ token, repo: r, prNumber, mergeMethod });

    await alert({
      level: "info",
      source: "code_writer",
      title: `PR #${prNumber} merged in ${r}`,
      body: `Merged via ${mergeMethod || "squash"}. SHA: ${out.sha}`,
      context: { repo: r, pr_number: prNumber, sha: out.sha, merged: out.merged },
    });

    return { ok: true, result: { repo: r, pr_number: prNumber, merged: out.merged, sha: out.sha } };
  } catch (e) { return safeError(e); }
}
