# Daily Dashboard — the operator's manual

How the dashboard gets its numbers, and what *you* have to do to keep them true.

The site is static. Every tab reads its own JSON file (Training also reads sleep-data.json
for readiness, Intake also reads weight-data.json for the reconciliation). Sleep and training fill themselves from
the watch every morning; food, weight and clinical values only exist because you say them.
This document is the "you say them" half.

Live at **https://dash.er45.com** · architecture and file map in [`README.md`](README.md) ·
the machine-facing spec in [`REFRESH.md`](REFRESH.md).

---

## The big picture

```
  AUTOMATIC (you do nothing)                    MANUAL (only you can supply it)
  ─────────────────────────────────────────     ─────────────────────────────────────
  Garmin fenix 8 + Hevy + Intervals              food you ate        →  data.json
        ↓ routine "dashboard-morning-refresh"    what the scale said →  weight-data.json
        ↓ 06:00 / 06:30 / 07:00 / 07:30          tape measure        →  weight-data.json
  sleep-data.json  →  SLEEP tab                  BP / labs / meds    →  clinical-data.json
  training-data.json → TRAINING tab              ↓
                                                 you tell Claude, Claude writes the file
```

The morning routine **never** touches the three manual files. If your food log looks stale,
no automation is going to fix it — that is by design.

---

## 1. Food — the daily one

Log food where you already log it (the **"fitness journey"** chat). When you want the
dashboard current, ask that chat for **the food block** and hand it to Claude Code on this
repo. Claude writes it into `data.json` and pushes.

### What you say

> *(paste the food block)* — **`update food`**

or, if you also want sleep/training pulled in the same go, **`refresh the dashboard`** with
the block pasted in the same message.

You can also just describe an edit in plain language — *"add 200 g of cottage cheese to
today"*, *"yesterday was a rest day, not a training day"*, *"I ate 4 portions of veg today"*
— and Claude will patch `data.json` directly. The block is only the convenient bulk form.

### The food block

```json
{
  "meta": { "intake_asof": "2026-09-05" },
  "intake": {
    "date": "SAT 2026-09-05",
    "dayType": "training day",
    "tdee": 3047,
    "veg": 4,
    "log": [
      { "name": "Banana, medium", "kcal": 105, "p": 1, "c": 27, "f": 0 }
    ]
  }
}
```

Claude merges that into the `days[]` array of `data.json` and fills in `target` from the
`targets` block. The instruction that makes your chat emit exactly this shape is in
[`DASHBOARD-PROMPT.md`](DASHBOARD-PROMPT.md). Rules that matter:

| Field | Rule |
|---|---|
| `dayType` | exactly `"training day"` or `"rest day"` — it *selects the macro targets* |
| `target` | you never write it; it is copied from `targets[dayType]` in `data.json` |
| `tdee` | rest base 2,420 + the net burn of the day's session (gross Garmin kcal − ~81 kcal/h basal) |
| `veg` | optional integer, portions of vegetables/fruit/legumes, target 5/day. **Leave it out if you did not count.** Absent means "not logged"; `0` means "I ate none". They are different. |
| `total` | do not write it — the site sums `log` itself |
| `log[]` | the **whole day**, re-output in full on every change. Whole numbers. |

### The targets, and why they differ by day

`data.json` carries them once, in a `targets` block, and every day inherits from it:

| | kcal | protein | carbs | fat |
|---|---|---|---|---|
| **training day** | 2,200 | 180 g | 212 g | 70 g |
| **rest day** | 1,750 | 180 g | 111 g | 65 g |

Same weekly energy as the old flat 2,000 kcal (4 training + 3 rest ≈ 14,050 kcal/wk),
redistributed so the heaviest sessions are the best-fuelled days instead of the
lowest-carb ones. Protein is flat at 180 g (1.66 g/kg at 108.4 kg). **Fat is a floor, not a
ceiling** — 65–70 g is the minimum for hormones and for gallbladder emptying (aim ≥10 g of
fat per main meal), so going over is fine; going under is what gets flagged.

