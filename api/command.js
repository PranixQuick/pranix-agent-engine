// api/command.js — founder command entry point.
//
// POST /api/command   Authorization: Bearer $WORKER_SECRET
// Body: { "text": "audit all startups", "skip_approval"?: false }
//
// This endpoint enqueues a 'route_founder_command' task and returns immediately.
// The worker drains the task, parses intent, plans, and (depending on approval)
// either fans out execution OR writes a founder_alert with an approval link.

import { supabase } from "../lib/supabase.js";
import { isAuthorizedManualCall } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  if (!isAuthorizedManualCall(req)) return res.status(401).json({ ok: false, error: "unauthorized" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ ok: false, error: "invalid json" }); }
  }
  body = body || {};

  const text = body.text;
  if (!text || typeof text !== "string" || text.length < 3) {
    return res.status(400).json({ ok: false, error: "body.text required (min 3 chars)" });
  }
  if (text.length > 2000) {
    return res.status(400).json({ ok: false, error: "body.text too long (max 2000 chars)" });
  }

  const skip_approval = body.skip_approval === true;

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      action: "route_founder_command",
      input: { text, skip_approval },
      state: "pending",
      priority: 2,
      max_attempts: 2,
    })
    .select("id")
    .single();

  if (error) return res.status(500).json({ ok: false, error: error.message });

  return res.status(202).json({
    ok: true,
    accepted: true,
    routing_task_id: data.id,
    note: "Command accepted. Within ~1 minute the worker will parse intent, plan actions, and either execute (if no approval needed) or send a founder_alert with an approval link.",
  });
}
