// api/health.js — quick read-only status. Not gated; returns no secrets.
import { supabase } from "../lib/supabase.js";

export default async function handler(req, res) {
  try {
    const [
      pending, processing, dead, dlq, lastRun, ws, wv,
    ] = await Promise.all([
      supabase.from("tasks").select("id", { count: "exact", head: true }).eq("state", "pending"),
      supabase.from("tasks").select("id", { count: "exact", head: true }).eq("state", "processing"),
      supabase.from("tasks").select("id", { count: "exact", head: true }).eq("state", "dead"),
      supabase.from("dead_letter_queue").select("id", { count: "exact", head: true }).eq("resolved", false),
      supabase.from("worker_runs").select("id, started_at, completed_at, status, tasks_processed, tasks_failed").order("started_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("system_state").select("value").eq("key", "worker_enabled").maybeSingle(),
      supabase.from("system_state").select("value").eq("key", "worker_version").maybeSingle(),
    ]);

    return res.status(200).json({
      ok: true,
      worker_enabled: ws?.data?.value ?? null,
      worker_version: wv?.data?.value ?? null,
      counts: {
        pending:    pending.count ?? null,
        processing: processing.count ?? null,
        dead:       dead.count ?? null,
        dlq_open:   dlq.count ?? null,
      },
      last_run: lastRun?.data ?? null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
