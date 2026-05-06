# pranix-agent-engine code_writer ESM patch (v3 — FINAL)

## Why this patch exists

Smoke-tested in production: `code_writer` actions returned `no handler registered for action 'github_read_file'` because the deployed engine's `lib/handlers.js` HANDLERS map had no entries for code_writer. The earlier zip's `code_writer.js`, `github_writer.js`, and `api/*_webhook.js` also used CommonJS (`require`/`module.exports`) which fails to load in this engine's ESM project (`"type": "module"` in package.json).

Verified during patch construction by:
1. ESM module-load test against the real engine source: all 6 code_writer handlers resolve as functions
2. Dispatcher test: unknown action returns the exact prod-observed error string
3. Validation tests: missing-input handlers fail fast with `retryable=false`

## Files in this zip (drop-in replace, same paths)

| Path | What it does |
|---|---|
| `lib/handlers.js` | Existing dispatcher PLUS 6 new HANDLERS map keys + import block. **Only ~10 line diff** vs current production. |
| `lib/agents/code_writer.js` | NEW ESM agent. 6 handlers (read/list/branch/patch/PR/merge). Resolves repo via `project_registry` or `product_repos`. Routes token by repo owner. |
| `lib/clients/github_writer.js` | NEW ESM client. Wraps GitHub REST endpoints needed for write ops. Same shape as existing `lib/clients/github.js`. |
| `lib/handlers.patch.js` | Now an empty deprecated marker. Was unused (CommonJS, never imported). |
| `api/github_webhook.js` | ESM stub returning HTTP 410 + new endpoint URL. Stops the runtime crashes. |
| `api/vercel_webhook.js` | Same — ESM stub returning 410. |

## What's already done (DB side, applied earlier this session)

- `agent_capabilities` rows for `code_writer` (6 actions) — registered
- `agent_routes` row for `fix_code` intent → `[code_writer, repo, deployment]` — registered
- `action_registry` rows for the 6 actions — registered
- Webhook ingestion now happening via Edge Functions at `https://mvdjyjccvioxircxuzgz.supabase.co/functions/v1/{github_webhook,vercel_webhook}` — verified live (founder_alerts + deployments rows landing)

## Deployment (mobile-only OK)

1. Open `https://github.com/PranixQuick/pranix-agent-engine` on phone
2. **Add file** for each path above (or drag-and-drop the unzipped folder via web UI)
3. Commit to `main`
4. Vercel auto-deploys
5. After ~60s, this session can verify by enqueueing the smoke test (`github_read_file` on README.md)

## What this enables (after deploy)

| Capability | Status post-deploy |
|---|---|
| `submit_command('fix cart2save useSearchParams')` from `/founder/commands` | Will route through `fix_code` → code_writer → opens PR |
| `code_writer` reads any file in any registered repo | Live via GITHUB_PAT/GITHUB_SECONDARY_PAT routed by owner |
| Founder dashboard shows new PR in `founder_alerts` immediately | Yes — `code_writer.github_create_pr` writes alert |
| All write ops require approval before merge | Yes — gate is in router/command layer, not in code_writer itself |

## Risks

- Worker is ESM-pure; module load test passed on a fresh sandbox install. Vercel cold-start should resolve identically.
- If `GITHUB_PAT` or `GITHUB_SECONDARY_PAT` are missing at runtime, the relevant tasks fail fast with retryable=true (worker will try once more then hold). Doppler already provides both per prior verification.
- If deploy fails for any reason, current Vercel project supports instant rollback via the dashboard.
