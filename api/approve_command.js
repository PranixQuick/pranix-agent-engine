// api/approve_command.js — single-click approval for a pending command.
//
// GET /api/approve_command?id=<command_id>&token=<token>[&approver=<name>]
//
// Auth model: the token is a per-command random value generated when the
// command was put into 'pending_approval' state. Possession of that token is
// the approval credential. The DB-side RPC validates token + state in one
// transaction, so replays are no-ops.

import { supabase } from "../lib/supabase.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "GET or POST only" });
  }

  const id       = req.query?.id      || (req.body && JSON.parse(req.body || "{}")?.id);
  const token    = req.query?.token   || (req.body && JSON.parse(req.body || "{}")?.token);
  const approver = req.query?.approver || (req.body && JSON.parse(req.body || "{}")?.approver) || "founder";

  if (!id || !token) return res.status(400).json({ ok: false, error: "id and token required" });

  // Validate id is a uuid
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ ok: false, error: "invalid id" });
  }

  const { data, error } = await supabase.rpc("approve_command_invocation", {
    p_id: id, p_token: token, p_approver: approver,
  });
  if (error) return res.status(500).json({ ok: false, error: error.message });

  if (data === "ok") {
    // Enqueue the executor task now that we're approved
    const { data: execTask, error: execErr } = await supabase
      .from("tasks")
      .insert({
        action: "execute_command_plan",
        input: { command_id: id },
        state: "pending",
        priority: 3,
        idempotency_key: `cmd_exec_${id}`,
        max_attempts: 2,
      })
      .select("id")
      .single();

    if (execErr && execErr.code !== "23505") {
      return res.status(500).json({ ok: false, error: `approved but executor enqueue failed: ${execErr.message}` });
    }
    return res.status(200).json({
      ok: true,
      command_id: id,
      executor_task_id: execTask?.id ?? null,
      approver,
      note: "Approved. Worker will drain the planned actions within ~60s.",
    });
  }

  // RPC returns specific error strings
  const msg = String(data || "unknown");
  const status = msg === "not_found" ? 404
              : msg === "token_mismatch" ? 403
              : msg.startsWith("invalid_state") ? 409
              : 400;
  return res.status(status).json({ ok: false, reason: msg });
}
