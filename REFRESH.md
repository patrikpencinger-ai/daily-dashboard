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

## 1b. Night attribution — label nights by the EVENING they start

Garmin dates a sleep record by its **wake** date (`calendarDate`). The dashboard instead
labels every night by the **evening it belongs to = calendarDate − 1 day**, regardless of
whether bedtime fell before or after midnight. Example: sleep 00:11 → 05:25 on Sat Jul 4
(calendarDate 2026-07-04) is the **Friday–Saturday night** and is displayed under **Fri 3**.
An "untracked night" is an *evening slot* with no record (calendarDate D missing ⇒ the
D−1 evening is the untracked one). The "last night" panel on the morning of day D uses the
record with calendarDate D (labeled D−1). User preference — do not revert to wake-date labels.

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

## 3c. Weight (weight-data.json) — manual, like food

`weight-data.json` holds weekly scale averages (`weeks[]` of `{d: week-start, w: avg kg}`)
plus `config` (heightM, targetKg, ratePerMonth defaults). NOT pulled from the connector —
update only when the user supplies new weekly averages ("update weight" + numbers). Append
new weeks, bump `meta.asOf` (last measured day) and `meta.refreshedAt`. The scheduled
morning refresh must never touch this file.

## 4. Commit & push

```
git add sleep-data.json training-data.json   # + data.json if food was updated
git commit -m "refresh: data for <YYYY-MM-DD>"
git push
```

## 1c. Gym & swim session history (`num.gym` / `num.swim`)

Two long-running arrays sit inside `num`, right after `mld`: `num.gym` (every
`STRENGTH_TRAINING` activity since 2026-06-01) and `num.swim` (every
`LAP_SWIMMING` / `OPEN_WATER_SWIMMING` activity since 2026-06-01), both
ascending by date. **Each refresh APPENDS the new day's session(s) to these
arrays — never rebuild or reorder the history.** A day with more than one
swim (e.g. several short open-water dips) gets one array entry per activity,
not one per day.

Schema (exact keys, do not rename or add):
```
gym:  {d, l, t, vol, sets, reps, mx, av, tmax, tmin}
swim: {d, l, t, dist, sec100, pace, mx, av, lengths, spm, tmax, tmin}
```
- `d` = ISO date, `l` = short label (`"Sep 3"`), `t` = session title.
- `gym.t` = the Hevy `workout_title` when a Hevy workout exists for that
  date, else the Garmin `activity_activityName`.
- `gym.vol` / `sets` / `reps` = Hevy `workout_total_volume_kg` /
  `workout_set_count` / `workout_total_reps`. If Hevy has no matching
  workout (sync lag — see gotchas below), set all three to `null` rather
  than dropping the session; the Garmin HR is still real and belongs in
  the array.
- **`mx` / `av` are the ACTIVITY-level max/avg HR** (Garmin
  `activity_maxHeartRateInBeatsPerMinute` / `activity_averageHeartRateInBeatsPerMinute`)
  — the same convention `num.daily` already uses on activity days. Do NOT
  use the daily aggregate HR, and do NOT use `mld`'s per-set-peak average
  (that `av` is the mean of the `pk` array, a different number).
- `swim.dist` = `activity_distanceInMeters` rounded to a whole metre;
  `lengths` = `activity_numberOfActiveLengths` (null if absent — open-water
  swims usually lack it); `spm` = `activity_averageSwimCadenceInStrokesPerMinute`
  (null if absent).
- `swim.sec100` = seconds per 100 m, derived as
  `round(activity_averagePaceInMinutesPerKilometer × 60 / 10)`; `swim.pace`
  is that value formatted `"M:SS"` (e.g. 136 → `"2:16"`).
  **Sanity gate: `sec100` must land in [60, 300].** Garmin's open-water pace
  reads garbage on short/interrupted dips (treading water, GPS drift) —
  when the computed value falls outside that range, set both `sec100` and
  `pace` to `null` for that session and note it in the refresh report
  rather than publishing a junk split.
- `tmax` / `tmin` = that day's Zagreb outdoor high/low, one decimal, from
  Open-Meteo's free archive endpoint (no key needed):
  `https://archive-api.open-meteo.com/v1/archive?latitude=45.815&longitude=15.982&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&daily=temperature_2m_max,temperature_2m_min&timezone=Europe%2FZagreb`.
  Fetch the needed date range in one call and map by date. If the API call
  fails, set `tmax`/`tmin` to `null` for the affected rows and say so —
  never invent a temperature.

## Notes / gotchas
- Hevy sync lags Garmin by a few hours — a same-day lift may be in Garmin but not Hevy
  yet. Leave its volume/set-peaks null; the next refresh fills them.
- Attribute Garmin data as "Garmin fenix 8" per the connector's brand requirement.
- `daily_bmrKilocalories` reads low on the *current* (incomplete) day — use the standing
  BMR (2,414) not the partial value.
