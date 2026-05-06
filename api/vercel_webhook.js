// api/vercel_webhook.js — ESM stub
// Functional handler is now a Supabase Edge Function:
//   https://mvdjyjccvioxircxuzgz.supabase.co/functions/v1/vercel_webhook

export default async function handler(req, res) {
  return res.status(410).json({
    ok: false,
    error: "Endpoint moved",
    new_endpoint: "https://mvdjyjccvioxircxuzgz.supabase.co/functions/v1/vercel_webhook",
    note: "Update the Vercel webhook URL to the new endpoint. This /api route is deprecated.",
  });
}
