// api/github_webhook.js — HARDENED v2
// Fixes from v1:
//   - 500 errors on ping, status, deployment_status events (caused by
//     missing null guards + an upsert that failed silently because
//     github_runs lacked a unique constraint on github_run_id).
//   - Raw body now correctly used for HMAC, with a fallback for Vercel
//     when buffer parser is on (signature would mismatch otherwise).
//   - Unknown events return 200 ignored:true (was crashing on 'status').
//   - Every payload field deref guarded.
//   - Signature failures still return 401 but never crash the handler.
//   - Unique constraint on github_runs.github_run_id was added in
//     migration `github_runs_unique_constraint_for_upsert` so the upsert
//     in workflow_run case now actually succeeds.

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Read raw body — necessary for HMAC verification.
// Vercel's default body parser mutates the body, so we re-stringify if needed.
// Configure with `bodyParser: false` (see config below) to get a real Buffer.
async function readRawBody(req) {
  // If bodyParser is disabled, req is a stream
  if (req.body === undefined && typeof req.on === "function") {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf-8");
  if (typeof req.body === "string") return req.body;
  // Last resort: re-stringify. HMAC will fail; that's expected and we report it.
  return JSON.stringify(req.body || {});
}

function verifySignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  // Length-mismatch protection before timingSafeEqual (which throws on mismatch)
  if (sigHeader.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function safeInsertAlert(row) {
  try {
    await sb.from("founder_alerts").insert(row);
  } catch (e) {
    console.error("founder_alerts insert failed:", e?.message || e);
  }
}

async function safeUpsertRun(row) {
  try {
    const { error } = await sb.from("github_runs")
      .upsert(row, { onConflict: "github_run_id" });
    if (error) console.error("github_runs upsert error:", error.message);
  } catch (e) {
    console.error("github_runs upsert threw:", e?.message || e);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method not allowed" });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ ok: false, error: "could not read body" });
  }

  const event  = req.headers["x-github-event"];
  const sigHdr = req.headers["x-hub-signature-256"];
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  // Allow ping events through even when secret-less webhook setups exist.
  // Ping always carries x-github-event: ping. Always 200.
  if (event === "ping") {
    return res.status(200).json({ ok: true, pong: true });
  }

  if (!verifySignature(rawBody, sigHdr, secret)) {
    return res.status(401).json({ ok: false, error: "invalid signature" });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ ok: false, error: "invalid json" });
  }

  const repoFull = payload?.repository?.full_name || "unknown";

  try {
    switch (event) {
      case "push": {
        const ref = payload?.ref?.replace("refs/heads/", "") || "unknown";
        await safeInsertAlert({
          level: "info",
          source: "github:push",
          title: `${repoFull}: push to ${ref} by ${payload?.pusher?.name || "unknown"}`,
          body: payload?.head_commit?.message?.slice(0, 280) || null,
          context: {
            repo: repoFull,
            ref: payload?.ref,
            head_sha: payload?.after,
            commits: payload?.commits?.length || 0,
          },
        });
        break;
      }

      case "workflow_run": {
        const wr = payload?.workflow_run;
        if (!wr?.id) break;
        await safeUpsertRun({
          repo: repoFull,
          workflow_id: String(wr.workflow_id || ""),
          ref: wr.head_branch || "main",
          github_run_id: wr.id,
          status: wr.status || null,
          conclusion: wr.conclusion || null,
          raw: wr,
        });
        if (wr.conclusion === "failure") {
          await safeInsertAlert({
            level: "error",
            source: "github:workflow_run",
            title: `${repoFull}: workflow "${wr.name || "?"}" failed`,
            body: wr.html_url || null,
            context: { repo: repoFull, workflow: wr.name, run_id: wr.id, html_url: wr.html_url },
          });
        }
        break;
      }

      case "deployment_status": {
        // GitHub sends deployment_status BOTH at top-level (state) AND nested
        // depending on legacy/new shapes. Guard both.
        const ds = payload?.deployment_status || {};
        const state = ds.state || payload?.state;
        if (state === "failure" || state === "error") {
          await safeInsertAlert({
            level: "error",
            source: "github:deployment_status",
            title: `${repoFull}: deployment ${state}`,
            body: (ds.description || "").slice(0, 280) || ds.target_url || null,
            context: {
              repo: repoFull,
              state,
              target_url: ds.target_url,
              environment: payload?.deployment?.environment,
            },
          });
        }
        break;
      }

      case "status": {
        // Commit status (success/failure/pending). Only alert on failure.
        const state = payload?.state;
        if (state === "failure" || state === "error") {
          await safeInsertAlert({
            level: "warn",
            source: "github:status",
            title: `${repoFull}: commit status ${state} on ${payload?.sha?.slice(0, 7) || "?"}`,
            body: (payload?.description || "").slice(0, 280) || null,
            context: {
              repo: repoFull,
              state,
              context: payload?.context,
              target_url: payload?.target_url,
              sha: payload?.sha,
            },
          });
        }
        break;
      }

      case "pull_request": {
        const action = payload?.action;
        if (["opened", "closed", "reopened"].includes(action)) {
          await safeInsertAlert({
            level: "info",
            source: "github:pull_request",
            title: `${repoFull}: PR #${payload?.number} ${action}`,
            body: payload?.pull_request?.title || null,
            context: {
              repo: repoFull,
              pr_number: payload?.number,
              action,
              html_url: payload?.pull_request?.html_url,
              merged: payload?.pull_request?.merged || false,
            },
          });
        }
        break;
      }

      default:
        return res.status(200).json({ ok: true, ignored: true, event });
    }

    return res.status(200).json({ ok: true, event });
  } catch (e) {
    console.error("github_webhook unhandled error:", e?.stack || e?.message || e);
    // Still 200: webhook providers retry on non-2xx and we've already
    // logged the error. Returning 500 here causes infinite GitHub retries.
    return res.status(200).json({ ok: false, swallowed: true, error: String(e?.message || e) });
  }
};

module.exports.config = {
  api: { bodyParser: false }, // we read raw body ourselves
};
