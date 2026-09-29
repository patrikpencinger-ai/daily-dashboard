# hevy-hook: live Hevy webhook Worker

A Cloudflare Worker that receives Hevy's "workout saved" webhook and does three things. It computes a live preview of the workout (totals and per-muscle load) for the dashboard. It renames the matching Strava activity and writes the Hevy log into its description. It attaches the heart-rate trace from that Strava activity.

The morning pipeline (`tools/hevy_fetch.py` → `tools/build_strength.py`) stays the source of truth for `strength-data.json`, including HR-peak↔set matching. This Worker only provides a preview for the 14 days before that.

- **LIVE_BASE:** `https://hevy.er45.com` (custom domain). The fallback is `https://hevy-hook.patrik-pencinger.workers.dev`.
- **Contract:** `.foreman/live-contract.md`
- **No npm dependencies.** Only `fetch`, `crypto` and KV are used. The `package.json` exists only to set `"type": "module"` and hold scripts.

## Architecture

```
Hevy app ──POST /hook/hevy──▶ Worker ──200 {"ok":true} (fast)
                               │ ctx.waitUntil
                               ├─ GET api.hevyapp.com/v1/workouts/{id}   (retry 429/5xx, backoff)
                               ├─ totals/muscles  (src/strength.js = build_strength.py port,
                               │                   templates.json + KV t:<id> + /exercise_templates/{id})
                               ├─ KV w:<id>  (+ index)
                               └─ Strava: token refresh (KV strava:tokens) → list activities
                                  [start-6h, end+90min] → match (±90 min, WeightTraining/Workout,
                                  closest start, 1:1) → PUT name+description (src/format.js =
                                  strava_sync.py port; skipped when identical and ours) → streams
                                  time,heartrate → 5 s bins → hr
cron */10 ─▶ pending retries (p:<id>, 10 min for 1 h then 30 min, dropped after 24 h)
          └▶ hourly (never at :00): GET /v1/workouts/events?since=…  → new/edited → w:<id> + queued
                                                                    → deleted   → remove w:<id>
Dashboard ──GET /live/recent, /live/health──▶ Worker (CORS: dash.er45.com, 127.0.0.1:8100, localhost:8100)
strava_sync.py ──GET /live/hr?since, /live/hr/<id>, POST /live/strava/sync (Authorization)──▶ Worker ──▶ Strava
```

| File | Role |
|---|---|
| `src/index.js` | Router, the `fetch` and `scheduled` handlers |
| `src/api.js` | Authenticated local-pipeline API: `/live/hr`, `/live/hr/<id>`, `/live/strava/sync` (single Strava token owner) |
| `src/process.js` | Pipeline: webhook, Strava sync, pending queue, events poll, cron |
| `src/format.js` | Strava name and description. A 1:1 port of `tools/strava_sync.py` (`build_description`). |
| `src/strength.js` | Totals and muscles. A 1:1 port of the per-workout block of `tools/build_strength.py`. |
| `src/pyfmt.js` | Python-compatible rounding: half-even on the exact binary value (`round`, `:.2f`, `:,.0f`) |
| `src/match.js` | Strava↔Hevy time-overlap matching and the 5 s HR downsample |
| `src/strava.js` | Strava client: rotating refresh token, retry on 5xx, pause on rate limits (429 or headers) |
| `src/hevy.js` | Hevy client: retry and backoff on 429/5xx, events pagination |
| `src/store.js` | KV layout (see the top of the file) |
| `templates.json` | Compact `{id: [primary, [secondary], equipment]}`. Regenerate with `node scripts/gen-templates.mjs`. |

`w:` records have a TTL of 20 days, and `/live/recent` serves at most 14 days. The status of each record is one of:

| Status | Meaning |
|---|---|
| `received` | Stored, but Strava has not been done yet (no secrets configured, or the retries were given up) |
| `strava-pending` | No matching Strava activity yet (the watch has not uploaded), or a Strava error or rate limit. The cron retries it. |
| `strava-renamed` | The Strava activity was renamed, but it has no HR stream |
| `hr-attached` | The Strava activity was renamed and the HR trace is attached |

## Endpoints

