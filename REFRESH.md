# Refresh procedure — sleep & training

This is the exact spec a Claude agent follows to refresh the dashboard data. The agent
must have the **wearable/health connector** (Garmin + Hevy + Intervals.icu, a.k.a. "Freddy")
and **git push** access to this repo.

**On-demand:** in a Claude session with the connector + this repo, say *"refresh the
dashboard"*. The agent runs the steps below and pushes. **Scheduled:** the same steps run
from the Claude app routine **`dashboard-morning-refresh`** (attempts at 06:00, 06:30,
07:00, 07:30 — the first run that finds fresh Garmin data does the work, the rest are
catch-ups for a late watch sync).

Each refresh rewrites only `sleep-data.json` and `training-data.json` — never the HTML,
never the three manual data files (§1e) — then commits and pushes. **Cloudflare Workers
static assets** redeploy from `main` automatically (~1 min) to **dash.er45.com**.

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

For **per-set HR peaks** (best-effort, legacy series `num.mld`): for each new strength
session of a lift already present in `mld` (currently `trap`, `goblet`, `hack`), pull the
Garmin activity's 1-second HR stream (raw), anchor the main block at the post-warmup
trough, take the first N peaks where N = main-compound set count from Hevy. Append the new
session to the matching `mld.<lift>` array; flag `cf:0` if detection is uncertain (renders
a `*`). **`mld` is a per-set-HR archive, not a training plan** — two of its three lifts
(`trap`, `goblet`) are no longer in the programme. It must never be used to decide what to
prescribe; §3 slot 3 reads `num.gym[].lift` instead.

## 1b. Night attribution — label nights by the EVENING they start

Garmin dates a sleep record by its **wake** date (`calendarDate`). The dashboard instead
labels every night by the **evening it belongs to = calendarDate − 1 day**, regardless of
whether bedtime fell before or after midnight. Example: sleep 00:11 → 05:25 on Sat Jul 4
(calendarDate 2026-07-04) is the **Friday–Saturday night** and is displayed under **Fri 3**.
An "untracked night" is an *evening slot* with no record (calendarDate D missing ⇒ the
D−1 evening is the untracked one). The "last night" panel on the morning of day D uses the
record with calendarDate D (labeled D−1). User preference — do not revert to wake-date labels.

**One exception:** `num.trend[]` (§1d) is keyed on the raw Garmin `calendarDate`, because it
is a *daily physiological series* (RHR exists on days with no sleep record), not a
night-slot series. Do not shift those dates by −1.

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
gym:  {d, l, t, vol, sets, reps, mx, av, tmax, tmin, dur, kcal, lift, top}
swim: {d, l, t, dist, sec100, pace, mx, av, lengths, spm, tmax, tmin, dur, kcal}
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
  rather than publishing a junk split. (Two sessions currently sit null on
  this rule: 2026-06-26 and 2026-07-18.)
- `tmax` / `tmin` = that day's Zagreb **outdoor AIR** high/low, one decimal, from
  Open-Meteo's free archive endpoint (no key needed):
  `https://archive-api.open-meteo.com/v1/archive?latitude=45.815&longitude=15.982&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&daily=temperature_2m_max,temperature_2m_min&timezone=Europe%2FZagreb`.
  Fetch the needed date range in one call and map by date. If the API call
  fails, set `tmax`/`tmin` to `null` for the affected rows and say so —
  never invent a temperature. **These are air temperatures, on gym rows and
  swim rows alike. They are NOT water temperature.** Any label or narrative
  sentence that cites them must say "air" — a bare "temp" next to a swim
  reads as pool/lake temperature and is wrong.

### New in v2 — `dur`, `kcal`, `lift`, `top`

| Field | On | Source / formula | Null when |
|---|---|---|---|
| `dur` | gym, swim | `round(activity_durationInSeconds / 60)`, integer minutes | Garmin activity missing |
| `kcal` | gym, swim | `activity_activeKilocalories`, integer (active, **not** gross/total) | Garmin activity missing |
| `lift` | gym | classified from `t` — rule ladder below | never — falls through to `"other"` |
| `top` | gym | `{w, reps}` of the heaviest set of the session's main compound, from the Hevy **raw sets** | no Hevy workout, or `lift === "other"` |

