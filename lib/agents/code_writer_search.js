// lib/agents/code_writer_search.js — ESM
// Adds grep_repo to code_writer. Lives in a separate file so the existing
// code_writer.js stays untouched (lower diff risk).
//
// Strategy:
//   1) Use GitHub's Code Search API on a single repo: /search/code?q=<pattern>+repo:<owner>/<repo>
//   2) For each hit, fetch the file content (only the matching paths)
//   3) Find matching lines locally with the regex pattern
//   4) Return { repo, pattern, total_hits, matches: [{ path, line, snippet }, ... ] }
//
// Notes / limits:
//   - GitHub Code Search requires authentication (works with our PATs)
//   - Max 30 results per page; we paginate up to max_pages (default 3 = 90 hits)
//   - Search index can be slightly stale on very recently pushed commits
//
// Token routing matches code_writer: by repo owner.

import { supabase } from "../supabase.js";

function tokenForRepo(repo) {
  const owner = repo.split("/")[0]?.toLowerCase();
  if (owner === "prashanthrangineni-sketch") {
    if (!process.env.GITHUB_SECONDARY_PAT) throw new Error("GITHUB_SECONDARY_PAT not set");
    return process.env.GITHUB_SECONDARY_PAT;
  }
  if (!process.env.GITHUB_PAT) throw new Error("GITHUB_PAT not set");
  return process.env.GITHUB_PAT;
}

async function ghFetch(token, path) {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "pranix-agent-engine",
    },
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) {
    const e = new Error(`GitHub ${path} → ${r.status}`);
    e.status = r.status; e.body = body;
    throw e;
  }
  return body;
}

async function resolveRepo(input) {
  const { product_name, repo } = input || {};
  if (repo) return repo;
  if (!product_name) throw new Error("Need repo or product_name");
  const { data, error } = await supabase.from("project_registry")
    .select("github_repo").eq("project_name", product_name).maybeSingle();
  if (error) throw new Error(`project_registry: ${error.message}`);
  if (!data?.github_repo) throw new Error(`No github_repo for ${product_name}`);
  return data.github_repo;
}

function safeError(e) {
  const status = e?.status;
  if (status && status >= 400 && status < 500 && status !== 429) {
    return { ok: false, retryable: false, error: `${e.message}${e.body?.message ? " — " + e.body.message : ""}` };
  }
  return { ok: false, retryable: true, error: e?.message || String(e) };
}

export async function grep_repo(task) {
  try {
    const input = task.input || {};
    const repo = await resolveRepo(input);
    const pattern = input.pattern;
    if (!pattern) return { ok: false, retryable: false, error: "pattern is required" };

    const maxPages = Math.min(input.max_pages || 3, 5);
    const pathFilter = input.path;
    const extFilter = input.extension;
    const includeContext = input.include_context !== false;

    const token = tokenForRepo(repo);
    let allItems = [];
    for (let page = 1; page <= maxPages; page++) {
      let q = `${pattern} repo:${repo}`;
      if (pathFilter) q += ` path:${pathFilter}`;
      if (extFilter)  q += ` extension:${extFilter}`;
      const r = await ghFetch(token, `/search/code?q=${encodeURIComponent(q)}&per_page=30&page=${page}`);
      const items = r.items || [];
      allItems = allItems.concat(items);
      if (items.length < 30) break;
    }

    const matches = [];
    if (includeContext && allItems.length > 0) {
      const top = allItems.slice(0, 20);
      const re = new RegExp(pattern, "gm");
      for (const it of top) {
        try {
          const fileResp = await ghFetch(token, `/repos/${repo}/contents/${encodeURIComponent(it.path)}?ref=${encodeURIComponent(input.ref || "HEAD")}`);
          const content = fileResp.encoding === "base64"
            ? Buffer.from(fileResp.content, "base64").toString("utf-8")
            : fileResp.content;
          const lines = content.split("\n");
          const fileMatches = [];
          for (let i = 0; i < lines.length; i++) {
            re.lastIndex = 0;
            if (re.test(lines[i])) {
              fileMatches.push({ line: i + 1, text: lines[i].slice(0, 200) });
              if (fileMatches.length >= 5) break;
            }
          }
          matches.push({ path: it.path, lines: fileMatches });
        } catch (e) {
          matches.push({ path: it.path, error: e.message });
        }
      }
    }

    return {
      ok: true,
      result: {
        repo, pattern,
        total_hits: allItems.length,
        files_with_matches: includeContext ? matches.length : allItems.length,
        paths: allItems.map(i => i.path),
        matches: includeContext ? matches : null,
      },
    };
  } catch (e) { return safeError(e); }
}