| Method and path | Response |
|---|---|
| `POST /hook/hevy` | The `Authorization` header must equal `WEBHOOK_AUTH`. It is compared in constant time, and `Bearer <value>` is accepted too. The body is `{"workoutId":"…"}`. Returns 200 `{"ok":true}` at once and does the work in `waitUntil`. Returns 401 on bad auth and 400 on a bad body. |
| `GET /live/recent?days=14` | `{generatedAt, workouts:[…]}` for `days` from 1 to 14, newest first (the item schema is in the contract). Sent with `Cache-Control: max-age=30`. |
| `GET /live/health` | `{ok, status, lastWebhookAt, lastCronAt, pending, missingSecrets:[names], kv, lastError}`. `status` is `"degraded"` while secrets are missing. It never contains secret values. |
| `GET /live/hr?since=YYYY-MM-DD` | Auth as for the webhook (401 otherwise). Returns a JSON array of the WeightTraining/Workout activities since that date: `[{stravaId, name, startTime, startDateLocal, workoutId\|null, sampleCount\|null}]`. `sampleCount` is null while the stream is not cached yet. |
| `GET /live/hr/<stravaId>` | Auth. Returns the full-resolution HR doc in the `raw/strava_hr` schema that `build_strength.py` reads: `{startTime, sampleCount, streams:{heart_rate:{unit,values}}, timestamps, source:"strava", stravaId, name}`. It comes from KV `hr:<id>` (TTL 20 d), or is fetched from Strava and cached. 404 `code:"no-hr"` when the activity has no stream. |
| `POST /live/strava/sync?days=N` | Auth. Runs the `strava_sync.py sync` rename/description pass over the last N days (1–30, default 3; `&dryRun=1`, `&force=1`). Returns the counts and a per-activity `items` list. |
| `OPTIONS /live/*` | CORS preflight: 204 |
| Other method or path | 405 for the known paths, 404 for anything else |

## Secrets (Worker secrets, set by you)

| Name | Source (`%USERPROFILE%\.claude\cache\daily-dashboard\secrets\`) |
|---|---|
| `HEVY_API_KEY` | `hevy.env` (`HEVY_API_KEY=…`) |
| `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` | `strava.json` |
| `STRAVA_REFRESH_TOKEN` | `strava.json` `refresh_token`. This is only the seed: rotated tokens are kept in KV `strava:tokens`. |
| `WEBHOOK_AUTH` | `hevy-webhook.txt` (random, 32 bytes as hex) |

To push all five (only the names are printed):

```powershell
powershell -ExecutionPolicy Bypass -File tools\set_live_secrets.ps1          # add -DryRun to validate only
```

To connect Hevy (there is no API for this, so it is done in the web UI):

```
python tools\hevy_webhook_subscribe.py --copy     # prints the steps, copies the header value
python tools\hevy_webhook_subscribe.py test       # one authenticated test call for your latest workout
```

## Redeploy

```powershell
cd workers\hevy-hook
node --test test/            # or, from the repo root: node --test workers/hevy-hook/test/
npx wrangler deploy
```

The static site Worker in the repo root (`wrangler.toml` there) is separate. The site deploy skips `workers/` through `.assetsignore`.

To refresh the bundled templates after `build_strength.py --refresh-templates`, run `node scripts/gen-templates.mjs` and then redeploy. Templates missing from the bundle are fetched from Hevy once and cached in KV anyway.

Logs: `npx wrangler tail hevy-hook`, or Workers → hevy-hook → Logs in the dashboard (observability is on).

## Rotate WEBHOOK_AUTH

1. Generate a new value:

   ```
   python -c "import secrets,pathlib,os;p=pathlib.Path(os.environ.get('ZG_CACHE') or pathlib.Path.home()/'.claude/cache/daily-dashboard')/'secrets'/'hevy-webhook.txt';p.write_text(secrets.token_hex(32)+'\n');print('written',p)"
   ```

2. Push it to the Worker:

   ```
   powershell -ExecutionPolicy Bypass -File tools\set_live_secrets.ps1 -Only WEBHOOK_AUTH
   ```

3. Update the header value in Hevy (Settings → Developer → Webhooks):

   ```
   python tools\hevy_webhook_subscribe.py --copy
   ```

4. Check that the rotation worked:

   ```
   python tools\hevy_webhook_subscribe.py test
   ```

Webhooks that arrive between steps 2 and 3 get a 401. The hourly events poll picks those workouts up anyway.

## Strava token: single owner

This Worker is the **only** Strava API client. Strava may rotate the refresh token on every refresh, so two refreshers would invalidate each other. The local `tools/strava_sync.py fetch-hr` and `sync` therefore go through `/live/hr*` and `/live/strava/sync` by default, using `secrets\hevy-webhook.txt` as the `Authorization` header. `src/api.js` implements these endpoints; the error codes are in `.foreman/live-contract.md` (K3). The webhook path also stores the full-resolution stream in KV `hr:<stravaId>`, so the morning `fetch-hr` usually needs no Strava call.

`strava_sync.py --direct` (emergency) and `auth` are the only local Strava clients. After using `--direct`, or if Strava rejects both the Worker's KV token and the seed secret (the endpoints return 503 `code:"strava-auth"`, and `/live/health` shows `lastError` with stage `strava`), do this: run `python tools/strava_sync.py auth`, then `tools\set_live_secrets.ps1 -Only STRAVA_REFRESH_TOKEN`. The Worker tries the KV token first and then the re-seeded secret.