If you skip a day, skip it. **Never invent a day and never pro-rate a half-logged day** —
an honest gap is information; a smoothed-over gap is a lie that hides a ~600 kcal/day
discrepancy between what the log says and what the scale says.

---

## 2. Weight and waist

Weekly scale **averages**, one decimal, one entry per week. Just tell Claude:

> **`update weight: 108.4 for the week of Aug 31`**
> **`waist 104 today`**

Claude appends to `weeks[]` (`{d: weigh-in date, w: kg}` — it does not have to be a Monday)
or `waist[]` (`{d, cm}`) in `weight-data.json`, bumps `meta.asOf` and `meta.refreshedAt`,
and pushes.

- Missed weeks are simply absent — the chart connects across the gap and marks it.
- The Weight tab shows an amber **stale data — Nd** pill once the last measured day is more
  than **14 days** old, and labels any weigh-in interval longer than 14 days on the rate
  chart (`⚠ 67d`). The last gap in this dataset ran 67 days (2026-06-25 → 2026-08-31) and
  silently distorted every rate figure in the meantime. That is what the flags prevent.
- The rate chart draws a green **0.5–1.0 kg/week** safety band. Coming in under it is not a
  metabolism problem — it is the sign that the food log is missing days.
- Waist is worth a monthly measurement (tape at the navel, same time of day): it tracks
  visceral risk independently of a BMI that heavy lifting inflates. The card stays in its
  "no measurements yet" state until you give it one.

Full spec: [`WEIGHT.md`](WEIGHT.md).

---

## 3. Clinical values — the Health tab

`clinical-data.json` (version **`cl-2.0`**) now carries your actual record — conditions,
doctors, 24 medications with start/stop dates, every lab series, the home blood-pressure log,
the physician action plan and the red flags. It is a **private file**: it is served only
behind the login on `dash.er45.com`, and the automated refresh never touches it. It grows one
sentence at a time:

> **`add clinical: BP 118/76, pulse 61 on 2026-09-06`**
> **`add clinical: total cholesterol 5.8, LDL 3.9, HDL 1.1, triglycerides 1.7 — lab 2026-09-02`**
> **`add clinical: waist 104 cm today`**
> **`add clinical: started ibuprofen 400 mg for a strained shoulder`**
> **`add clinical: stopped Physiotens on 2026-09-10`**
> **`add clinical: right-upper-quadrant ache after a fatty meal, yesterday evening`**

Claude turns that into rows in one of three arrays. Any field may be omitted — a markers row
carries whatever that date actually has, and `source` says where it came from (`"lab"` for a
laboratory report, `"home"` for a cuff reading at home):

```json
{
  "markers":  [{"d":"YYYY-MM-DD","source":"lab|home",
                "bp_sys":n,"bp_dia":n,"pulse":n,
                "glucose":n,"hba1c":n,"insulin":n,"homa_ir":n,
                "tc":n,"ldl":n,"hdl":n,"tg":n,"creat":n,"egfr":n,
                "alt":n,"ast":n,"ggt":n,"urate":n,"tsh":n,
                "ferritin":n,"vitd":n,"plt":n,"hb":n,"wbc":n,"crp":n,
                "testosterone":n,"psa":n,"waist":n,"note":""}],
  "meds":     [{"d":"YYYY-MM-DD","stop":"YYYY-MM-DD|null","name":"","generic":"",
                "dose":"","drugClass":"","kind":"medication|supplement|nsaid","purpose":"","note":""}],
  "symptoms": [{"d":"YYYY-MM-DD","type":"chest_pressure|dyspnoea|palpitations|near_syncope|ruq_pain|dark_urine|other","note":""}]
}
```

Rules worth knowing:

- `conditions[]` rows carry `doctor` (the treating physician) alongside `name`, `since`, `status`.
- **A medication is "current" when `stop` is `null`.** Stopping one means setting its `stop`
  date, never deleting the row — the history table and the medication lines on the trend
  charts are built from stopped rows.
- **Several home readings on one day are several rows**, each with `source:"home"`. Don't
  average them into one.
- Any lab test that has no key in the list above is kept in full under `labsOther`
  (41 further analytes — immunoglobulins, iron studies, differential, prolactin, SHBG…),
  so nothing from your record is dropped.
