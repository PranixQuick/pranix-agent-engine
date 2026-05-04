// lib/handlers.js — Phase B2 handler registry.
//
// Contract (unchanged from B1):
//   { ok: true,  result: <jsonb> }                 → complete_task
//   { ok: false, retryable: true,  error: "..." }  → fail_task w/ backoff
//   { ok: false, retryable: false, error: "..." }  → fail_task → DLQ
//
// Idempotency: every handler is safe to retry. Where external side-effects are
// involved, we track them in deployments / github_runs so a retry can resume
// rather than redo.

import { supabase, alert, audit } from "./supabase.js";
import { getProject, PRODUCT_DEPLOY_MAP } from "./registry.js";
import {
  dispatchWorkflow, findRecentDispatchRun, getRunStatus,
} from "./clients/github.js";
import {
  redeployLatest, getDeployment, promoteToProduction,
} from "./clients/vercel.js";

// =========================================================================
// helpers
// =========================================================================

function deferred(reason, hint) {
  return { ok: false, retryable: false, error: `deferred: ${reason}${hint ? ` (${hint})` : ""}` };
}

function envCheck(name) {
  if (!process.env[name]) return `${name} missing in worker env`;
  return null;
}

// Enqueue a follow-up task using the task pipeline itself (for polling).
async function enqueueFollowup({ action, input, parent_task_id, delay_seconds = 30 }) {
  const idempotency_key = `followup_${parent_task_id}_${action}`;
  const available_at = new Date(Date.now() + delay_seconds * 1000).toISOString();

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      action,
      input: { ...input, parent_task_id },
      state: "pending",
      priority: 4,
      available_at,
      idempotency_key,
      max_attempts: 20,    // poll tasks may legitimately retry many times
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      // already enqueued; that's fine
      return { ok: true, deduped: true };
    }
    return { ok: false, error: error.message };
  }
  return { ok: true, id: data.id };
}

// =========================================================================
// SELF-TEST
// =========================================================================

async function workerSelfTest(task) {
  return {
    ok: true,
    result: {
      ok: true,
      now: new Date().toISOString(),
      task_id: task.id,
      input: task.input ?? null,
      worker: process.env.VERCEL_REGION || "unknown",
      version: "phase_b2",
    },
  };
}

// =========================================================================
// GENERIC ORCHESTRATION HANDLERS
// =========================================================================

/**
 * github_workflow_dispatch
 * input: { repo: "owner/name", workflow: "deploy.yml", ref: "main", inputs: {...}, project_name?: string }
 * Dispatches the workflow, then enqueues a poll_github_run_status follow-up to
 * correlate the run id and track to completion.
 */
async function githubWorkflowDispatch(task) {
  const missing = envCheck("GITHUB_PAT");
  if (missing) return { ok: false, retryable: false, error: missing };

  const { repo, workflow, ref = "main", inputs = {}, project_name = null } = task.input || {};
  if (!repo || !workflow) {
    return { ok: false, retryable: false, error: "input.repo + input.workflow required" };
  }

  const dispatched_at = new Date().toISOString();
  const r = await dispatchWorkflow(repo, workflow, ref, inputs);
  if (!r.ok) {
    return { ok: false, retryable: !!r.retryable, error: r.error || `dispatch failed status=${r.status}` };
  }

  // Insert tracking row
  const { data: trackRow, error: trackErr } = await supabase
    .from("github_runs")
    .insert({
      task_id: task.id,
      repo,
      workflow_id: workflow,
      ref,
      inputs,
      status: "dispatched",
      triggered_by: process.env.VERCEL_REGION || "worker",
      raw: { dispatched_at, http_status: r.status },
    })
    .select("id")
    .single();
  if (trackErr) {
    // log but don't fail — the dispatch already happened
    await alert({
      level: "warn", source: "worker",
      title: "github_runs insert failed (dispatch already sent)",
      body: trackErr.message, context: { task_id: task.id, repo, workflow },
    });
  }

  // Enqueue follow-up polling task. The poll handler will correlate and update.
  await enqueueFollowup({
    action: "poll_github_run_status",
    input: { repo, workflow, ref, dispatched_at, github_runs_id: trackRow?.id, project_name },
    parent_task_id: task.id,
    delay_seconds: 15,
  });

  return {
    ok: true,
    result: {
      dispatched: true,
      repo, workflow, ref,
      github_runs_id: trackRow?.id ?? null,
      poll_scheduled_in_seconds: 15,
    },
  };
}