**`lift` rule ladder** — case-insensitive, first match wins, evaluate in this order:

| # | Test on the title | `lift` | Title on disk today |
|---|---|---|---|
| 1 | contains `hack` | `hack` | `Hack Squat day` |
| 2 | contains `front` | `front` | `Squats day front loaded barbell` |
| 3 | contains `dead lift` / `deadlift` **and not** `trap` | `bbdl` | `Barbell DEAD LIFT☀️` |
| 4 | contains `trap` | `trap` | `Trap bar deadlift day ☀️` |
| 5 | contains `goblet` | `goblet` | *(none since 2026-06-01)* |
| 6 | contains `squat` (rule 2 already took the front-squat titles) | `squat` | `Squats day` |
| 7 | anything else | `other` | `Strength` |

Order matters twice: `hack` before `squat` (`"Hack Squat day"` contains both), and `front`
before `squat` (`"Squats day front loaded barbell"` contains both). Rule 3's `not trap`
guard is what keeps `"Trap bar deadlift day"` out of `bbdl`. `goblet` stays in the
enumeration because `mld` holds historic goblet sessions; no `num.gym` row uses it.

**`top` rule.** From the Hevy raw sets of that workout, keep only the sets belonging to the
exercise that produced `lift` (the main compound); take the set with the highest
`weight_kg`; break ties on the higher rep count. Emit `{w, reps}` with `w` in kg. Warm-up
sets are included in the max only if Hevy did not flag them — the heaviest set is the
heaviest set either way. Emit `null` (not `{}`, not `{w:0}`) when there is no Hevy workout
for that date, or when `lift` is `"other"` (no identifiable main compound). Five of the 35
rows on disk are currently `null`: 2026-06-23 (`hack`, Hevy never synced) and the four
`other` sessions (2026-06-25, 07-09, 07-11, 07-14).

**Backfill vs append.** `dur`/`kcal`/`lift`/`top` were backfilled across the whole history
once. From now on they are written **only on the newly appended row**. Never recompute
`lift` or `top` for existing rows — a title-rule change would silently rewrite history.

## 1d. Recovery trend (`sleep-data.json` → `num.trend`)

`num.trend[]` is the long recovery series that RHR/HRV baselines, sleep-debt counting and
the readiness rules are built on. The 7-night `num.week` arrays stay as they are; `trend`
is the memory behind them.

Row shape (exact keys, ascending by `d`):
```
{d, rhr, hrv, score, durH, deepH, awakeMin}
```
- `d` = the Garmin **wake** `calendarDate` (see the §1b exception), ISO.
- `rhr` = `daily_restingHeartRateInBeatsPerMinute`, integer.
- `hrv` = `hrv_lastNightAvg`, integer ms.
- `score` = `sleep_overallSleepScore`, integer.
- `durH` = `sleep_durationInSeconds / 3600`, 2 decimals.
- `deepH` = `sleep_deepSleepDurationInSeconds / 3600`, 2 decimals.
- `awakeMin` = `round(sleep_awakeDurationInSeconds / 60)`, integer.

**Rules — all four are hard:**

1. **Append-only.** Each run appends one row for today's `calendarDate` if it is not
   already there. It never rewrites, reorders, renumbers or re-derives an existing row.
   The only permitted edit to history is correcting a row that is provably wrong, and the
   refresh report must say which row and why.
2. **One row per calendar day, including untracked nights.** If Garmin has no sleep record
   for a day, still emit the row: `hrv`, `score`, `durH`, `deepH`, `awakeMin` = `null`,
   and keep `rhr` if the daily RHR exists (it usually does — the watch measures it
   awake too). Never skip the day; a gap in the array must mean "no data of any kind",
   which consumers read as a hard break in the series. 8 of the 91 rows on disk are
   untracked nights in exactly this shape.