- `units` and `ref` at the top of the file hold the unit and the laboratory reference range
  per key; the table's high/low chips are a display comparison against `ref`, not an
  interpretation.
- `symptoms` stays empty until you actually report something — it is never filled in for you.

The same shapes are printed inside the Health tab itself, under "How to update this record".
Nothing here is medical advice — the tab's job is to lay the record out in the order a doctor
asks for it, and to make the overdue and missing measurements visible.

---

## 4. Sleep & training — automatic, but here's the handle

Nothing to do. The routine **`dashboard-morning-refresh`** pulls Garmin + Hevy +
Intervals.icu, rewrites `sleep-data.json` and `training-data.json` (numbers *and* the EN/HR
analysis text), commits and pushes.

**To run it by hand:** open the Claude app → **Routines** in the sidebar → select
**dashboard-morning-refresh** → **Run now**. Use this after an evening session, or when the
morning attempts all fired before your watch had synced.

**Or in Claude Code on this repo:** say **`refresh the dashboard`**.

### Night labelling — read this once and it stops being confusing

Garmin dates a night by the morning you **woke up**. The dashboard dates it by the
**evening you went to bed** (`calendarDate − 1`). So a sleep that ran 00:11 → 05:25 on
Saturday morning shows up on the board as **Friday**. "Last night" on Saturday morning is
Garmin's Saturday record, labelled Friday. An untracked night is an *evening* with no
record.

The one exception is the 90-day recovery trend chart, which is keyed on the raw wake date
because it plots daily resting heart rate too — and RHR exists on days you did not sleep
with the watch on.

---

## 5. Saving changes

Nothing is live until it is pushed. Claude does this as part of any refresh; by hand:

```powershell
cd "C:\Users\patri\OneDrive\CLAUDE\daily-dashboard"
git add data.json                 # name the files — not "git add ."
git commit -m "intake for 2026-09-05"
git push
```

Every push to `main` redeploys via Cloudflare in ~1 minute to **https://dash.er45.com**.

To look at a change before pushing, serve the folder locally:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .claude\serve.ps1
# http://127.0.0.1:8100
```

Opening the files directly (`file://`) will **not** work — the tabs fetch their JSON, and
browsers block that outside a real origin.

---

## Troubleshooting

**The dashboard shows yesterday's sleep.**
Watch → phone → Garmin Connect sync lag. The routine fires four times (06:00–07:30) exactly
for this. If all four missed it, run the routine by hand (§4) later in the morning.

**A lift is missing its volume / top set, but the heart rate is there.**
Hevy syncs a few hours behind Garmin. The session is recorded with `vol`, `sets`, `reps`
and `top` as `null` on purpose — the Garmin heart-rate data is real and belongs on the
board. The next refresh fills the gaps in. Nothing to do.

**The routine ran but the site didn't change.**
Two different failures, and they look identical from the outside:
- *It pushed nothing.* The routine commits and pushes silently; if the pull found no new
  data it correctly changes nothing. Check `git log` — if there is no `refresh: data for
  <date>` commit for today, there was nothing to publish.
- *It pushed and you're seeing cache.* Hit **↻ Refresh** in the header (it re-reads the
  JSON) or hard-reload. Cloudflare needs about a minute after the push.

**A number on the site contradicts a number in the JSON.**
The JSON on disk wins; the page is a dumb renderer. Hover a "last refresh" chip in the
header to see exactly when that file was last written — a stale chip on the Intake or
Weight tab means *you* haven't fed it, not that the site broke.

**The coaching text prescribes something odd.**
Tell Claude what is wrong with it. The text is regenerated from scratch on every refresh
against a fixed four-slot spec (trend → flag → one prescription → one lever) in
[`REFRESH.md`](REFRESH.md) §3a; if it drifts, that spec is the thing to tighten.

**Refresh button vs routine.**
**↻ Refresh** in the page header only re-reads the published JSON in your browser. It never
pulls from the wearables. Only the routine (or `refresh the dashboard` in Claude Code)
fetches new numbers.