/**
 * poll_github_run_status — runs every ~30s until the workflow completes or times out.
 * input: { repo, workflow, ref, dispatched_at, github_runs_id, project_name? }
 */
async function pollGithubRunStatus(task) {
  const missing = envCheck("GITHUB_PAT");
  if (missing) return { ok: false, retryable: false, error: missing };

  const { repo, workflow, dispatched_at, github_runs_id, project_name } = task.input || {};
  if (!repo || !workflow) return { ok: false, retryable: false, error: "input.repo + workflow required" };

  // Safety: bail out after 30 minutes
  if (dispatched_at && (Date.now() - new Date(dispatched_at).getTime()) > 30 * 60 * 1000) {
    if (github_runs_id) {
      await supabase.from("github_runs").update({
        status: "timed_out",
        conclusion: "timed_out",
      }).eq("id", github_runs_id);
    }
    await alert({
      level: "error", source: "worker",
      title: `github workflow ${repo}:${workflow} timed out`,
      body: "30 minutes elapsed without observed completion",
      context: { task_id: task.id, github_runs_id, project_name },
    });
    return { ok: true, result: { status: "timed_out", project_name } };
  }

  // Resolve run id (correlate by created_at >= dispatched_at)
  let runId = null;
  let trackRow = null;
  if (github_runs_id) {
    const { data } = await supabase.from("github_runs").select("github_run_id").eq("id", github_runs_id).maybeSingle();
    trackRow = data;
    runId = data?.github_run_id || null;
  }

  if (!runId) {
    const find = await findRecentDispatchRun(repo, workflow, dispatched_at);
    if (!find.ok) return { ok: false, retryable: !!find.retryable, error: find.error };
    if (!find.run) {
      // Not visible yet. Re-enqueue poll.
      await enqueueFollowup({
        action: "poll_github_run_status",
        input: task.input, parent_task_id: task.id, delay_seconds: 30,
      });
      return { ok: true, result: { status: "awaiting_run_id" } };
    }
    runId = find.run.id;
    if (github_runs_id) {
      await supabase.from("github_runs").update({
        github_run_id: runId,
        status: find.run.status,
        conclusion: find.run.conclusion ?? null,
        raw: find.run,
      }).eq("id", github_runs_id);
    }
  }

  // Now fetch full status
  const st = await getRunStatus(repo, runId);
  if (!st.ok) return { ok: false, retryable: !!st.retryable, error: st.error };

  if (github_runs_id) {
    await supabase.from("github_runs").update({
      status: st.status,
      conclusion: st.conclusion,
      raw: { html_url: st.html_url, head_sha: st.head_sha, head_branch: st.head_branch, updated_at: st.updated_at },
    }).eq("id", github_runs_id);
  }

  if (st.status !== "completed") {
    // Still running — re-enqueue poll
    await enqueueFollowup({
      action: "poll_github_run_status",
      input: task.input, parent_task_id: task.id, delay_seconds: 30,
    });
    return { ok: true, result: { status: st.status, run_id: runId, project_name } };
  }

  // Completed — alert founder if failed
  if (st.conclusion !== "success") {
    await alert({
      level: "error", source: "worker",
      title: `github workflow ${repo}:${workflow} ${st.conclusion}`,
      body: `Run ${runId} concluded with ${st.conclusion}. View: ${st.html_url}`,
      context: { task_id: task.id, repo, workflow, run_id: runId, project_name, html_url: st.html_url },
    });
  } else {
    await alert({
      level: "info", source: "worker",
      title: `github workflow ${repo}:${workflow} succeeded`,
      body: `Run ${runId} succeeded.`,
      context: { task_id: task.id, run_id: runId, project_name, html_url: st.html_url },
    });
  }

  return { ok: true, result: { status: "completed", conclusion: st.conclusion, run_id: runId, html_url: st.html_url } };
}

