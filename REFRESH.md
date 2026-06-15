# Refresh procedure — sleep & training

This is the exact spec a Claude agent follows to refresh the dashboard data. The agent
must have the **wearable/health connector** (Garmin + Hevy + Intervals.icu, a.k.a. "Freddy")
and **git push** access to this repo.

**On-demand:** in a Claude session with the connector + this repo, say *"refresh the
dashboard"*. The agent runs the steps below and pushes. **Scheduled:** the same steps run
from a daily cloud routine.

Each refresh rewrites only `sleep-data.json` and `training-data.json` (never the HTML),
then commits and pushes. GitHub Pages redeploys in ~1 minute.

---

## 1. Pull the data (connector `query_metrics`)

Trailing window = the most recent 7 calendar days ending today.

**Sleep (Garmin), `days: 8`** (8 so the 7-day deltas have a prior day):
`sleep_overallSleepScore`, `sleep_durationInSeconds`, `sleep_deepSleepDurationInSeconds`,
`sleep_lightSleepDurationInSeconds`, `sleep_remSleepInSeconds`, `sleep_awakeDurationInSeconds`,
`hrv_lastNightAvg`, `daily_restingHeartRateInBeatsPerMinute`, `daily_averageStressLevel`.
Then one call with `include_raw: true` for `sleep_durationInSeconds` to get per-night
`startTimeInSeconds` + `startTimeOffsetInSeconds` → local bed/wake clock times.

**Training, `days: 9`:**
`workout_title`, `workout_duration`, `workout_set_count`, `workout_total_reps`,
`workout_total_volume_kg` (Hevy); `activity_activityName`, `activity_activeKilocalories`,
`activity_averageHeartRateInBeatsPerMinute`, `activity_maxHeartRateInBeatsPerMinute`,
`activity_durationInSeconds`, `activity_distanceInMeters` (Garmin);
`daily_bmrKilocalories`, `daily_activeKilocalories`, `daily_restingHeartRateInBeatsPerMinute`.

For **per-set HR peaks** (best-effort): for each new strength session of a tracked lift
(trap-bar DL / hack squat / goblet squat), pull the Garmin activity's 1-second HR stream
(raw), anchor the main block at the post-warmup trough, take the first N peaks where N =
main-compound set count from Hevy. Append the new session to the matching `mld.<lift>`
array; flag `cf:0` if detection is uncertain (renders a `*`).

## 2. Transform into the JSON shapes

- Seconds → hours (week stage arrays) or minutes (last-night stages).
- `effort = round(durationMin × (avgHR − 53) / (174 − 53))`.
- Bed/wake decimal for the chart: evening (HH≥12) → `(HH−24)+MM/60`; early morning → `HH+MM/60`.
- `hrvAvg` = mean of the 7 nightly HRV values; duration "7-day avg" delta uses the 7-night mean.
- Energy `edaily` = `daily_activeKilocalories`; `eavg` = flat 7-day mean; `eint` = logged
  intake where known (from `data.json` / user logs), else null.
- Burn `exnet` = `daily_activeKilocalories`; `intake` = logged where known else 2000;
  `logged[]` flags which; balance computed in-page as `intake − (bmr + exnet)`.
- Rest days: set `effort/dur/kcal/vol/dist/maxhr/avghr` to `null` (RHR stays).

- Stamp `meta.refreshedAt` (ISO 8601 with offset, e.g. `2026-06-15T06:20:50+02:00`) on each
  file you rewrite = the moment of refresh. The shell shows it on hover over the
  Last-refresh chips. For `data.json`, set it when a food block is written.

Keep the JSON **keys and structure identical** — only values change. See the current
`sleep-data.json` / `training-data.json` as the canonical shape.

## 3. Regenerate the analysis text (EN + HR)

Rewrite, in both languages, from the fresh numbers: the last-night deltas (`c1d`–`c5d`),
the sleep `today`/`badge`/`rec`, and the training `k1d`–`k4d`, findings (`i1t`–`i4`),
`today`/`rec`, and the `eNote`/`bNote`/`wNote` (which cite specific numbers). Keep the
voice concise and coaching-oriented, grounded only in the pulled data.

## 3b. Food intake (data.json) — only when a food block is supplied

`data.json` is NOT pulled from the connector — it's user-logged food. Only touch it when the
triggering message includes a food JSON block (pasted from the "fitness journey" chat).
When it does: write that block to `data.json` as-is (shape: `meta.intake_asof` +
`intake{date,dayType,target,tdee,log[]}`). `total` is optional — the site auto-sums `log`,
so it's fine to omit. If no food block is supplied, leave `data.json` unchanged.

## 4. Commit & push

```
git add sleep-data.json training-data.json   # + data.json if food was updated
git commit -m "refresh: data for <YYYY-MM-DD>"
git push
```

## Notes / gotchas
- Hevy sync lags Garmin by a few hours — a same-day lift may be in Garmin but not Hevy
  yet. Leave its volume/set-peaks null; the next refresh fills them.
- Attribute Garmin data as "Garmin fenix 8" per the connector's brand requirement.
- `daily_bmrKilocalories` reads low on the *current* (incomplete) day — use the standing
  BMR (2,414) not the partial value.
