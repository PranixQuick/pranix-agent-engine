// lib/audit/agents/affiliate.js — audit_affiliate_health handler.
//
// Cart2Save-specific. Checks freshness of affiliate-network tokens by
// performing low-cost probes. We never POST anything; only read-only sanity calls.
//
// Inputs: { product_name }   — only 'cart2save' is supported today
//
// Token sources expected from env (all optional — missing = warning, not error):
//   CUELINKS_TOKEN
//   ADMITAD_TOKEN
//   TRAVELPAYOUTS_TOKEN
//
// Probes:
//   CueLinks: GET https://api.linkmydeals.com/api/v2/health     (auth bearer)
//   Admitad:  GET https://api.admitad.com/me/                   (auth bearer)
//   TravelPayouts: GET https://api.travelpayouts.com/v2/prices/latest  (header X-Access-Token)
//
// If a probe returns 401/403 → 'critical' (token expired/wrong).
// If 5xx or timeout → 'warn' (provider issue, retry-style failure).
// Any 2xx → 'info' (healthy).

import { httpRequest } from "../../clients/http.js";
import { runAudit } from "../runner.js";
import { healthy, apiFailure } from "../findings.js";

async function probeCueLinks() {
  const tok = process.env.CUELINKS_TOKEN;
  if (!tok) return { ok: false, severity: "warn", reason: "CUELINKS_TOKEN missing" };
  const r = await httpRequest("https://api.linkmydeals.com/api/v2/categories", {
    headers: { "authorization": `Bearer ${tok}` }, timeoutMs: 8000,
  });
  if (r.status === 401 || r.status === 403) return { ok: false, severity: "critical", reason: `CueLinks ${r.status}: token rejected` };
  if (!r.ok) return { ok: false, severity: "warn", reason: `CueLinks ${r.status}` };
  return { ok: true };
}

async function probeAdmitad() {
  const tok = process.env.ADMITAD_TOKEN;
  if (!tok) return { ok: false, severity: "warn", reason: "ADMITAD_TOKEN missing" };
  const r = await httpRequest("https://api.admitad.com/me/", {
    headers: { "authorization": `Bearer ${tok}` }, timeoutMs: 8000,
  });
  if (r.status === 401 || r.status === 403) return { ok: false, severity: "critical", reason: `Admitad ${r.status}: token rejected` };
  if (!r.ok) return { ok: false, severity: "warn", reason: `Admitad ${r.status}` };
  return { ok: true };
}

async function probeTravelPayouts() {
  const tok = process.env.TRAVELPAYOUTS_TOKEN;
  if (!tok) return { ok: false, severity: "warn", reason: "TRAVELPAYOUTS_TOKEN missing" };
  const r = await httpRequest("https://api.travelpayouts.com/v2/prices/latest?currency=inr&limit=1", {
    headers: { "x-access-token": tok }, timeoutMs: 8000,
  });
  if (r.status === 401 || r.status === 403) return { ok: false, severity: "critical", reason: `TravelPayouts ${r.status}: token rejected` };
  if (!r.ok) return { ok: false, severity: "warn", reason: `TravelPayouts ${r.status}` };
  return { ok: true };
}

export async function auditAffiliateHealth(task) {
  const product_name = task.input?.product_name || "cart2save";
  if (product_name !== "cart2save") {
    return { ok: false, retryable: false, error: "audit_affiliate_health is cart2save-only" };
  }

  return runAudit(task, { agent: "affiliate", product: product_name, scope: { product_name } }, async (ctx) => {
    const checks = [
      { name: "cuelinks",      run: probeCueLinks },
      { name: "admitad",       run: probeAdmitad },
      { name: "travelpayouts", run: probeTravelPayouts },
    ];

    for (const c of checks) {
      if (ctx.deadlineReached()) break;
      let res;
      try { res = await c.run(); }
      catch (e) { res = { ok: false, severity: "warn", reason: e?.message || String(e) }; }

      if (res.ok) {
        ctx.find(healthy("affiliate", c.name, `${c.name} probe responded 2xx.`));
      } else {
        ctx.find({
          severity: res.severity || "warn", category: "affiliate", resource: c.name,
          title: `Cart2Save: ${c.name} probe failed`,
          body:  res.reason,
          evidence: { network: c.name, reason: res.reason },
          remediation_action: null,    // founder must rotate token manually
        });
      }
    }

    return { product: product_name, networks_checked: checks.length };
  });
}
