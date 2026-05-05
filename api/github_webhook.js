// api/github_webhook.js
// Receives GitHub events: push, workflow_run, deployment_status, pull_request
// Verifies HMAC-SHA256 signature against GITHUB_WEBHOOK_SECRET in env.
// Writes to: github_runs, founder_alerts.

const crypto = require("crypto");
const { sb } = require("../lib/supabase");

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const sig = signatureHeader.replace(/^sha256=/, "");
  const hmac = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(sig));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method not allowed" });

  // Vercel parses JSON before us; we need raw body for HMAC verification.
  // The pranix-agent-engine uses Next-style API routes — wire raw-body handling:
  const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);

  const event   = req.headers["x-github-event"];
  const sigHdr  = req.headers["x-hub-signature-256"];
  const secret  = process.env.GITHUB_WEBHOOK_SECRET;

  if (!verifySignature(rawBody, sigHdr, secret)) {
    return res.status(401).json({ ok: false, error: "invalid signature" });
  }

  const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const repoFull = payload?.repository?.full_name;

  try {
    switch (event) {
      case "push": {
        await sb.from("founder_alerts").insert({
          level: "info",
          source: "github:push",
          title: `${repoFull}: push to ${payload.ref?.replace("refs/heads/", "")} by ${payload.pusher?.name}`,
          body: payload.head_commit?.message?.slice(0, 280),
          context: { repo: repoFull, ref: payload.ref, head_sha: payload.after, commits: payload.commits?.length },
        });
        break;
      }
      case "workflow_run": {
        const wr = payload.workflow_run;
        await sb.from("github_runs").upsert({
          repo: repoFull,
          workflow_id: String(wr.workflow_id),
          ref: wr.head_branch,
          github_run_id: wr.id,
          status: wr.status,
          conclusion: wr.conclusion,
          raw: wr,
        }, { onConflict: "github_run_id" });

        if (wr.conclusion === "failure") {
          await sb.from("founder_alerts").insert({
            level: "error",
            source: "github:workflow_run",
            title: `${repoFull}: workflow "${wr.name}" failed`,
            body: wr.html_url,
            context: { repo: repoFull, workflow: wr.name, run_id: wr.id, html_url: wr.html_url },
          });
        }
        break;
      }
      case "deployment_status": {
        const ds = payload.deployment_status;
        if (ds.state === "failure" || ds.state === "error") {
          await sb.from("founder_alerts").insert({
            level: "error",
            source: "github:deployment_status",
            title: `${repoFull}: deployment ${ds.state}`,
            body: ds.description?.slice(0, 280) || ds.target_url,
            context: { repo: repoFull, state: ds.state, target_url: ds.target_url, environment: payload.deployment?.environment },
          });
        }
        break;
      }
      case "pull_request": {
        if (payload.action === "opened" || payload.action === "closed" || payload.action === "reopened") {
          await sb.from("founder_alerts").insert({
            level: "info",
            source: "github:pull_request",
            title: `${repoFull}: PR #${payload.number} ${payload.action}`,
            body: payload.pull_request?.title,
            context: { repo: repoFull, pr_number: payload.number, action: payload.action, html_url: payload.pull_request?.html_url, merged: payload.pull_request?.merged },
          });
        }
        break;
      }
      case "ping":
        return res.status(200).json({ ok: true, pong: true });
      default:
        // Unhandled events get a 200 — GitHub will mark webhook as healthy.
        break;
    }
    return res.status(200).json({ ok: true, event });
  } catch (e) {
    console.error("github_webhook error", e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

// Vercel: ensure raw body is preserved for HMAC verification
module.exports.config = {
  api: { bodyParser: { raw: true, sizeLimit: "1mb" } },
};