/**
 * vercel_redeploy
 * input: { project_name? } OR { vercel_project_id?, project_name? }
 * Recreates the latest production deployment from its git source.
 */
async function vercelRedeploy(task) {
  const missing = envCheck("VERCEL_TOKEN");
  if (missing) return { ok: false, retryable: false, error: missing };

  const { project_name, vercel_project_id: explicitId } = task.input || {};
  let projectId = explicitId;
  let projectRow = null;

  if (project_name && !projectId) {
    const r = await getProject(project_name);
    if (r.error) return { ok: false, retryable: false, error: r.error };
    projectRow = r.project;
    projectId = projectRow.vercel_project_id;
  }
  if (!projectId) return { ok: false, retryable: false, error: "vercel_project_id or project_name required" };

  const r = await redeployLatest(projectId, project_name || projectRow?.project_name);
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) {
      return { ok: false, retryable: false, error: `vercel auth: ${r.error}` };
    }
    return { ok: false, retryable: !!r.retryable, error: r.error || `redeploy failed status=${r.status}` };
  }

  const { data: depRow } = await supabase
    .from("deployments")
    .insert({
      task_id: task.id,
      project_name: project_name || projectRow?.project_name || "unknown",
      vercel_project_id: projectId,
      vercel_deployment_id: r.deploymentId,
      vercel_url: r.url,
      source: "vercel_redeploy",
      status: (r.state || "queued").toLowerCase(),
      triggered_by: process.env.VERCEL_REGION || "worker",
      raw: { state: r.state, url: r.url },
    })
    .select("id")
    .single();

  await enqueueFollowup({
    action: "poll_deployment_status",
    input: { vercel_deployment_id: r.deploymentId, deployments_id: depRow?.id, project_name },
    parent_task_id: task.id,
    delay_seconds: 30,
  });

  return {
    ok: true,
    result: {
      vercel_deployment_id: r.deploymentId,
      url: r.url,
      initial_state: r.state,
      deployments_id: depRow?.id ?? null,
    },
  };
}

/**
 * poll_deployment_status — polls until READY|ERROR|CANCELED, or 30 min timeout.
 * input: { vercel_deployment_id, deployments_id, project_name? }
 */
async function pollDeploymentStatus(task) {
  const missing = envCheck("VERCEL_TOKEN");
  if (missing) return { ok: false, retryable: false, error: missing };

  const { vercel_deployment_id, deployments_id, project_name } = task.input || {};
  if (!vercel_deployment_id) return { ok: false, retryable: false, error: "vercel_deployment_id required" };

  // 30-minute hard timeout
  const { data: depRow } = await supabase
    .from("deployments").select("created_at, status").eq("id", deployments_id).maybeSingle();
  if (depRow?.created_at && (Date.now() - new Date(depRow.created_at).getTime()) > 30 * 60 * 1000) {
    await supabase.from("deployments").update({ status: "timed_out" }).eq("id", deployments_id);
    await alert({
      level: "error", source: "worker",
      title: `vercel deployment ${vercel_deployment_id} timed out`,
      body: "30 minutes elapsed without reaching READY/ERROR",
      context: { task_id: task.id, deployments_id, project_name },
    });
    return { ok: true, result: { status: "timed_out" } };
  }

  const st = await getDeployment(vercel_deployment_id);
  if (!st.ok) return { ok: false, retryable: !!st.retryable, error: st.error };

  const stateLower = (st.state || "unknown").toLowerCase();
  if (deployments_id) {
    await supabase.from("deployments").update({
      status: stateLower, vercel_url: st.url || undefined, raw: { state: st.state, url: st.url, target: st.target },
    }).eq("id", deployments_id);
  }

  const terminal = ["ready", "error", "canceled"];
  if (!terminal.includes(stateLower)) {
    await enqueueFollowup({
      action: "poll_deployment_status",
      input: task.input, parent_task_id: task.id, delay_seconds: 30,
    });
    return { ok: true, result: { state: st.state } };
  }

  // Terminal — surface
  if (stateLower === "ready") {
    await alert({
      level: "info", source: "worker",
      title: `${project_name || "deployment"} ready`,
      body: `Vercel deployment ${vercel_deployment_id} is READY at ${st.url}`,
      context: { task_id: task.id, deployments_id, project_name, url: st.url },
    });
  } else {
    await alert({
      level: "error", source: "worker",
      title: `${project_name || "deployment"} ${stateLower}`,
      body: `Vercel deployment ${vercel_deployment_id} ended in state=${st.state}`,
      context: { task_id: task.id, deployments_id, project_name },
    });
  }

  return { ok: true, result: { state: st.state, url: st.url } };
}

