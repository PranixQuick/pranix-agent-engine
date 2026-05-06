// lib/clients/github_writer.js — ESM
// Adds write capabilities (read-file/list/branch/patch/PR/merge) on top of the
// existing read-only github.js client. Matches the engine's import conventions:
//   - ESM (import/export)
//   - Token resolved per-call by handler from project_registry.github_token_env
//
// Endpoints used:
//   GET  /repos/{owner}/{repo}/contents/{path}
//   GET  /repos/{owner}/{repo}                          (default branch)
//   GET  /repos/{owner}/{repo}/git/ref/heads/{branch}   (head sha)
//   POST /repos/{owner}/{repo}/git/refs                 (create branch)
//   PUT  /repos/{owner}/{repo}/contents/{path}          (commit file)
//   POST /repos/{owner}/{repo}/pulls                    (open PR)
//   PUT  /repos/{owner}/{repo}/pulls/{n}/merge          (merge PR)

const API = "https://api.github.com";

function ghHeaders(token) {
  if (!token) throw new Error("github token required");
  return {
    "authorization":        `Bearer ${token}`,
    "accept":               "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent":           "pranix-agent-engine",
    "content-type":         "application/json",
  };
}

async function ghFetch(token, path, opts = {}) {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { ...ghHeaders(token), ...(opts.headers || {}) } });
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

export async function readFile({ token, repo, path, ref = "HEAD" }) {
  const data = await ghFetch(token, `/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`);
  if (Array.isArray(data)) throw new Error(`Path is a directory: ${path}`);
  const content = data.encoding === "base64"
    ? Buffer.from(data.content, "base64").toString("utf-8")
    : data.content;
  return { content, sha: data.sha, encoding: data.encoding, size: data.size };
}

export async function listFiles({ token, repo, path = "", ref = "HEAD" }) {
  const data = await ghFetch(token, `/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`);
  if (!Array.isArray(data)) return [{ name: data.name, path: data.path, type: data.type, size: data.size }];
  return data.map(d => ({ name: d.name, path: d.path, type: d.type, size: d.size }));
}

export async function getDefaultBranch({ token, repo }) {
  const r = await ghFetch(token, `/repos/${repo}`);
  const branchName = r.default_branch;
  const ref = await ghFetch(token, `/repos/${repo}/git/ref/heads/${branchName}`);
  return { branch: branchName, sha: ref.object.sha };
}

export async function createBranch({ token, repo, branchName, baseSha = null }) {
  if (!baseSha) {
    const base = await getDefaultBranch({ token, repo });
    baseSha = base.sha;
  }
  return ghFetch(token, `/repos/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  });
}

export async function applyFilePatch({ token, repo, branch, path, content, message, existingSha = null }) {
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

export async function createPR({ token, repo, head, base = null, title, body }) {
  if (!base) {
    const def = await getDefaultBranch({ token, repo });
    base = def.branch;
  }
  return ghFetch(token, `/repos/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, head, base, body, draft: false, maintainer_can_modify: true }),
  });
}

export async function mergePR({ token, repo, prNumber, mergeMethod = "squash" }) {
  return ghFetch(token, `/repos/${repo}/pulls/${prNumber}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: mergeMethod }),
  });
}
