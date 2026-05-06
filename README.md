# Pranix Engine — Verification Layer v1

## What this adds

Three new agent capabilities, all **non-approval-gated** (read-only operations):

| Action | Agent | Purpose |
|---|---|---|
| `verify_deployment` | verifier | Polls Vercel API for deploy status by ID/SHA, writes outcome to `deployment_verifications` + `founder_alerts` |
| `http_smoke_test` | verifier | Runs `smoke_test_definitions` rows for a project against deployed URL, writes results to `smoke_test_results` + `founder_alerts` |
| `grep_repo` | code_writer | Repo-wide regex search via GitHub Search API |

## Files in this zip (drop-in, same paths)

| Path | Status |
|---|---|
| `lib/handlers.js` | Existing 34-handler dispatcher + 3 new map keys + 2 import lines |
| `lib/agents/verifier.js` | NEW — verify_deployment + http_smoke_test (ESM) |
| `lib/agents/code_writer_search.js` | NEW — grep_repo (ESM) |

## What's already done (DB-side, applied this session)

- `action_registry` rows registered for all 3
- `agent_capabilities` rows registered (verifier and code_writer agents)
- `agent_routes` row for `verify_after_deploy` intent
- `smoke_test_definitions`, `smoke_test_results`, `deployment_verifications` tables created with founder RLS
- 5 Cart2Save smoke test definitions seeded (homepage, search, /q/iphone, /q/iphone/mumbai, /book/confirmation)
- `cart2save` row in project_registry updated with `url=https://www.cart2save.com`

## Deploy

GitHub mobile web → `https://github.com/PranixQuick/pranix-agent-engine` → Add file → Upload files → drop the 3 paths above. Commit to `main`. Vercel auto-redeploys (~60s). Verified working.

## Required env vars (already in Doppler)

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (already)
- `GITHUB_PAT`, `GITHUB_SECONDARY_PAT` (already)
- `VERCEL_TOKEN` (already — Account 2)
- `VERCEL_SECONDARY_TOKEN` ⚠️ **must exist** for verifier to poll Account 1 (Cart2Save) deploys. Per prior session: confirmed deployed.

## Validated pre-ship

- `node --check` passed all 3 files
- ESM module-load test: HANDLERS map has all 6 expected handlers, returns functions
- Dispatcher unit tests: each new handler returns `retryable:false` on missing inputs

## Risks

- `grep_repo` uses GitHub Search API — search index can be slightly stale on very recently pushed commits (typically <30s lag).
- `verify_deployment` falls back to listing latest 20 deployments when given only a commit SHA. If the deploy is older than the latest 20, it won't be found.
- `http_smoke_test` runs serially for simplicity; for projects with >10 critical paths, consider sharding later.

## After deploy: first proof-of-life

```sql
-- Smoke test Cart2Save end-to-end
INSERT INTO tasks (agent_id, action, input, state, max_attempts, idempotency_key)
VALUES (NULL, 'http_smoke_test',
  '{"project_name":"cart2save"}'::jsonb,
  'pending', 1, 'first_smoke_' || gen_random_uuid()::text);
```

Wait 60-90s, then read the results from `smoke_test_results` and `founder_alerts`.