/**
 * vercel_get_status
 * input: { vercel_deployment_id }
 */
async function vercelGetStatus(task) {
  const missing = envCheck("VERCEL_TOKEN");
  if (missing) return { ok: false, retryable: false, error: missing };

  const { vercel_deployment_id } = task.input || {};
  if (!vercel_deployment_id) return { ok: false, retryable: false, error: "vercel_deployment_id required" };

  const r = await getDeployment(vercel_deployment_id);
  if (!r.ok) return { ok: false, retryable: !!r.retryable, error: r.error };
  return { ok: true, result: { state: r.state, url: r.url, target: r.target } };
}

/**
 * vercel_promote
 * input: { project_name?, vercel_project_id?, vercel_deployment_id }
 */
async function vercelPromote(task) {
  const missing = envCheck("VERCEL_TOKEN");
  if (missing) return { ok: false, retryable: false, error: missing };

  const { project_name, vercel_project_id: explicitId, vercel_deployment_id } = task.input || {};
  if (!vercel_deployment_id) return { ok: false, retryable: false, error: "vercel_deployment_id required" };

  let projectId = explicitId;
  if (!projectId && project_name) {
    const r = await getProject(project_name);
    if (r.error) return { ok: false, retryable: false, error: r.error };
    projectId = r.project.vercel_project_id;
  }
  if (!projectId) return { ok: false, retryable: false, error: "vercel_project_id or project_name required" };

  const r = await promoteToProduction(projectId, vercel_deployment_id);
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) return { ok: false, retryable: false, error: `vercel auth: ${r.error}` };
    return { ok: false, retryable: !!r.retryable, error: r.error };
  }
  return { ok: true, result: { promoted: true, vercel_deployment_id, project_id: projectId } };
}

/**
 * github_get_run_status
 * input: { repo, run_id }
 */
async function githubGetRunStatus(task) {
  const missing = envCheck("GITHUB_PAT");
  if (missing) return { ok: false, retryable: false, error: missing };

  const { repo, run_id } = task.input || {};
  if (!repo || !run_id) return { ok: false, retryable: false, error: "input.repo + input.run_id required" };

  const r = await getRunStatus(repo, run_id);
  if (!r.ok) return { ok: false, retryable: !!r.retryable, error: r.error };
  return { ok: true, result: { status: r.status, conclusion: r.conclusion, html_url: r.html_url } };
}

// =========================================================================
// PRODUCT-LEVEL DEPLOY HANDLERS
// =========================================================================

/**
 * deploy_cart2save — orchestration entry point.
 * Strategy:
 *   1. If task.input.strategy === 'workflow', dispatch GitHub workflow
 *   2. Else (default), call Vercel redeploy directly
 * Both paths spawn polling follow-ups and write to deployments / github_runs.
 */
