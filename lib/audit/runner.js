// lib/audit/runner.js — wraps an audit handler with bookkeeping.
//
// Usage inside any audit_* handler:
//   return runAudit(task, { agent: 'repo', product: 'cart2save' }, async (ctx) => {
//     ctx.find({ severity: 'warn', category: 'repo', title: '...', body: '...' });
//     ctx.find({ severity: 'critical', ... });
//     return { extra: 'metadata for result' };
//   });
//
// The runner:
//   - Opens an audit_runs row via RPC, captures audit_run_id.
//   - Provides ctx.find(finding) which buffers up to MAX_FINDINGS.
//   - Enforces a hard wall-clock budget; if exceeded, marks status='timed_out'.
//   - Bulk-inserts findings at the end (one round-trip).
//   - Closes audit_runs via RPC which computes severity histogram.
//   - Escalates to founder_alerts if any severity='critical'.
//   - Returns a B2-handler-shaped { ok, result } so it plugs straight into dispatch().

import { supabase, alert } from "../supabase.js";

const MAX_FINDINGS         = parseInt(process.env.AUDIT_MAX_FINDINGS    || "100", 10);
const MAX_RUNTIME_MS       = parseInt(process.env.AUDIT_MAX_RUNTIME_MS  || "45000", 10);
const VALID_SEVERITY       = new Set(["info", "warn", "error", "critical"]);

/**
 * @param {object} task     - the supabase tasks row
 * @param {object} opts     - { agent: string, product: string|null, scope?: object }
 * @param {function} body   - async (ctx) => optional extras
 */
export async function runAudit(task, opts, body) {
  const { agent, product = null, scope = {} } = opts;
  if (!agent) throw new Error("runAudit: agent required");

  // Open audit_runs row
  const { data: openData, error: openErr } = await supabase.rpc("open_audit_run", {
    p_task_id: task.id,
    p_agent:   agent,
    p_product: product,
    p_scope:   scope,
  });
  if (openErr || !openData) {
    return { ok: false, retryable: true, error: `open_audit_run failed: ${openErr?.message || "no id"}` };
  }
  const audit_run_id = openData;

  const startMs    = Date.now();
  const findings   = [];
  let truncated    = false;
  let timed_out    = false;

  const ctx = {
    audit_run_id,
    product,
    agent,
    scope,
    /**
     * Buffer a finding. Idempotent at insert-time via dedup_idx
     * (audit_run_id, category, resource, title).
     */
    find(f) {
      if (findings.length >= MAX_FINDINGS) { truncated = true; return false; }
      if (!VALID_SEVERITY.has(f.severity)) {
        findings.push({
          severity: "warn",
          category: f.category || "infra",
          resource: f.resource ?? null,
          title:    `internal: invalid severity '${f.severity}'`,
          body:     f.title || null,
          evidence: null,
          remediation_action: null,
          remediation_input:  null,
          product_name: product,
        });
        return false;
      }
      findings.push({
        audit_run_id,
        product_name:        product,
        category:            f.category,
        severity:            f.severity,
        resource:            f.resource ?? null,
        title:               f.title,
        body:                f.body ?? null,
        evidence:            f.evidence ?? null,
        remediation_action:  f.remediation_action ?? null,
        remediation_input:   f.remediation_input ?? null,
        status:              "open",
      });
      return true;
    },
    timeLeftMs() { return MAX_RUNTIME_MS - (Date.now() - startMs); },
    deadlineReached() {
      if (Date.now() - startMs > MAX_RUNTIME_MS) { timed_out = true; return true; }
      return false;
    },
  };

  let extra = null;
  let bodyError = null;
  try {
    extra = await body(ctx);
  } catch (e) {
    bodyError = e?.message || String(e);
  }

  // Persist findings (bulk) — strip audit_run_id from the synthetic invalid-severity records
  // (they went in with no id; backfill it now).
  const toInsert = findings.map(f => ({ ...f, audit_run_id }));
  if (toInsert.length > 0) {
    const { error: insErr } = await supabase
      .from("audit_findings")
      .insert(toInsert);
    if (insErr) {
      // Don't fail the whole audit just because of the buffer flush; log + continue.
      console.error("[audit] findings insert failed:", insErr.message);
    }
  }

  // Close run
  const status = bodyError ? "errored"
               : timed_out ? "timed_out"
               : truncated ? "truncated"
               : "completed";

  const { data: summary, error: closeErr } = await supabase.rpc("close_audit_run", {
    p_audit_run_id: audit_run_id,
    p_status:       status,
    p_error:        bodyError,
  });
  if (closeErr) {
    console.error("[audit] close_audit_run failed:", closeErr.message);
  }

  // Escalate criticals
  const sum = summary || null;
  const criticalCount = sum?.findings?.critical ?? 0;
  if (criticalCount > 0) {
    await alert({
      level:  "critical",
      source: `audit:${agent}`,
      title:  `${product || "platform"}: ${criticalCount} critical finding(s)`,
      body:   `Audit run ${audit_run_id} surfaced ${criticalCount} critical issue(s). View the audit_findings table.`,
      context: { audit_run_id, agent, product, summary: sum, status },
    });
  }

  // Worker contract
  if (bodyError) {
    return { ok: false, retryable: true, error: bodyError };
  }
  return {
    ok: true,
    result: {
      audit_run_id,
      agent,
      product_name: product,
      status,
      summary: sum,
      truncated,
      timed_out,
      extra: extra ?? null,
    },
  };
}
