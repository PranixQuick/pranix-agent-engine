// lib/auth.js — gate every endpoint.
//
// Vercel Cron passes a Bearer token equal to CRON_SECRET (or x-vercel-cron header).
// Manual triggers (e.g. /api/execute, /api/reap) require WORKER_SECRET.
//
// Both secrets live in Doppler → Vercel env. Never hardcode.

export function isCronRequest(req) {
  // Vercel Cron sets this header automatically when it invokes a cron path.
  if (req.headers["x-vercel-cron"]) return true;

  const auth = req.headers["authorization"] || "";
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true;

  return false;
}

export function isAuthorizedManualCall(req) {
  const auth = req.headers["authorization"] || "";
  const workerSecret = process.env.WORKER_SECRET;
  if (!workerSecret) return false;
  return auth === `Bearer ${workerSecret}`;
}

export function requireWorkerAuth(req, res) {
  if (isCronRequest(req) || isAuthorizedManualCall(req)) return true;
  res.status(401).json({ success: false, error: "unauthorized" });
  return false;
}
