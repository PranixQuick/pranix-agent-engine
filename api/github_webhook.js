// api/github_webhook.js — ESM stub
// The functional handler now lives as a Supabase Edge Function:
//   https://mvdjyjccvioxircxuzgz.supabase.co/functions/v1/github_webhook
//
// This stub exists so the engine endpoint stops crashing on legacy webhook
// configurations that still target /api/github_webhook. Returns 410 Gone with
// the new endpoint URL so any human inspecting "Recent deliveries" sees where
// to repoint. Always 200-equivalent to GitHub's retry policy semantically (we
// return 410 Gone deliberately — non-2xx tells GitHub the webhook is dead and
// stops infinite retries).

export default async function handler(req, res) {
  return res.status(410).json({
    ok: false,
    error: "Endpoint moved",
    new_endpoint: "https://mvdjyjccvioxircxuzgz.supabase.co/functions/v1/github_webhook",
    note: "Update the GitHub webhook Payload URL to the new endpoint. This /api route is deprecated.",
  });
}
