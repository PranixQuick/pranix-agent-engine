// lib/audit/agents/notifications.js — audit_notifications handler.
//
// QuickScanZ-specific. We don't have direct device-side access; we check what
// the worker can reach: env-var presence on Vercel, public service-worker URL,
// and OneSignal API view (if app id + REST API key are set).
//
// Inputs: { product_name }
// Required envs (per product): NEXT_PUBLIC_ONESIGNAL_APP_ID, optional ONESIGNAL_REST_API_KEY

import { httpRequest } from "../../clients/http.js";
import { runAudit } from "../runner.js";
import { getProject } from "../../registry.js";
import { missingEnv, apiFailure, healthy } from "../findings.js";

const VERCEL_API = "https://api.vercel.com";

function vHeaders() { return { "authorization": `Bearer ${process.env.VERCEL_TOKEN}`, "user-agent": "pranix-agent-engine/audit" }; }
function teamFirst() { const t=process.env.VERCEL_TEAM_ID; return t ? `?teamId=${encodeURIComponent(t)}` : ""; }

async function fetchVercelEnvKeys(projectId) {
  const r = await httpRequest(`${VERCEL_API}/v9/projects/${encodeURIComponent(projectId)}/env${teamFirst()}`, {
    headers: vHeaders(), timeoutMs: 12000,
  });
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, keys: new Set((r.data?.envs || []).map(e => e.key)) };
}

async function probeServiceWorker(productUrl) {
  // Common SW filenames OneSignal places in /public
  const candidates = ["OneSignalSDKWorker.js", "OneSignalSDKUpdaterWorker.js", "sw.js"];
  const found = [];
  for (const fname of candidates) {
    const url = `${productUrl.replace(/\/$/, "")}/${fname}`;
    const r = await httpRequest(url, { method: "HEAD", timeoutMs: 6000 });
    if (r.ok) found.push(fname);
  }
  return found;
}

async function probeOneSignalApp(appId) {
  // Public app metadata; doesn't need the REST API key
  const r = await httpRequest(`https://onesignal.com/api/v1/apps/${encodeURIComponent(appId)}`, {
    headers: process.env.ONESIGNAL_REST_API_KEY
      ? { "authorization": `Basic ${process.env.ONESIGNAL_REST_API_KEY}` }
      : {},
    timeoutMs: 8000,
  });
  return r;
}

export async function auditNotifications(task) {
  const product_name = task.input?.product_name || "quickscanz";
  if (product_name !== "quickscanz") {
    return { ok: false, retryable: false, error: "audit_notifications is quickscanz-only" };
  }

  return runAudit(task, { agent: "notifications", product: product_name, scope: { product_name } }, async (ctx) => {
    if (!process.env.VERCEL_TOKEN) {
      ctx.find(missingEnv("VERCEL_TOKEN", product_name));
      return { reason: "VERCEL_TOKEN missing" };
    }
    const proj = await getProject(product_name);
    if (proj.error) {
      ctx.find({ severity: "critical", category: "notifications", resource: product_name, title: proj.error });
      return { reason: proj.error };
    }
    const projectId  = proj.project.vercel_project_id;
    const productUrl = proj.project.url;

    // 1. Env: NEXT_PUBLIC_ONESIGNAL_APP_ID present?
    const envs = await fetchVercelEnvKeys(projectId);
    if (!envs.ok) {
      ctx.find(apiFailure("notifications", projectId, `vercel env list failed: ${envs.status}`, { status: envs.status }));
    } else {
      if (!envs.keys.has("NEXT_PUBLIC_ONESIGNAL_APP_ID")) {
        ctx.find({
          severity: "critical", category: "notifications", resource: projectId,
          title: `${product_name}: NEXT_PUBLIC_ONESIGNAL_APP_ID missing on Vercel`,
          body:  "Without this env var, OneSignal SDK init fails in the browser; push notifications cannot work.",
          evidence: { product: product_name },
          remediation_action: null,
        });
      } else {
        ctx.find(healthy("notifications", projectId, "NEXT_PUBLIC_ONESIGNAL_APP_ID configured."));
      }
    }

    if (ctx.deadlineReached()) return null;

    // 2. Service worker reachable on the production URL?
    if (productUrl) {
      const found = await probeServiceWorker(productUrl);
      if (found.length === 0) {
        ctx.find({
          severity: "error", category: "notifications", resource: productUrl,
          title:    `${product_name}: no OneSignal service worker found`,
          body:     "None of OneSignalSDKWorker.js / OneSignalSDKUpdaterWorker.js / sw.js responded 200 on the production URL.",
          evidence: { url: productUrl },
        });
      } else {
        ctx.find(healthy("notifications", productUrl, `Service worker(s) reachable: ${found.join(", ")}.`));
      }
    } else {
      ctx.find({
        severity: "warn", category: "notifications", resource: product_name,
        title: `${product_name}: project_registry.url is null`,
        body:  "Cannot probe public service worker without a base URL.",
      });
    }

    if (ctx.deadlineReached()) return null;

    // 3. OneSignal app metadata
    const appId = process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID || task.input?.onesignal_app_id;
    if (appId) {
      const r = await probeOneSignalApp(appId);
      if (r.ok) {
        ctx.find(healthy("notifications", `onesignal:${appId}`, `OneSignal app reachable: ${r.data?.name || "(no name)"}.`));
      } else if (r.status === 401 || r.status === 403) {
        ctx.find({
          severity: "warn", category: "notifications", resource: `onesignal:${appId}`,
          title: `OneSignal API rejected request`,
          body:  `Provide ONESIGNAL_REST_API_KEY in Doppler to enable deeper checks (subscription counts, last-delivery time).`,
          evidence: { status: r.status },
        });
      } else {
        ctx.find(apiFailure("notifications", `onesignal:${appId}`, `OneSignal app fetch ${r.status}`, { status: r.status }));
      }
    }

    return { product: product_name, vercel_project_id: projectId };
  });
}
