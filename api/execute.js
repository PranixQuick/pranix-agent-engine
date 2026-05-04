// api/execute.js — manual / external task enqueue.
// POST /api/execute  Authorization: Bearer $WORKER_SECRET
// Body: { action: string, input?: object, priority?: 1..10, idempotency_key?: string }

import { supabase, audit } from "../lib/supabase.js";
import { isAuthorizedManualCall } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }
  if (!isAuthorizedManualCall(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ ok: false, error: "invalid json" }); }
  }
  body = body || {};

  const { action, input, priority, idempotency_key } = body;
  if (!action || typeof action !== "string") {
    return res.status(400).json({ ok: false, error: "action required" });
  }

  // Validate action against action_registry
  const { data: reg, error: regErr } = await supabase
    .from("action_registry")
    .select("action_name, is_active")
    .eq("action_name", action)
    .maybeSingle();
  if (regErr) return res.status(500).json({ ok: false, error: regErr.message });
  if (!reg)        return res.status(400).json({ ok: false, error: `unknown action '${action}'` });
  if (!reg.is_active) return res.status(409).json({ ok: false, error: `action '${action}' is inactive` });

  // Idempotency: if a key is provided and a row exists, return that row.
  if (idempotency_key) {
    const { data: existing } = await supabase
      .from("tasks").select("id, action, state, created_at")
      .eq("idempotency_key", idempotency_key).maybeSingle();
    if (existing) {
      return res.status(200).json({ ok: true, deduped: true, task: existing });
    }
  }

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      action,
      input: input ?? {},
      state: "pending",
      priority: typeof priority === "number" ? priority : 5,
      idempotency_key: idempotency_key ?? null,
    })
    .select("id, action, state, priority, created_at, idempotency_key")
    .single();

  if (error) {
    // Unique violation on idempotency_key → race; fetch and return existing
    if (error.code === "23505" && idempotency_key) {
      const { data: existing } = await supabase
        .from("tasks").select("id, action, state, created_at")
        .eq("idempotency_key", idempotency_key).maybeSingle();
      if (existing) return res.status(200).json({ ok: true, deduped: true, task: existing });
    }
    return res.status(500).json({ ok: false, error: error.message });
  }

  await audit({
    task_id: data.id, agent_name: "execute_endpoint",
    action, detail: `enqueued via POST /api/execute`,
  });

  return res.status(200).json({ ok: true, task: data });
}
