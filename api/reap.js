// api/reap.js — invoked every 5 minutes by Vercel Cron.
// Resets/DLQs tasks that have been 'processing' beyond the lock TTL.

import { supabase, alert } from "../lib/supabase.js";
import { requireWorkerAuth } from "../lib/auth.js";

export default async function handler(req, res) {
  if (!requireWorkerAuth(req, res)) return;

  const ttl = parseInt(process.env.WORKER_LOCK_SECONDS || "300", 10);

  const { data, error } = await supabase.rpc("reap_stuck_tasks", { p_ttl_seconds: ttl });

  if (error) {
    await alert({
      level: "error", source: "reaper", title: "reap_stuck_tasks RPC failed",
      body: error.message,
    });
    return res.status(500).json({ ok: false, error: error.message });
  }

  const reaped = typeof data === "number" ? data : 0;
  if (reaped > 0) {
    await alert({
      level: "warn", source: "reaper",
      title: `reaped ${reaped} stuck task(s)`,
      body: `Tasks held the processing lock past ${ttl}s.`,
    });
  }

  return res.status(200).json({ ok: true, reaped });
}