3. **Minimum 90 days of retention, and never trim.** The array is not a rolling window.
   It currently runs 2026-06-07 → 2026-09-05 (91 rows). Nothing in the refresh may drop
   the head of the array to keep the file small; if the file ever needs shrinking that is
   a separate, deliberate decision, not a refresh side effect.
4. **Consumers must tolerate absence.** Any page reading `trend` has to work when the array
   is missing entirely, when it is shorter than the baseline window it wants, and when
   individual sleep fields are `null`. Baselines fall back: 28-day mean → 7-night mean →
   no baseline shown at all. Never compute a mean across `null`s.

## 1e. Files the routine must never touch

The scheduled refresh — and any "refresh the dashboard" run without an explicit user
instruction — stages **exactly two files**:

```
sleep-data.json      ← automated (this document, §1, §1b, §1d)
training-data.json   ← automated (this document, §1, §1c)
```

These three are **manual only**. They change when the user supplies the content, never as
a side effect of a refresh:

| File | Owned by | Changed when |
|---|---|---|
| `data.json` | food log (§3b) | the message contains a food block, or the user asks for a food edit |
| `weight-data.json` | scale + tape (§3c) | the user supplies a weekly average or a waist measurement |
| `clinical-data.json` | clinic + pharmacy (§3d) | the user says "add clinical: …" |

Also never touched by a refresh: every `*.html` file, `wrangler.toml`, `.assetsignore`,
and the `.md` docs. Stage files by name — `git add sleep-data.json training-data.json` —
**never `git add .` or `git add -A`**, which is how a half-finished HTML edit from another
session ends up in a refresh commit.

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

- Stamp `meta.refreshedAt` (ISO 8601 with offset, e.g. `2026-09-05T06:20:50+02:00`) on each
  file you rewrite = the moment of refresh, and `meta.snapshot` = the data date. The shell
  reads `meta.snapshot` (sleep, training), `meta.intake_asof` (`data.json`) and `meta.asOf`
  (`weight-data.json`) for the Last-refresh chips, and `meta.refreshedAt` for their hover
  titles. For `data.json`, set `refreshedAt` when a food block is written.

Keep the JSON **keys and structure identical** — only values change. See the current
`sleep-data.json` / `training-data.json` as the canonical shape.

## 3. Regenerate the analysis text (EN + HR) — fixed-slot spec

Every text field is rewritten in **both languages** from the fresh numbers: the last-night
deltas (`c1d`–`c5d`), the sleep `today`/`badge`/`rec`, and the training `k1d`–`k4d`,
findings (`i1t`–`i4`), `today`/`rec`, and the `eNote`/`bNote`/`wNote`. Every sentence must
be traceable to a number in the file being written (or in `data.json` / `weight-data.json`,
which may be *read*).

### 3a. `rec` — four slots, in this order, nothing else

`text.<lang>.rec` in **both** `training-data.json` and `sleep-data.json` is one string made
of exactly four slots, in order, written as plain sentences with no headings, numbering or
labels. **Each slot ≤ 60 words in EN** (HR is the same four slots in the same order with
the same numbers; it may run ~10% longer for grammar). **Whole `rec` ≤ 240 words EN.**

| Slot | Name | What it must contain | Reads from |
|---|---|---|---|
| 1 | **TREND** | One sentence with numbers: the thing that moved. Training `rec` → this week's tonnage and ACWR vs the previous week, or swim pace vs the previous swim, whichever moved more. Sleep `rec` → duration / score / RHR / HRV against the 28-day baseline (7-night if 28 is short). | `num.gym[].vol`, `num.swim[].sec100`, `num.trend[]` |
| 2 | **FLAG** | The **single** most important risk right now, named with the number that triggered it — or the literal word "none" when nothing trips. Never two flags. | see the flag ladder below |
| 3 | **PRESCRIPTION** | Exactly one next session. Gym: `lift / sets × reps / load kg`. Swim: `distance / interval / target pace per 100`. Nothing else — no alternatives, no "or". | `num.gym[].lift` + `num.gym[].top` |
| 4 | **LEVER** | One nutrition or sleep lever, tied to a number from today. Not general advice. | `data.json` targets/log, `num.sleepWake`, `num.trend[]` |

