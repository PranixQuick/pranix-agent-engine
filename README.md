# pranix-agent-engine code_writer + webhook patch

Merge-ready additions to enable: code-writing agent, GitHub webhook ingestion, Vercel webhook ingestion.

## What's in this patch

| File | Action |
|---|---|
| `lib/clients/github_writer.js` | NEW — GitHub write client (file read, branch, patch, PR, merge) |
| `lib/agents/code_writer.js` | NEW — handlers for the 6 code_writer capabilities |
| `lib/handlers.patch.js` | MERGE — append `NEW_HANDLERS` into existing dispatcher |
| `api/github_webhook.js` | NEW — receives GitHub events, writes to `github_runs` + `founder_alerts` |
| `api/vercel_webhook.js` | NEW — receives Vercel events, writes to `deployments` + `founder_alerts` |
| `migrations/code_writer_capabilities_and_webhooks.sql` | RECORD-ONLY — already applied via Supabase MCP |

## Merge steps (Account 2 → PranixQuick/pranix-agent-engine)

1. Drop these files into the engine repo at the same paths.
2. Open `lib/handlers.js` and add the new handlers — see `lib/handlers.patch.js` for the exact 1-block diff.
3. Add 2 env vars to engine's Vercel project (or via Doppler if synced):
   ```
   GITHUB_WEBHOOK_SECRET=<openssl rand -hex 32>
   VERCEL_WEBHOOK_SECRET=<openssl rand -hex 32>
   ```
4. Commit + push to main. Vercel auto-deploys.
5. Configure **GitHub webhooks** on each repo (Settings → Webhooks → Add):
   - Payload URL: `https://pranix-agent-engine.vercel.app/api/github_webhook`
   - Content type: `application/json`
   - Secret: paste the `GITHUB_WEBHOOK_SECRET` value
   - Events: `push`, `workflow_run`, `deployment_status`, `pull_request`
6. Configure **Vercel webhooks** (account-level, both accounts):
   - Account Settings → Webhooks → Add
   - URL: `https://pranix-agent-engine.vercel.app/api/vercel_webhook`
   - Secret: paste the `VERCEL_WEBHOOK_SECRET` value
   - Events: `deployment.created`, `deployment.succeeded`, `deployment.error`, `deployment.canceled`, `deployment.promoted`

## Verifying it works

After merge + webhook config:

```sql
-- After pushing any commit, this should show a row within ~5 seconds
SELECT * FROM founder_alerts WHERE source LIKE 'github:%' ORDER BY created_at DESC LIMIT 5;

-- After any Vercel deploy event, this should populate
SELECT * FROM deployments ORDER BY created_at DESC LIMIT 5;
SELECT * FROM github_runs ORDER BY created_at DESC LIMIT 5;
```

If those tables stay empty after webhook events fire, check Vercel function logs for `pranix-agent-engine`/`api/github_webhook` and `api/vercel_webhook` — most likely cause is signature mismatch (wrong secret).

## Once live: what becomes autonomous

| Action | Before this patch | After this patch |
|---|---|---|
| Read a Cart2Save source file | Required founder paste | Engine fetches via GitHub PAT |
| Apply a known failure_pattern's remediation | Manual founder edit | `code_writer.github_apply_patch` writes file on a branch |
| Open a PR with the fix | Manual founder commit + PR | `code_writer.github_create_pr` |
| Merge the PR | Manual founder merge | Approval-gated (`requires_approval=true`) — founder taps approve |
| See build/deploy state on dashboard | Scheduled audit, ~hourly | Real-time via webhooks |
| Detect production deploy failure | Audit eventually catches it | Vercel webhook → founder_alert in <5s |
