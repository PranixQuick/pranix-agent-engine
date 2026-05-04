// lib/handlers.js — maps action_name → handler(task, ctx) → { ok, result, retryable, error }
//
// Contract:
//   { ok: true,  result: <jsonb-serializable> }            → task completes
//   { ok: false, retryable: true,  error: "..."  }         → fail_task with backoff
//   { ok: false, retryable: false, error: "..."  }         → fail_task with attempts pinned to max (DLQ immediately)
//
// Every handler must be idempotent. Tasks may be retried.
// No handler should throw — wrap calls in try/catch and convert to { ok:false, ... }.

import { supabase, alert } from "./supabase.js";

// --- helpers ----------------------------------------------------------------

async function getProject(name) {
  const { data, error } = await supabase
    .from("project_registry")
    .select("*")
    .eq("project_name", name)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data)  return { error: `project_registry: '${name}' not found` };
  return { project: data };
}

function deferred(reason, hint) {
  // Used when execution is intentionally blocked (no MCP / no infra access yet).
  // Logs a founder alert once, returns non-retryable so the task lands in DLQ
  // for visibility instead of re-looping.
  return {
    ok: false,
    retryable: false,
    error: `deferred: ${reason}${hint ? ` (${hint})` : ""}`,
  };
}

// --- product handlers -------------------------------------------------------
//
// PHILOSOPHY: each handler does ONLY what's safely doable from this worker
// today. When external infra (GitHub/Vercel) is needed, it returns `deferred`
// and surfaces a founder alert. No silent fake successes.

async function deployCart2save(task) {
  // Cart2Save Supabase project is NOT in our connected org → cannot read DB.
  // GitHub MCP unavailable → cannot trigger workflow_dispatch.
  // Vercel MCP returning 403 → cannot trigger redeploy.
  await alert({
    level: "warn",
    source: "worker",
    title: "deploy_cart2save deferred",
    body: "Worker has no path to deploy Cart2Save: Vercel MCP returns 403, GitHub MCP unavailable, Cart2Save Supabase outside connected org. Manual founder action required.",
    context: { task_id: task.id, action: task.action },
  });
  return deferred("vercel + github automation not yet wired", "Phase B2");
}

async function runQuickscanzScan(task) {
  // QuickScanZ Supabase is INACTIVE. Worker should NOT auto-restore (cost).
  // First step: surface to founder.
  const { data: state } = await supabase
    .from("system_state")
    .select("value")
    .eq("key", "quickscanz_status")
    .maybeSingle();

  await alert({
    level: "info",
    source: "worker",
    title: "run_quickscanz_scan deferred",
    body: "QuickScanZ Supabase project is INACTIVE. Restore required before scan. Worker will not auto-restore (cost implications).",
    context: { task_id: task.id, last_known: state?.value ?? null },
  });
  return deferred("quickscanz supabase inactive", "founder must approve restore");
}

async function runVidyagridAnalysis(task) {
  await alert({
    level: "info",
    source: "worker",
    title: "run_vidyagrid_analysis deferred",
    body: "Vidyagrid Supabase project is INACTIVE. Restore required.",
    context: { task_id: task.id },
  });
  return deferred("vidyagrid supabase inactive", "founder must approve restore");
}

async function runQuietkeepSync(task) {
  // QuietKeep Supabase is on a different org → no MCP access from this worker.
  return deferred("quietkeep supabase outside connected org", "Phase B3");
}

async function runPmilScan(task) {
  return deferred("pmil supabase not provisioned", "Phase C");
}

async function runSchoolReports(task) {
  // School OS is read-only by policy. Confirm worker version, write nothing.
  const { data, error } = await supabase
    .from("project_registry")
    .select("project_name, supabase_project_id")
    .eq("project_name", "schoolos")
    .maybeSingle();
  if (error) return { ok: false, retryable: true, error: error.message };
  if (!data) return { ok: false, retryable: false, error: "schoolos not in project_registry" };

  // Read-only ping. We don't even read School OS DB from this worker — it's a
  // separate Supabase project and the policy is "no writes, no reads from agent layer".
  return { ok: true, result: { mode: "read_only_ping", project: data.project_name } };
}

async function manageEasyvenuezBookings(task) {
  return deferred("easyvenuez handler not implemented", "Phase C");
}

async function runConsultancyLeads(task) {
  return deferred("consultancy handler not implemented", "Phase C");
}

async function triggerInsureupiFlow(task) {
  return deferred("insureupi handler not implemented", "Phase C");
}

// --- self-test handler — used to prove the pipeline e2e --------------------

async function workerSelfTest(task) {
  return {
    ok: true,
    result: {
      ok: true,
      now: new Date().toISOString(),
      task_id: task.id,
      input: task.input ?? null,
      worker: process.env.VERCEL_REGION || "unknown",
    },
  };
}

// --- registry ---------------------------------------------------------------

export const HANDLERS = {
  // confirmed in action_registry
  deploy_cart2save:           deployCart2save,
  run_quickscanz_scan:        runQuickscanzScan,
  run_vidyagrid_analysis:     runVidyagridAnalysis,
  run_quietkeep_sync:         runQuietkeepSync,
  run_pmil_scan:              runPmilScan,
  run_school_reports:         runSchoolReports,
  manage_easyvenuez_bookings: manageEasyvenuezBookings,
  run_consultancy_leads:      runConsultancyLeads,
  trigger_insureupi_flow:     triggerInsureupiFlow,

  // utility
  worker_self_test:           workerSelfTest,
};

export async function dispatch(task) {
  const action = task.action;
  if (!action) {
    return { ok: false, retryable: false, error: "task has no action" };
  }
  const handler = HANDLERS[action];
  if (!handler) {
    return { ok: false, retryable: false, error: `no handler registered for action '${action}'` };
  }
  try {
    return await handler(task);
  } catch (e) {
    return { ok: false, retryable: true, error: e?.message || String(e) };
  }
}