**Flag ladder (slot 2).** Evaluate in order, report the first that trips, stop:

1. **ACWR > 1.3** — acute (last 7 d tonnage) ÷ chronic (28 d tonnage ÷ 4). Cite both the
   ratio and the acute tonnage.
2. **Top-set jump > 10%** — the most recent `top.w` for a lift vs that same lift's previous
   `top.w`. Cite the two loads and the percentage.
3. **Sleep debt** — count of nights under 7 h in the last 7 `trend` rows with a non-null
   `durH`. Cite the count and the shortfall in hours.
4. **RHR / HRV divergence** — RHR above its 28-day baseline while HRV is below its own.
   Cite both numbers and both baselines.
5. Nothing tripped → **"none"** (or its HR equivalent). Say it in one short clause and move
   on; do not pad the slot to justify the absence.

**Prescription rule (slot 3) — the hard one.** The prescribed lift **must** appear in
`num.gym[].lift` within the **last 4 weeks** (today − 27 days … today). A lift that is only
in `num.mld`, or whose last `num.gym` appearance is older than 4 weeks, is **retired** and
must never be prescribed, no matter how long the "gap" since it was last done. *The gap is
not a debt — it is the athlete's programme changing.* Anchor the load to the most recent
`top` for the prescribed lift; when the flag in slot 2 is ACWR > 1.3 or a top-set jump,
the prescription must be the reduced/alternative session, not the same load again.

**Ban list — none of this may appear in any `rec`, in either language:**

- Window-boundary artifacts: "first week in the window", "only two lifting days sit in the
  window now", "fewer sessions on this board than the previous board". The window moving is
  not news.
- Detection-confidence talk: "detection is uncertain", "flagged `cf:0`", "the `*` means",
  anything about how the data was derived.
- Hedging about data availability: "if you logged more days", "assuming the missing days",
  "data is incomplete so". Either the number is there and you use it, or the sentence does
  not exist.
- **More than one prescription.** One session. Not "goblet today, and keep two swims a
  week, and log Friday, and bedtime 22:30".
- A "Next: …" recap sentence at the end restating the four slots.
- Prescribing a retired lift (see above).

**Worked example of the shape** (numbers from `training-data.json` as of 2026-09-05 — this
is the shape to hit, not a template to reuse):

> Tonnage is 27,720 kg over the last seven days against 45,112 the week before, with the
> 28-day chronic load at 26,670 kg a week — an ACWR of 1.04. *(slot 1)*
> The flag is the hack-squat top set: 170 kg × 12 on Aug 27 became 200 kg × 6 on Sep 3, a
> 17.6% load jump in seven days — tendon adaptation lags that by weeks. *(slot 2)*
> Next session: front squat, 4 × 8 at 80 kg — the load held on Aug 23 and Aug 29.
> *(slot 3)*
> Fat is the lever: Thursday logged 51 g against the 70 g training-day floor, and all three
> logged days landed 49–51 g. Add ~20 g of fat to a main meal. *(slot 4)*

### 3b. Other text fields

`today` is a short label (≤ 8 words). `badge` is a one-line headline, ≤ 12 words, one
number in it. `i1t`–`i4t` are titles (≤ 6 words); `i1`–`i4` are one to three sentences
each. `eNote` / `bNote` / `wNote` cite the specific numbers of their own chart. The ban
list above applies to all of them.

## 3c. Food intake (`data.json`) — manual, only when a food block is supplied

`data.json` is NOT pulled from the connector — it's user-logged food. Only touch it when
the triggering message includes a food JSON block (pasted from the "fitness journey" chat)
or an explicit food edit. Shape:

- `meta` — `intake_asof`, `refreshedAt`, `weekStart`, `note`.
- `athlete` — `{weightKg, age, heightCm, bmr, restTdee}`. Currently
  `108.4 kg · 47 y · 173 cm · bmr 1935 · restTdee 2420` (Mifflin-St Jeor, ×1.25).
