# Engine webhook hardening v2

Replaces ONLY these two files in PranixQuick/pranix-agent-engine:
- api/github_webhook.js
- api/vercel_webhook.js

## What changed vs v1
1. Raw body now read correctly via `bodyParser: false` + stream consumption.
   v1's `JSON.stringify(req.body)` produced different bytes than what GitHub/Vercel
   signed → HMAC always failed for many event types.
2. `ping` event short-circuits with 200 BEFORE signature check.
3. `status` event added (was unhandled, returned default — but with v2 it's explicit).
4. `deployment_status` now guards null `payload.deployment_status` (was crashing).
5. Unknown events return `{ ok: true, ignored: true, event }` with HTTP 200.
6. All payload field accesses use optional chaining — no more null deref crashes.
7. Errors logged but return 200 (was returning 500, causing infinite GitHub retries).
8. Database upsert now succeeds — unique constraints were added in migration
   `github_runs_unique_constraint_for_upsert` (already applied via Supabase MCP).

## Merge steps
1. Drop both files into `api/` of pranix-agent-engine repo (overwrite v1).
2. Commit + push to main.
3. Vercel auto-deploys.
4. Trigger one test event from GitHub (Settings → Webhooks → Recent Deliveries → Redeliver
   any failed ping). Should now return 200.
5. Push any commit to a connected repo. Within 5 seconds, check:

```sql
SELECT * FROM founder_alerts WHERE source LIKE 'github:%' ORDER BY created_at DESC LIMIT 5;
SELECT * FROM github_runs ORDER BY created_at DESC LIMIT 5;
```

## What's REQUIRED in engine env (already set per your prompt)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GITHUB_WEBHOOK_SECRET` (must match what GitHub webhook config uses)
- `VERCEL_WEBHOOK_SECRET` (must match what Vercel webhook config uses)
