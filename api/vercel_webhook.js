// api/vercel_webhook.js — HARDENED v2
// Same hardening as github_webhook v2:
//   - Raw body read correctly (was using JSON.stringify which broke HMAC).
//   - Unknown events → 200 ignored:true.
//   - Every payload field deref guarded.
//   - Errors logged but never bubble as 500 (Vercel will retry).
//   - Unique constraint on deployments.vercel_deployment_id was added so
//     the upsert with onConflict actually succeeds.

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

async function readRawBody(req) {
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
  return JSON.stringify(req.body || {});
}

function verifyVercelSig(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  // Vercel signs with HMAC-SHA1 (legacy) — header is just the hex digest.
  const expected = crypto.createHmac("sha1", secret).update(rawBody).digest("hex");
  if (sigHeader.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

const ALERT_FOR = {
  "deployment.error":     { level: "error", word: "FAILED" },
  "deployment.canceled":  { level: "warn",  word: "canceled" },
  "deployment.succeeded": { level: "info",  word: "succeeded" },
  "deployment.promoted":  { level: "info",  word: "promoted to production" },
  "deployment.rollback":  { level: "warn",  word: "rolled back" },
};

async function safeInsertAlert(row) {
  try { await sb.from("founder_alerts").insert(row); }
  catch (e) { console.error("founder_alerts insert failed:", e?.message || e); }
}

async function safeUpsertDeployment(row) {
  try {
    const { error } = await sb.from("deployments")
      .upsert(row, { onConflict: "vercel_deployment_id" });
    if (error) console.error("deployments upsert error:", error.message);
  } catch (e) {
    console.error("deployments upsert threw:", e?.message || e);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method not allowed" });

  let rawBody;
  try { rawBody = await readRawBody(req); }
  catch { return res.status(400).json({ ok: false, error: "could not read body" }); }

  const sig    = req.headers["x-vercel-signature"];
  const secret = process.env.VERCEL_WEBHOOK_SECRET;

  if (!verifyVercelSig(rawBody, sig, secret)) {
    return res.status(401).json({ ok: false, error: "invalid signature" });
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return res.status(400).json({ ok: false, error: "invalid json" }); }

  const type    = payload?.type;
  const dep     = payload?.payload?.deployment;
  const project = payload?.payload?.project;

  if (!type) return res.status(200).json({ ok: true, ignored: true, reason: "no type" });
  if (!dep)  return res.status(200).json({ ok: true, ignored: true, reason: "no deployment in payload" });

  try {
    let internalName = "unknown";
    if (project?.id) {
      const { data: reg } = await sb.from("project_registry")
        .select("project_name")
        .eq("vercel_project_id", project.id)
        .maybeSingle();
      internalName = reg?.project_name || project?.name || "unknown";
    }

    if (dep.id) {
      await safeUpsertDeployment({
        project_name: internalName,
        vercel_project_id: project?.id || "unknown",
        vercel_deployment_id: dep.id,
        vercel_url: dep.url || null,
        git_ref: dep.meta?.githubCommitRef || dep.meta?.gitlabCommitRef || dep.meta?.bitbucketCommitRef || null,
        source: "vercel_webhook",
        status: type.replace("deployment.", ""),
        triggered_by: dep.meta?.githubCommitAuthorLogin || dep.creator?.username || null,
        raw: dep,
      });
    }

    const alertSpec = ALERT_FOR[type];
    if (alertSpec) {
      await safeInsertAlert({
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
    console.error("vercel_webhook unhandled error:", e?.stack || e?.message || e);
    return res.status(200).json({ ok: false, swallowed: true, error: String(e?.message || e) });
  }
};

module.exports.config = {
  api: { bodyParser: false },
};