- `targets` — the canonical macro targets **by day type**:
  `"training day": {kcal 2200, p 180, c 212, f 70}`, `"rest day": {kcal 1750, p 180, c 111, f 65}`.
- `days[]` — one entry per logged day: `{date, dayType, target, tdee, tdeeNote, log[], veg?}`.
  `target` is the resolved copy of `targets[dayType]` — write it out on the day so the day
  is self-describing, and keep it identical to the `targets` block. `total` is optional —
  the site auto-sums `log`, so omit it. `veg` (integer, portions of vegetables/fruit/
  legumes, target 5/day) is **optional and must be ABSENT when it was not logged** — never
  write `0` for "not logged", the two mean different things. `wholegrainG` is optional in
  the same way.

Never pro-rate a partial day into a weekly figure. If no food block is supplied, leave
`data.json` unchanged.

## 3d. Weight (`weight-data.json`) — manual, like food

`weight-data.json` holds weekly scale averages (`weeks[]` of `{d: weigh-in date, w: avg kg}`
— `d` need not be a Monday), an optional `waist[]` series (`{d, cm}`, currently empty), plus
`config` (heightM, targetKg, ratePerMonth defaults). NOT pulled from the connector — update only when the user supplies new numbers
("update weight", "waist 104"). Append new entries, bump `meta.asOf` (last measured day)
and `meta.refreshedAt`. See [`WEIGHT.md`](WEIGHT.md) for the full contract. The scheduled
morning refresh must never touch this file.

## 3e. Clinical (`clinical-data.json`) — manual

`{meta, markers[], meds[], symptoms[]}`, all three arrays possibly empty (they are, today).
Written only when the user says *"add clinical: …"* — a blood-pressure reading, a lab
panel, a new medication or supplement, a symptom. Field list and row shapes are documented
inside `health.html` ("How to update this record") and mirrored in [`MANUAL.md`](MANUAL.md).
Any field may be omitted from a row. The scheduled morning refresh must never touch this
file.

## 4. Commit & push

```
git add sleep-data.json training-data.json   # + data.json if food was updated
git commit -m "refresh: data for <YYYY-MM-DD>"
git push
```

Cloudflare redeploys `main` to dash.er45.com in about a minute. `.assetsignore` keeps
`*.md`, `wrangler.toml`, `.assetsignore` and `.gitignore` out of the published asset set,
so docs are versioned but not served.

## Notes / gotchas
- Hevy sync lags Garmin by a few hours — a same-day lift may be in Garmin but not Hevy
  yet. Leave its `vol`/`sets`/`reps`/`top` and the per-set peaks null; the next refresh
  fills them. This is why the routine has four attempts, half an hour apart.
- The watch itself has to sync to the phone before Garmin Connect has anything to serve. A
  refresh that finds yesterday's data is a sync-lag symptom, not a connector failure.
- Attribute Garmin data as "Garmin fenix 8" per the connector's brand requirement.
- Two different "BMR" numbers, on purpose. **`num.burn.bmr` = 2,414** is the *Garmin daily
  baseline* (what the watch reports as resting burn) and it drives the training bridge
  (`bal = int − (2414 + exnet)`) and the current-day placeholder when
  `daily_bmrKilocalories` reads low on the incomplete day — keep it at 2,414 unless Garmin's
  own baseline changes. **`athlete.bmr` = 1,935** (Mifflin-St Jeor, 108.4 kg / 173 cm / 47 y)
  is the *intake* model in `data.json`: rest TDEE `athlete.restTdee` 2,420 (×1.25), basal
  during exercise ~81 kcal/h (1,935 ÷ 24) subtracted from the gross Garmin session burn
  before it is added to the day's TDEE. The routine never writes `athlete.bmr` into
  `training-data.json`; the Training tab labels 2,414 as "Garmin daily baseline".
- `tmax`/`tmin` are air temperature. Say "air" wherever they are cited (§1c).
