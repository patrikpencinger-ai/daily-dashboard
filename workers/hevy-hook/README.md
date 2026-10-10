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
| `src/hrmatch.js` | HR-peak↔set matcher. A 1:1 port of the anchor matcher in `tools/build_strength.py` (see "HR-peak matching" below). |
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

## HR-peak matching (`hrMatch`)

When the HR trace is attached, the Worker also matches every Hevy set to an HR peak, so the live card shows per-set peaks before the morning pipeline runs. `src/hrmatch.js` is a 1:1 port of the default `anchor` matcher in `tools/build_strength.py` (st-1.1). It ports the artifact filter (spikes, frozen-run dropouts merged when < 90 s apart, from the 15-min mark), 1 Hz interpolation over gaps ≤ 12 s, the 5 s median + 5 s mean smoothing, candidate detection, the anchor search (exercise 1's work sets, main block = Garmin duration − 20 min ± 5), the exhaustive warm-up match before the anchor, the forward DP, per-set confidence and the short-rest, near-artifact and steep-rise caps. The tunables come from `tools/strength-config.json`, which is bundled at build time, so the Python and the Worker read one file.

The input is the full-resolution stream (the `hr:<stravaId>` doc, not the 5 s `hr` preview), so the Worker sees the same samples as `build_strength.py` sees in `raw/strava_hr`. The set structure travels in the pending item's `sync.skel`, so the cron retry can match without refetching the workout from Hevy.

The record gets one additive field, `hrMatch`. It is omitted when there is no HR or when no set matched.

```
hrMatch: {method:"anchor-js", version:"st-1.1", hrStart, expected, matched, conf, confSetsPct,
          anchor:{exercise, tPeaks[], peakHR[], score, sets} | null, warmupEndS, streamEndS,
          shortRests, nearArtifact, artifacts:{spikes, dropoutS},
          sets:[{ex, set, tPeak, peakHR, tStart, hrStart, riseS, hrDelta, restBeforeS, hrr30, hrr60,
                 conf, [shortRest], [nearArtifact], [steepRise]}]}
```

Times (`tPeak`, `tStart`, `warmupEndS`) are seconds from `hrStart`, which is the start of the HR stream. Unmatched sets have null fields and `conf` 0. An unedited re-ingest keeps `hrMatch`. An edit drops it, and the next Strava step recomputes it from the cached stream. A matcher error is logged as stage `hrmatch` and never blocks the pipeline. The morning `strength-data.json` stays the source of truth.

Float sums use `math.fsum` semantics (`pySum`), and rounding is Python's half-even rounding (`pyfmt.js`). On 2026-10-10 all 1346 sets of the 83 HR sessions in the caches matched `strength-data.json` exactly, in every per-set field and every anchor. To check parity against the local caches:

```
node scripts/parity-hrmatch.mjs [--ref strength-data.json] [--raw-dir DIR] [--json OUT.json]
```

This pairs sessions exactly like `build_strength.py` (Strava preferred over a Garmin twin, duplicate Hevy ids resolve to the newest copy, joined by date). It then compares each set with `setRows` (tPeak ±1 s, equal peakHR, conf ±0.02, plus an exact all-field count and the anchors). It exits 1 below 99 %.

## Endpoints

| Method and path | Response |
|---|---|
| `POST /hook/hevy` | The `Authorization` header must equal `WEBHOOK_AUTH`. It is compared in constant time, and `Bearer <value>` is accepted too. The body is `{"workoutId":"…"}`. Returns 200 `{"ok":true}` at once and does the work in `waitUntil`. Returns 401 on bad auth and 400 on a bad body. |
| `GET /live/recent?days=14` | `{generatedAt, workouts:[…]}` for `days` from 1 to 14, newest first (the item schema is in the contract). Sent with `Cache-Control: max-age=30`. |
| `GET /live/health` | `{ok, status, lastWebhookAt, lastCronAt, pending, missingSecrets:[names], kv, lastError, mode, spendTodayUsd, maxUsdPerDay}`. `status` is `"degraded"` while secrets are missing. `ANTHROPIC_API_KEY` is not in `missingSecrets`, because mode `current` needs no key. It never contains secret values. |
| `GET /live/narrative?days=14` | Public, CORS as for `/live/recent`. Returns `{mode, items:[{workoutId\|null, kind:"workout"\|"daily", createdAt, model, effort, en:{trend,flag,prescription,lever}, hr:{…}}]}`, newest first, for `days` from 1 to 30, at most 30 items. See [API mode](#api-mode-claude). |
| `POST /live/pipeline` | Auth as for the webhook. This is the Mac strength-cron heartbeat `{host, ranAt, changed, commit, durationS, errors[]}`. It is stored in KV `pipeline:last` with `receivedAt`, and `/admin/status` shows it. |
| `/admin/*` | Requires a Cloudflare Access JWT. See [API mode](#api-mode-claude). |
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
| `ANTHROPIC_API_KEY` | `anthropic.env` (`ANTHROPIC_API_KEY=sk-ant-…`). Used only in API mode. A full push skips it with a note when the file is missing. |

To push them all (only the names are printed):

```powershell
powershell -ExecutionPolicy Bypass -File tools\set_live_secrets.ps1          # add -DryRun to validate only
powershell -ExecutionPolicy Bypass -File tools\set_live_secrets.ps1 -Only ANTHROPIC_API_KEY
```

There are also two plain vars in `wrangler.toml` (`[vars]`), and they are not secrets. `ACCESS_AUD` is the AUD tag of the Cloudflare Access application that covers `/admin/*`. While it is empty, every `/admin/*` request answers 503. `MAX_USD_PER_DAY` is the daily spend cap and defaults to `1.00`.

To connect Hevy (there is no API for this, so it is done in the web UI):

```
python tools\hevy_webhook_subscribe.py --copy     # prints the steps, copies the header value
python tools\hevy_webhook_subscribe.py test       # one authenticated test call for your latest workout
```

## API mode (Claude)

The contract is in `.foreman/api-contract.md`. KV `cfg:mode` sets the mode, and you switch it in the Admin tab (`PUT /admin/config`):

- **`current`** is the default. The Worker never calls the Claude API, so the spend is 0. The tabs show the narrative that the morning routine writes into the JSON files.
- **`api`** makes the Worker write the coach narrative itself. It writes one after each webhook workout (`narrative_workout`) and one daily (`narrative_daily`) from the `40 5 * * *` cron. It also answers "Ask the coach" (`coach_chat`). Switching back to `current` stops all calls. The tabs fall back to the JSON text.

| File | Role |
|---|---|
| `src/claude.js` | Calls the Messages API with raw `fetch` (anthropic-version `2023-06-01`). The `thinking` parameter is omitted, so thinking is adaptive, and depth is set by `output_config.effort`. `budget_tokens`, `temperature` and `tool_choice` are never sent. Opus and Sonnet requests add `fallbacks:"default"` and the beta header `server-side-fallback-2026-07-01`; Haiku has no server-side fallback, so they are left out. `stop_reason` `refusal` (with its `stop_details` category) and `max_tokens` are handled explicitly. 429, 5xx and network errors are retried at most twice, honouring `Retry-After` (otherwise 2 s, then 4 s). Each attempt has a 60 s timeout. `GET /admin/ping` uses `GET /v1/models`, which is free. |
| `src/narrative.js` | Holds `STATIC_RULES`, the cached system block (about 3.1K tokens). It is the coach role, then REFRESH.md §3a and "Load definitions" copied verbatim, then the units, an EN→HR glossary and an example. It also holds the JSON schema `{en,hr}×{trend,flag,prescription,lever}`, the config, the runs, the webhook hook and its queue, and the daily run. |
| `src/context.js` | Builds the compact context from KV: the last 5 sessions (with the top set per exercise), four rolling 7-day tonnage windows, ACWR, hard sets per muscle over 7 days, the top-set change per lift, and the HR-match summary of the newest session. It is at most 3K tokens. |
| `src/usage.js` | Holds `PRICES` and keeps the ledger: KV `usage:<Zagreb date>` (TTL 400 d) and `usage:recent` (the last 50). It also does the daily cap and the aggregation by day, week, month, function or model. |
| `src/access.js` | Verifies `Cf-Access-Jwt-Assertion`: RS256 via WebCrypto, with the JWKS from `summer-smoke-ba3e.cloudflareaccess.com` cached for 1 h. It checks `exp`, `nbf`, `iss`, and that `aud` equals `ACCESS_AUD`. |
| `src/admin.js` | The `/admin/*` router. CORS uses the public allow-list, and `Access-Control-Allow-Credentials` is sent only for `https://dash.er45.com`. |

**Admin endpoints.** Each needs a valid Access JWT, or it gets 401. With `ACCESS_AUD` empty, each gets 503.

| Method and path | Response |
|---|---|
| `GET /admin/config` | `{mode, functions:{<fn>:{model,effort,maxTokens,enabled}}, allowed, prices, maxUsdPerDay, crons}` |
| `PUT /admin/config` | Body `{mode?, functions?}`. `model` must be one of claude-opus-5-5, claude-sonnet-5-5 or claude-haiku-5-5. `effort` must be low, medium or high. `maxTokens` must be an integer from 100 to 2000, and `enabled` must be a boolean. Any error gives 400 `{errors[]}`, and then nothing is stored. |
| `GET /admin/usage?from&to&group` | `group` is day, week, month, function or model. The default range is the last 30 Zagreb days, and the maximum is 366 days. Returns `rows:[{key, calls, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, usd, errors, skipped}]` and `totals`. |
| `GET /admin/usage/recent` | `{items}`: the last 50 calls, each `{ts, fn, model, effort, in, cacheRead, cacheWrite, out, usd, ms, ok, err, …}` |
| `POST /admin/narrative/run` | Body `{workoutId: "<id>"\|"latest"\|"daily"}`. It needs mode `api` (409 otherwise). A manual run ignores `enabled`, and a manual daily run overwrites today's daily narrative. Unknown id → 404, cap reached → 429, API error → 502. |
| `POST /admin/coach` | Body `{question (at most 1000 characters), lang:"en"\|"hr"}`. Returns `{answer, truncated, model, usage, usd}`. The answer is plain text of at most 250 words. It uses the same cached system block as the narrative. It needs mode `api`. |
| `GET /admin/status` | `{mode, functions, apiKeyConfigured, spendTodayUsd, maxUsdPerDay, capReached, cron, lastWebhookAt, lastError, dailyNarrative, narrativeQueue, pipeline, lastErrors, kv:{workouts,pending,hr,narratives}}` |
| `GET /admin/ping` | `{ok, status, ms, error?}`. This is a key check that spends no tokens. |

**Spend.** Each call is logged with its tokens and its USD cost. `usd = (in×input + cacheRead×cacheRead + cacheWrite×cacheWrite + out×output) / 1e6`, at the rates per MTok in `PRICES` (`src/usage.js`):

| Model | input | output | cache read | cache write |
|---|---|---|---|---|
| claude-opus-5-5 | 4 | 20 | 0.20 | 5 |
| claude-sonnet-5-5 | 2 | 10 | 0.20 | 2.5 |
| claude-haiku-5-5 | 0.10 | 0.50 | 0.01 | 0.125 |

Worked examples (these are in `test/usage.test.mjs`):

1. Opus 5.5 with a cache write: 1,200 in + 2,600 cache write + 450 out = 4,800 + 13,000 + 9,000 = **$0.0268**.
2. The same call with a cache read: 4,800 + 520 + 9,000 = **$0.01432**.
3. Haiku 5.5: 3,000 in + 2,600 cache read + 600 out = 300 + 26 + 300 = **$0.000626**.

The API's `input_tokens` already leaves out the cached tokens. When a server-side fallback ran, `usage.iterations` is summed, and each attempt is priced at its own model's rate. An unknown model is priced at the Opus rate. Before each call, today's spend (the Europe/Zagreb day) is compared with `MAX_USD_PER_DAY`. At or above the cap the call is skipped and logged as `{skipped:true, reason:"cap"}`.

**Webhook narrative.** In mode `api`, the webhook's `waitUntil` first puts the workout on `narr:queue` and then calls Claude inline. `waitUntil` lasts only about 30 s, so if it is cut off, the next `*/10` cron finishes the queued item. The cron waits 5 min after queueing, makes at most one call per run, gives an item at most 2 attempts, and drops it after 6 h. Refusals, `max_tokens`, the cap and schema errors are not retried. A re-sent webhook for a workout whose `updatedAt` has not changed costs nothing.

**Daily cron and DST.** Cron runs in UTC. `40 5 * * *` is 07:40 in Zagreb in summer time (CEST) and 06:40 in winter time (CET, from the last Sunday of October). Keep `DAILY_CRON` in `src/narrative.js` the same as `wrangler.toml`. The daily run writes at most one narrative per Zagreb date.

**KV keys.**

| Key | Contents |
|---|---|
| `cfg:mode`, `cfg:functions` | The mode and the per-function config |
| `narr:<workoutId>`, `narr:daily:<date>` | Narratives (TTL 30 d) |
| `narr:index` | The list that `/live/narrative` reads |
| `narr:queue` | Webhook narratives waiting for the cron |
| `meta:narrDaily` | The last daily run |
| `usage:<date>`, `usage:recent` | The usage ledger |
| `pipeline:last` | The Mac heartbeat |

**Coach rules.** `REFRESH_3A` and `LOAD_DEFS` in `src/narrative.js` are verbatim copies of REFRESH.md. `test/claude.test.mjs` fails as soon as REFRESH.md changes. To fix it, paste the new section text into the two constants, escaping backticks as `` \` ``. The cached prefix must not hold dates or other per-run values.

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