async function deployCart2save(task) {
  const strategy = (task.input?.strategy || "vercel_redeploy").toLowerCase();
  const project_name = "cart2save";

  if (strategy === "workflow") {
    const map = PRODUCT_DEPLOY_MAP.deploy_cart2save;
    const proj = await getProject(project_name);
    if (proj.error) return { ok: false, retryable: false, error: proj.error };
    if (!proj.project.github_repo) return { ok: false, retryable: false, error: "cart2save has no github_repo in project_registry" };

    return await githubWorkflowDispatch({
      ...task,
      input: {
        repo: proj.project.github_repo,
        workflow: map.workflow,
        ref: task.input?.ref || "main",
        inputs: task.input?.inputs || {},
        project_name,
      },
    });
  }

  // default: vercel_redeploy
  return await vercelRedeploy({
    ...task,
    input: { project_name },
  });
}

// =========================================================================
// DEFERRED PRODUCT HANDLERS (still blocked at the data layer, not by tokens)
// =========================================================================

async function runQuickscanzScan(task) {
  // QuickScanZ Supabase is INACTIVE. Worker should NOT auto-restore (cost).
  await alert({
    level: "info", source: "worker",
    title: "run_quickscanz_scan deferred",
    body: "QuickScanZ Supabase project is INACTIVE. Restore required before scan. Worker will not auto-restore.",
    context: { task_id: task.id },
  });
  return deferred("quickscanz supabase inactive", "founder must approve restore");
}

async function runVidyagridAnalysis(task) {
  await alert({
    level: "info", source: "worker",
    title: "run_vidyagrid_analysis deferred",
    body: "Vidyagrid Supabase project is INACTIVE. Restore required.",
    context: { task_id: task.id },
  });
  return deferred("vidyagrid supabase inactive", "founder must approve restore");
}

async function runQuietkeepSync(task) {
  return deferred("quietkeep supabase outside connected org", "needs second supabase account in worker env");
}

async function runPmilScan(task) {
  return deferred("pmil supabase not provisioned", "Phase C");
}

async function runSchoolReports(task) {
  // School OS read-only by policy. Confirm registry mapping only.
  const r = await getProject("schoolos");
  if (r.error) return { ok: false, retryable: true, error: r.error };
  return { ok: true, result: { mode: "read_only_ping", project: r.project.project_name } };
}

async function manageEasyvenuezBookings(task) { return deferred("easyvenuez handler not implemented", "Phase C"); }
async function runConsultancyLeads(task)      { return deferred("consultancy handler not implemented", "Phase C"); }
async function triggerInsureupiFlow(task)     { return deferred("insureupi handler not implemented", "Phase C"); }

// =========================================================================
// REGISTRY
// =========================================================================

export const HANDLERS = {
  // self-test
  worker_self_test:          workerSelfTest,

  // generic orchestration
  github_workflow_dispatch:  githubWorkflowDispatch,
  poll_github_run_status:    pollGithubRunStatus,
  github_get_run_status:     githubGetRunStatus,
  vercel_redeploy:           vercelRedeploy,
  vercel_get_status:         vercelGetStatus,
  vercel_promote:            vercelPromote,
  poll_deployment_status:    pollDeploymentStatus,

  // product-level
  deploy_cart2save:          deployCart2save,

  // deferred (data-layer-blocked, not token-blocked)
  run_quickscanz_scan:       runQuickscanzScan,
  run_vidyagrid_analysis:    runVidyagridAnalysis,
  run_quietkeep_sync:        runQuietkeepSync,
  run_pmil_scan:             runPmilScan,
  run_school_reports:        runSchoolReports,
  manage_easyvenuez_bookings:manageEasyvenuezBookings,
  run_consultancy_leads:     runConsultancyLeads,
  trigger_insureupi_flow:    triggerInsureupiFlow,
};

export async function dispatch(task) {
  const action = task.action;
  if (!action) return { ok: false, retryable: false, error: "task has no action" };
  const handler = HANDLERS[action];
  if (!handler) return { ok: false, retryable: false, error: `no handler registered for action '${action}'` };
  try {
    return await handler(task);
  } catch (e) {
    return { ok: false, retryable: true, error: e?.message || String(e) };
  }
}
