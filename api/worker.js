// api/worker.js — invoked by Vercel Cron every minute.
//
// Drains up to BATCH_SIZE tasks per invocation using the atomic
// claim_next_task RPC (FOR UPDATE SKIP LOCKED).
//
// Each task transitions through:
//   pending → processing (claim) → completed | pending (retry) | dead (DLQ)
//
// All terminal transitions go through the fail_task / complete_task RPCs
// to keep the state machine in one place.

import { supabase, audit, alert } from "../lib/supabase.js";
import { requireWorkerAuth } from "../lib/auth.js";
import { dispatch } from "../lib/handlers.js";

const WORKER_ID         = `vercel-${process.env.VERCEL_REGION || "unknown"}-${process.env.VERCEL_DEPLOYMENT_ID?.slice(0, 8) || "local"}`;
const LOCK_SECONDS      = parseInt(process.env.WORKER_LOCK_SECONDS  || "300", 10);
const BATCH_SIZE        = parseInt(process.env.WORKER_BATCH_SIZE    || "5",   10);
const MAX_RUNTIME_MS    = parseInt(process.env.WORKER_MAX_RUNTIME_MS || "50000", 10); // < Vercel 60s
const RETRY_BACKOFF_SEC = parseInt(process.env.WORKER_RETRY_BACKOFF_SEC || "30", 10);

export default async function handler(req, res) {
  if (!requireWorkerAuth(req, res)) return;

  // Worker-enabled kill switch
  const { data: enabled } = await supabase
    .from("system_state").select("value").eq("key", "worker_enabled").maybeSingle();
  if (enabled?.value === false) {
    return res.status(200).json({ ok: true, skipped: "worker_enabled=false" });
  }

  // Self-heal: close any 'running' worker_runs older than 2 minutes
  await supabase.rpc("close_stale_worker_runs", { p_max_age_seconds: 120 });

  // Soft single-flight: if another fresh run is active, skip this tick.
  // (Vercel cron occasionally double-fires; this is the cheap guard.)
  const { count: activeCount } = await supabase
    .from("worker_runs")
    .select("id", { count: "exact", head: true })
    .eq("status", "running");
  if ((activeCount ?? 0) > 0) {
    return res.status(200).json({ ok: true, skipped: "another worker run active" });
  }

  // Open this run's row
  const { data: runRow, error: runErr } = await supabase
    .from("worker_runs")
    .insert({ status: "running" })
    .select("id")
    .single();

  if (runErr) {
    return res.status(200).json({ ok: true, skipped: "failed to open worker_run", detail: runErr.message });
  }
  const runId = runRow.id;

  const startMs = Date.now();
  let processed = 0, failed = 0, claimed = 0;
  const summary = [];

  try {
    for (let i = 0; i < BATCH_SIZE; i++) {
      if (Date.now() - startMs > MAX_RUNTIME_MS) break;

      const { data: claims, error: claimErr } = await supabase.rpc("claim_next_task", {
        p_worker_id: WORKER_ID,
        p_lock_seconds: LOCK_SECONDS,
      });

      if (claimErr) {
        await alert({
          level: "error", source: "worker", title: "claim_next_task RPC failed",
          body: claimErr.message, context: { worker_id: WORKER_ID, run_id: runId },
        });
        break;
      }
      if (!claims || claims.length === 0) break;

      const task = claims[0];
      claimed++;

      const r = await dispatch(task);

      if (r.ok) {
        const { error: cErr } = await supabase.rpc("complete_task", {
          p_task_id: task.id,
          p_result:  r.result ?? null,
        });
        if (cErr) {
          // complete_task should not fail; if it does, log + continue
          await alert({
            level: "error", source: "worker", title: "complete_task RPC failed",
            body: cErr.message, context: { task_id: task.id, run_id: runId },
          });
          failed++;
        } else {
          processed++;
          await audit({
            task_id: task.id, agent_name: WORKER_ID,
            action: task.action, detail: "completed",
          });
          summary.push({ id: task.id, action: task.action, status: "completed" });
        }
      } else {
        // For non-retryable failures, set max_attempts = current attempts so
        // fail_task transitions straight to 'dead' + DLQ insert. The DB-side
        // claim_next_task already incremented attempts, so this is a clean
        // single-row UPDATE with no race against the worker (we hold no lock
        // in app code; the row's locked_by = WORKER_ID gates other workers).
        if (r.retryable === false) {
          await supabase
            .from("tasks")
            .update({ max_attempts: task.attempts || 1 })
            .eq("id", task.id);
        }

        const { data: newState, error: fErr } = await supabase.rpc("fail_task", {
          p_task_id: task.id,
          p_error:   (r.error || "unknown error").slice(0, 1000),
          p_backoff_seconds: RETRY_BACKOFF_SEC,
        });
        if (fErr) {
          await alert({
            level: "error", source: "worker", title: "fail_task RPC failed",
            body: fErr.message, context: { task_id: task.id, run_id: runId },
          });
        }
        failed++;
        await audit({
          task_id: task.id, agent_name: WORKER_ID,
          action: task.action,
          detail: `failed (${newState ?? "?"}): ${r.error}`,
        });
        summary.push({ id: task.id, action: task.action, status: newState ?? "failed", error: r.error });
      }
    }

    await supabase
      .from("worker_runs")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        tasks_processed: processed,
        tasks_failed: failed,
      })
      .eq("id", runId);

    return res.status(200).json({
      ok: true, run_id: runId, worker_id: WORKER_ID,
      claimed, processed, failed, summary,
    });

  } catch (e) {
    const msg = e?.message || String(e);
    await supabase
      .from("worker_runs")
      .update({ status: "errored", completed_at: new Date().toISOString(), error: msg })
      .eq("id", runId);
    await alert({
      level: "critical", source: "worker", title: "worker crashed",
      body: msg, context: { run_id: runId, worker_id: WORKER_ID },
    });
    return res.status(500).json({ ok: false, error: msg, run_id: runId });
  }
}
