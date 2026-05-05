// api/vercel_webhook.js
// Receives Vercel events: deployment.created, deployment.succeeded, deployment.error, deployment.canceled, deployment.promoted
// Verifies x-vercel-signature against VERCEL_WEBHOOK_SECRET.
// Writes to: deployments, founder_alerts.

const crypto = require("crypto");
const { sb } = require("../lib/supabase");

function verifyVercelSig(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const sig = sigHeader.replace(/^sha1=/, "");
  const hmac = crypto.createHmac("sha1", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(sig));
}

const ALERT_FOR = {
  "deployment.error":     { level: "error", word: "FAILED" },
  "deployment.canceled":  { level: "warn",  word: "canceled" },
  "deployment.succeeded": { level: "info",  word: "succeeded" },
  "deployment.promoted":  { level: "info",  word: "promoted to production" },
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method not allowed" });

  const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const sig     = req.headers["x-vercel-signature"];
  const secret  = process.env.VERCEL_WEBHOOK_SECRET;

  if (!verifyVercelSig(rawBody, sig, secret)) {
    return res.status(401).json({ ok: false, error: "invalid signature" });
  }

  const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const type    = payload.type;
  const dep     = payload.payload?.deployment;
  const project = payload.payload?.project;

  if (!dep) return res.status(200).json({ ok: true, ignored: true });

  try {
    // Look up internal project_name from vercel_project_id
    const { data: reg } = await sb.from("project_registry")
      .select("project_name")
      .eq("vercel_project_id", project?.id)
      .maybeSingle();

    const internalName = reg?.project_name || project?.name || "unknown";

    // Record/update the deployment row
    await sb.from("deployments").upsert({
      project_name: internalName,
      vercel_project_id: project?.id,
      vercel_deployment_id: dep.id,
      vercel_url: dep.url,
      git_ref: dep.meta?.githubCommitRef || dep.meta?.gitlabCommitRef || dep.meta?.bitbucketCommitRef,
      source: "vercel_webhook",
      status: type.replace("deployment.", ""),
      triggered_by: dep.meta?.githubCommitAuthorLogin || dep.creator?.username || null,
      raw: dep,
    }, { onConflict: "vercel_deployment_id" });

    const alertSpec = ALERT_FOR[type];
    if (alertSpec) {
      await sb.from("founder_alerts").insert({
        level: alertSpec.level,
        source: "vercel:" + type,
        title: `${internalName}: deploy ${alertSpec.word}`,
        body: dep.url ? `https://${dep.url}` : null,
        context: {
          project: internalName,
          deployment_id: dep.id,
          state: type,
          inspector_url: dep.inspectorUrl,
          target: dep.target,
        },
      });
    }

    return res.status(200).json({ ok: true, type, project: internalName });
  } catch (e) {
    console.error("vercel_webhook error", e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

module.exports.config = {
  api: { bodyParser: { raw: true, sizeLimit: "1mb" } },
};
