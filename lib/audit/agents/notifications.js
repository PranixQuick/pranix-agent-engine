// lib/audit/agents/notifications.js — audit_notifications handler.

import { httpRequest } from "../../clients/http.js";
import { runAudit } from "../runner.js";
import { getProject, resolveVercelToken, resolveVercelTeamId } from "../../registry.js";
import { missingEnv, apiFailure, healthy } from "../findings.js";

const VERCEL_API = "https://api.vercel.com";

function vHeaders(token) { return { "authorization": `Bearer ${token}`, "user-agent": "pranix-agent-engine/audit" }; }

async function fetchVercelEnvKeys(token, teamId, projectId) {
  const teamFirst = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
  const r = await httpRequest(`${VERCEL_API}/v9/projects/${encodeURIComponent(projectId)}/env${teamFirst}`, {
    headers: vHeaders(token), timeoutMs: 12000,
  });
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, keys: new Set((r.data?.envs || []).map(e => e.key)) };
}

async function probeServiceWorker(productUrl) {
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
    const proj = await getProject(product_name);
    if (proj.error) {
      ctx.find({ severity: "critical", category: "notifications", resource: product_name, title: proj.error });
      return { reason: proj.error };
    }
    const projectId  = proj.project.vercel_project_id;
    const productUrl = proj.project.url;
    const tokRes = resolveVercelToken(proj.project);
    if (tokRes.error) { ctx.find(missingEnv(tokRes.env_name || "VERCEL_TOKEN", product_name)); return { reason: tokRes.error }; }
    const teamId = resolveVercelTeamId(proj.project);

    const envs = await fetchVercelEnvKeys(tokRes.token, teamId, projectId);
    if (!envs.ok) {
      ctx.find(apiFailure("notifications", projectId, `vercel env list failed: ${envs.status}`, { status: envs.status, token_env: tokRes.env_name }));
    } else {
      if (!envs.keys.has("NEXT_PUBLIC_ONESIGNAL_APP_ID")) {
        ctx.find({
          severity: "critical", category: "notifications", resource: projectId,
          title: `${product_name}: NEXT_PUBLIC_ONESIGNAL_APP_ID missing on Vercel`,
          body:  "Without this env var, OneSignal SDK init fails in the browser.",
        });
      } else {
        ctx.find(healthy("notifications", projectId, "NEXT_PUBLIC_ONESIGNAL_APP_ID configured."));
      }
    }
    if (ctx.deadlineReached()) return null;

    if (productUrl) {
      const found = await probeServiceWorker(productUrl);
      if (found.length === 0) {
        ctx.find({
          severity: "error", category: "notifications", resource: productUrl,
          title:    `${product_name}: no OneSignal service worker found`,
          body:     "None of OneSignalSDKWorker.js / OneSignalSDKUpdaterWorker.js / sw.js responded 200.",
          evidence: { url: productUrl },
        });
      } else {
        ctx.find(healthy("notifications", productUrl, `Service worker(s) reachable: ${found.join(", ")}.`));
      }
    } else {
      ctx.find({ severity: "warn", category: "notifications", resource: product_name,
        title: `${product_name}: project_registry.url is null` });
    }
    if (ctx.deadlineReached()) return null;

    const appId = process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID || task.input?.onesignal_app_id;
    if (appId) {
      const r = await probeOneSignalApp(appId);
      if (r.ok) {
        ctx.find(healthy("notifications", `onesignal:${appId}`, `OneSignal app reachable: ${r.data?.name || "(no name)"}.`));
      } else if (r.status === 401 || r.status === 403) {
        ctx.find({
          severity: "warn", category: "notifications", resource: `onesignal:${appId}`,
          title: `OneSignal API rejected request`,
          body:  `Provide ONESIGNAL_REST_API_KEY for deeper checks.`,
          evidence: { status: r.status },
        });
      } else {
        ctx.find(apiFailure("notifications", `onesignal:${appId}`, `OneSignal app fetch ${r.status}`, { status: r.status }));
      }
    }

    return { product: product_name, vercel_project_id: projectId, token_env: tokRes.env_name };
  });
}
