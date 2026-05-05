// lib/clients/github_writer.js
// Adds write capabilities on top of the existing GitHub client.
// Uses the per-product token resolver (GITHUB_PAT or GITHUB_SECONDARY_PAT)
// already wired through project_registry.github_token_env.

const { resolveGithubToken } = require("../registry");

const GH = "https://api.github.com";

async function ghFetch(token, path, opts = {}) {
  const r = await fetch(`${GH}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) {
    const err = new Error(`GitHub ${opts.method || "GET"} ${path} → ${r.status}`);
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body;
}

// Get token for a product. Returns { token, env_name } or { error }.
function getToken(productName, project) {
  const res = resolveGithubToken(project);
  if (res.error) return { error: res.error };
  return { token: res.token, env_name: res.env_name };
}

// Read a single file (returns { content, sha, encoding })
async function readFile({ token, repo, path, ref = "HEAD" }) {
  const data = await ghFetch(token, `/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`);
  if (Array.isArray(data)) throw new Error(`Path is a directory: ${path}`);
  const content = data.encoding === "base64"
    ? Buffer.from(data.content, "base64").toString("utf-8")
    : data.content;
  return { content, sha: data.sha, encoding: data.encoding, size: data.size };
}

// List files in a directory
async function listFiles({ token, repo, path = "", ref = "HEAD" }) {
  const data = await ghFetch(token, `/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`);
  if (!Array.isArray(data)) return [{ name: data.name, path: data.path, type: data.type, size: data.size }];
  return data.map(d => ({ name: d.name, path: d.path, type: d.type, size: d.size }));
}

// Get default branch + its head SHA
async function getDefaultBranch({ token, repo }) {
  const r = await ghFetch(token, `/repos/${repo}`);
  const branchName = r.default_branch;
  const ref = await ghFetch(token, `/repos/${repo}/git/ref/heads/${branchName}`);
  return { branch: branchName, sha: ref.object.sha };
}

// Create a new branch from base (default branch if base not provided)
async function createBranch({ token, repo, branchName, baseSha = null }) {
  if (!baseSha) {
    const base = await getDefaultBranch({ token, repo });
    baseSha = base.sha;
  }
  return ghFetch(token, `/repos/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  });
}

// Apply a single-file patch on a branch (full-file replace; for diffs, transform externally)
async function applyFilePatch({ token, repo, branch, path, content, message, existingSha = null }) {
  // If existingSha not provided, fetch it (PUT requires sha when updating an existing file)
  if (!existingSha) {
    try {
      const cur = await readFile({ token, repo, path, ref: branch });
      existingSha = cur.sha;
    } catch (e) {
      if (e.status !== 404) throw e;
      existingSha = null;
    }
  }
  const body = {
    message,
    content: Buffer.from(content, "utf-8").toString("base64"),
    branch,
  };
  if (existingSha) body.sha = existingSha;
  return ghFetch(token, `/repos/${repo}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

// Open a pull request
async function createPR({ token, repo, head, base = null, title, body }) {
  if (!base) {
    const def = await getDefaultBranch({ token, repo });
    base = def.branch;
  }
  return ghFetch(token, `/repos/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, head, base, body, draft: false, maintainer_can_modify: true }),
  });
}

// Merge a PR (rarely automated — usually founder approves via dashboard)
async function mergePR({ token, repo, prNumber, mergeMethod = "squash" }) {
  return ghFetch(token, `/repos/${repo}/pulls/${prNumber}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: mergeMethod }),
  });
}

module.exports = {
  getToken,
  readFile,
  listFiles,
  getDefaultBranch,
  createBranch,
  applyFilePatch,
  createPR,
  mergePR,
};
