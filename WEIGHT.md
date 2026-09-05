# Weight tab — portable specification

Self-contained spec of the daily-dashboard **Weight** tab, written so the feature can be
rebuilt or embedded in another project without access to this repo. Source of truth here:
[`weight.html`](weight.html) (single file, ~600 lines, no build step) + [`weight-data.json`](weight-data.json).

Sections **2b** and **4b** are the v2 additions — waist series, staleness and gap flags,
actual-vs-planned rate against a safety band, and waypoint semantics for a target that is
still inside the obese range. They are written as a **data and behaviour contract**, so a
port can implement them without reading the DOM.

---

## 1. What it is

A weight-journey page: weekly scale averages plotted from the start of a fitness journey,
with BMI zones, milestone markers, an adjustable projection to a target weight, a
date simulator, and playful weight-loss equivalents — plus an actual-vs-planned rate view
against a sustainable-loss band, an optional waist series, and freshness flags that say out
loud when the last weigh-in is too old to trust. Bilingual (EN/HR), light/dark themed,
mouse-wheel zoomable. Pure static HTML+JS — data comes from one small JSON file.

## 2. Data contract — `weight-data.json`

```json
{
  "meta": {
    "version": "wt-1.2",
    "asOf": "2026-09-03",            // last measured day (drives the staleness rules, §2b)
    "refreshedAt": "2026-09-03T18:25:00+02:00",  // ISO 8601 with offset
    "note": "weekly scale averages, manually updated"
  },
  "config": {
    "heightM": 1.73,                  // used for all BMI math
    "targetKg": 90,                   // default target (slider overrides, persisted)
    "ratePerMonth": 1.8               // default loss rate kg/month (slider overrides)
  },
  "weeks": [                          // ascending; one entry per measured week
    { "d": "2025-11-20", "w": 130.5 } // d = weigh-in date (ISO), w = weekly avg kg
  ],
  "waist": [                          // OPTIONAL, ascending; may be absent or empty
    { "d": "2026-09-05", "cm": 104 }  // d = measurement date (ISO), cm = one decimal max
  ]
}
```

Rules: `weeks` is append-only, ascending by date, gaps allowed (missed weeks are simply
absent — the chart connects across them). Weight is a weekly average, one decimal. `d` is
the **weigh-in date**, not necessarily a Monday — every rate in §4b divides by the real day
gap, so the entries never need to be week-aligned. Update is **manual**: append a week,
bump `meta.asOf` + `meta.refreshedAt`. Requires ≥ 2 entries (week-over-week delta is
computed unguarded).

`waist` is the same idea for a tape measure, at whatever cadence the user manages
(monthly is the intent). It is **optional at every level** — the key may be missing, present
and empty, or hold a single entry — so every consumer must guard it: no waist panel, no
waist dataset, no waist delta when there are fewer than two entries. Dates are measurement
dates, not week starts, and they need not line up with `weeks`. Waist matters because it
tracks visceral risk independently of a BMI that heavy strength training inflates; the same
number may also be mirrored as a `waist` field in `clinical-data.json`'s markers, and
neither file is authoritative over the other.

## 2b. Freshness, staleness and gaps

The scale is the only external check on the food log, so the page has to be loud when it is
out of date. Three rules, all computed from data, none stored:

- **Stale**: `daysStale = today − meta.asOf`; when `daysStale > 14`, an amber pill next to
  the title reads `⚠ stale data — Nd` (HR: `⚠ podaci zastarjeli — N dana`) and is hidden
  otherwise. A number that is a fortnight old is not "current weight". Note it keys on
  `meta.asOf`, not on the last `weeks[].d` — `asOf` is the last day actually *measured*.
- **Gap**: any adjacent pair in `weeks` more than 14 days apart. The rate chart labels that
  bar `⚠ Nd` in amber (§4b). This dataset contains a 67-day gap (2026-06-25 → 2026-08-31)
  that went unflagged for its whole duration and silently corrupted every rate figure
  computed across it.
- **Span note**: whenever a delta or rate is computed across a gap, say the span. "−3.0 kg"
  reads as a week's work; "−3.0 kg over 67 days" reads as 0.31 kg/week, which is the truth.
  Every rate on this page is therefore per-week-normalised by real elapsed days, never
  "per entry".

Staleness is a display state, never a data mutation — the page must not interpolate,
carry forward, or synthesise a missing week.

## 3. Page layout (top to bottom)

1. **Header** — title + EN/HR buttons + font-size toggle (CSS `zoom:1.5` class `big`) +
   the staleness pill (`#staleChip`, hidden unless `asOf` is more than 14 days old — §2b).
2. **KPI cards**: Current weight (+ week range) · Last weigh-in Δ (🔥 if best drop of
   the trailing 8) · Total lost (click cycles the equivalent shown, hover tooltip
   translated) · BMI (+ next zone boundary in kg) · Target (+ ETA date + BMI at target +
   the waypoint note of §4b) · Rate of loss (+ 4wk / journey / plan sub-line).
3. **Progress bar** — start → target, 🏃 emoji at `%`, 🏆 at the end, % label centered.
4. **The Journey chart** (Chart.js) — see §4.
5. **Rate-of-loss chart** (`#rg`) — bars per weigh-in interval over the 0.5–1.0 kg/week
   safety band — see §4b.
6. **Waist card** (`#card-waist`) — empty state, or latest cm + delta + mini chart — §4b.
7. **Planner cards** — target-weight slider `70–110 step 0.5`, rate slider
   `0.2–4 step 0.1` kg/month, live ETA sentence; Crystal-ball `<input type=date>` → §5.
8. **Milestone chips** — every achieved milestone + "next: −N kg at X (Y to go)" +
   a Ryanair cabin-bag joke chip once total lost ≥ 10 kg.
9. **Equivalents grid** — total lost expressed in 🐈 house cats (4.5 kg), 🎳 bowling
   balls (7.26), 🛞 car tires (9.5), 👶 toddlers (12), 🍺 beer crates (15.6), 🧳 cabin
   bags (10), plus kcal-derived 🍕 whole pizzas (lost×7700 / 2000) and 🥐 bureks (÷600).

## 4. The chart

**Axes.** x = linear day-number scale: `day = round((Date.parse(d) − Date.parse(weeks[0].d)) / 86400000)`
(all ISO dates parse as UTC midnight, so the grid is DST-safe). Tick labels format the
day-number back to a locale date. y = kg, `min = floor(min(target, current) − 4)`,
`max = ceil(startWeight + 2)`.

**Datasets.**
- `w` — weekly averages, solid line (#2caaf0), points.
- `proj` — projection, dashed (#E0A53C): from the last data point, weekly steps,
  `y = max(target, lastW − rate × (x − lastDay)/30.44)` (30.44 = mean days/month),
  capped at `lastDay+1100`; a flat tail extends 45 days past the ETA.
- `tgt` — horizontal dotted target line (#1D9E75), two far-out points.
- `sim` — single pink diamond (#f06fa0) at the simulated date (hidden when no date).

**Plugins (custom, inline).**
- *Zones*: horizontal bands between BMI-boundary weights (`BMI × heightM²`):
  40+/35–40/30–35/25–30/<25, translucent red→green fills, right-aligned playful labels
  ("final boss 💀 / mini-boss 👾 / levelling up 🎮 / endgame 🏹 / ninja zone 🥷").
- *Marks*: dashed vertical "today" line (`today = max(lastDay, floor((Date.now()−start)/86400000))`
  — **floor, not round**, else "today" becomes tomorrow every afternoon); milestone emojis
  above their points; the sim value label.
- Solid theme-aware background fill (for canvas export consistency).

**Milestones (computed from data, not stored).**
- 🏅 every −5 kg from start, `k = 5…60`: first week whose `w ≤ start − k`.
- 👑 each BMI class crossed (40/35/30/25): first week `w ≤ BMI×h²`, labelled "BMI under N 👋".
- 🎄/🍔 biggest week-over-week **gain** above +0.4 kg — 🎄 "holidays happened" when the month
  is December or January, else 🍔 "a feast happened".
- 🔥 biggest week-over-week drop.
- "Next" chip: `next = floor(lost/5)*5 + 5` (floor+5, **not** `ceil(lost/5)*5` — that
  breaks at exact multiples of 5).

**Interaction** — chartjs-plugin-zoom: wheel zoom (mode x), drag pan, pinch,
`limits: {x: {min:-10, max:lastDay+1150, minRange:28}}`; double-click = reset to the
default view (data + projection to ETA). Range buttons: 3M / 6M / ALL / 🔮 (to-target)
via `chart.zoomScale('x', {min,max})`.

> ⚠️ **Critical gotcha**: with chartjs-plugin-zoom **2.0.1**, the `plugins.zoom` config
> MUST be inside the `new Chart()` constructor options. The plugin wires its Hammer
> pan/pinch recognizers once, in its `start` hook, from the options present at creation —
> assigning `chart.options.plugins.zoom` afterwards leaves drag-pan and pinch permanently
> dead (wheel still works, which masks the bug). Fixed in plugin ≥ 2.1.0, but pin the
> config-in-constructor pattern anyway. Load order: chart.js → hammer.js → plugin, then
> `Chart.register(window.ChartZoom)`.

**Known trade-off**: while the `big` font mode (CSS `zoom:1.5`) is active, drag-pan moves
~1.5× the cursor distance (Hammer reports visual pixels, the chart works in local pixels).
Cosmetic; accepted.

## 4b. Rate chart and the safety band

The journey chart answers "where am I going". A second, smaller chart answers the question
that actually predicts whether you get there: **how fast am I losing, right now, compared
with how fast the planner assumes.**

**The rate series** (`computeRates()`). One value per *adjacent pair* of `weeks` entries,
plotted at the later date:

```
days = d[i] − d[i-1]
lr   = (w[i-1] − w[i]) / (days / 7)      // kg per week, POSITIVE = losing
```

Rendered as a bar chart (canvas `#rg`, `type:'bar'`, `barPercentage 0.6`), x = the same
linear day-number scale as the journey chart, y ticks suffixed `kg/wk`.

**Safety band** (`bandPlug`, `beforeDatasetsDraw`). A translucent green band filled between
y = **0.5** and y = **1.0** kg/week — the sustainable-loss corridor
(`rgba(29,158,117,0.16)` dark / `0.12` light). At 108.4 kg that is 0.46 – 0.92 % of body
weight per week. Read it in both directions:

- **Below the band** → the deficit is not producing what the log claims. This is the
  reconciliation signal: a logged ~950 kcal/day deficit implies ~0.86 kg/week, and the scale
  in this dataset has been running 0.31 – 0.42 kg/week. The gap is unlogged food, not a
  broken metabolism.
- **Above the band** → too fast; lean-mass and gallbladder risk under a heavy lifting load.
- **Inside** → nothing to say. Do not celebrate the band.

**Bar colour** (`rateState(lr)`) — six states, aligned with the 0.5–1.0 safety band so a
bar's colour never contradicts where it sits relative to the shaded band:

| Range (kg/week, loss positive) | Colour | State word (EN / HR) |
|---|---|---|
| `lr > 1.5` | red `#E24B4A` | too fast / prebrzo |
| `1.0 < lr ≤ 1.5` | amber `#E0A53C` | fast / brzo |
| `0.5 ≤ lr ≤ 1.0` | green `#1D9E75` | in band / u pojasu |
| `0.1 ≤ lr < 0.5` | amber `#E0A53C` | slow / sporo |
| `−0.1 < lr < 0.1` | grey `#9b9b93` | flat / stagnacija |
| `lr ≤ −0.1` | red `#E24B4A` (reuses the "bad" colour) | regain / vraćanje |

A legend row under the chart (`#rLegend`) names all six labels in both languages, and the
tooltip appends the state word after the kg/week figure. With this table the green range
and the band are now the same interval — a 0.31 kg/week bar (the current since-previous
rate) renders amber "slow", not green, because it sits below the 0.5 floor.

**Gap markers** (`gapPlug`, `afterDatasetsDraw`). Any bar whose pair spans `days > 14` gets
an amber `⚠ Nd` label above the bar (below it for a negative rate), and the tooltip appends
`· gap Nd`. This is what makes a −3.0 kg bar legible as "0.31 kg/week over 67 days".

**Rate KPI card** (`fillRateKPI()`). Headline value = the **since-previous** rate
(`sincePreviousRate()`, the last adjacent pair). Sub-line joins three figures with `·`:

| Figure | How |
|---|---|
| `4wk:` | `rollingRate()` — least-squares slope over every weigh-in with `day ≥ today − 28`, ×7, sign-flipped so positive = losing. `null` (renders `—`) with fewer than 2 points in the window, which is the honest answer, not a single-point rate. |
| `journey:` | first entry → last entry, per week |
| `plan:` | `cfg.rate / 30.44 × 7` — the planner slider converted from kg/month to kg/week, followed by `ahead by` / `behind by` the difference from the since-previous rate |

**Planner slider vs the band.** The slider is in **kg/month**, the band in kg/week; the
conversion factor is 30.44/7 = 4.35, so 0.5 – 1.0 kg/week ≈ **2.2 – 4.3 kg/month**. The
config default `ratePerMonth: 1.8` therefore sits *below* the band (≈0.41 kg/week) — a
conservative plan, not an error, but the `plan:` figure exists so the choice is visible
rather than accidental.

**Waist panel** (`fillWaist()`). Its own card, guarded on `DAT.waist` (defaulted to `[]` in
`init()`):

- **0 entries** → the card shows only an italic empty state ("No waist measurements yet —
  tape at navel, monthly." / HR equivalent). No chart, no axis, no zero.
- **≥ 1 entry** → latest value in cm, the delta vs the previous measurement (signed, `−` for
  a reduction), and a one-line rationale ("Waist tracks visceral fat better than BMI at your
  muscle mass").
- **≥ 1 entry** also draws a small line chart on its own canvas in the existing purple
  accent `#a64ce8` (no new token), x = day-number, y ticks suffixed `cm`.

Waist falling while weight is flat is the single most useful thing this page can show, and
it is invisible on a kg-only chart.

**Waypoints, and what 90 kg actually is** (`waypointNote(targetKg)`). `config.targetKg` is
90 kg. At `heightM` 1.73 that is **BMI 30.1** — still, by one decimal, inside obesity
class I. So whenever `bmi(target) ≥ 30` the target card appends:

> = BMI 30.1 — still obesity class I; treat as a waypoint. BMI <30 needs <89.8 kg,
> <25 needs <74.8 kg

and the note is **empty** once the chosen target drops below BMI 30 (no nagging at a target
that is already in range). Boundary weights are always `BMI × heightM²`, never hard-coded:
BMI 40 = 119.7 kg · 35 = 104.8 kg · 30 = 89.8 kg · 25 = 74.8 kg. (Current 108.4 kg =
BMI 36.2, class II.) The point of the note is that the target line is a **waypoint, not a
finish line** — worth a milestone, not the end of the journey.

## 5. Planner math

- **ETA**: `daysToTarget = (current − target) / rate × 30.44`; ETA = lastDataDate + that.
  If `months > 60`, show the joke ("ETA: heat death of the universe 🌌") instead of a date.
  If `current ≤ target`: "Target reached 🏆".
- **Crystal ball** (`simW(day)`):
  - future (`day > lastDay`): projection formula, clamped at target (clamped case gets its
    own sentence: "you'd already be at target by then…");
  - past (`day ≤ lastDay`): **linear interpolation between the two surrounding recorded
    weeks** (clamped to endpoints) — the rearview mirror: "on {date} (history) · X kg
    heavier than today — look at you now 💪";
  - cleared/invalid input → `simDay = null`, output "—", marker removed.
  - Input is clamped to `[firstWeek, lastDay+1100]`.
- **Persistence**: `{target, rate}` in `localStorage["wt-planner"]`; JSON config supplies
  defaults; sliders are the only writers (browser-sanitized, no validation needed).
- **Progress %**: `(start − current) / (start − target)`, clamped 0–100.

## 6. i18n & theming conventions (dashboard-wide pattern)

- Static labels: elements carry `data-i="key"`; `setLang(l)` swaps `textContent` from a
  `T = {en:{…}, hr:{…}}` map. Computed sentences are generated per-language inside the
  fill functions. Attribute translations (tooltips) are set explicitly in `setLang`.
- **Croatian declension**: nouns after decimal quantities take genitive singular. Each
  equivalent has two HR forms — `hr` (gen. plural, for captions under a bare number:
  "kućnih mačaka") and `hrd` (decimal form, after "4,2": "kućne mačke"). Months: "11,9
  **mjeseca**" (not "mjeseci"). Numbers format via `toLocaleString('hr-HR')` (comma decimal).
- Theme: CSS variables on the wrapper (`#wwrap` light / `#wwrap.dark`), and a global
  `applyTheme('light'|'dark')` the host shell calls into the iframe. Chart text colors are
  recomputed globals re-read on `chart.update()`. Standalone port: drive `applyTheme` from
  `matchMedia('(prefers-color-scheme: dark)')` instead.
- Layout: responsive breakpoint at 560 px (`mobile` class, smaller fonts, taller chart).

## 7. Embedding vs standalone

As used here, the page lives in an auto-resizing same-origin `<iframe scrolling="no">`;
the shell measures **`document.body.scrollHeight`** (NOT `documentElement` — that is
floored at the iframe's own height, making frames grow-only) and pushes theme via the
iframe's global `applyTheme`. For a standalone port: drop nothing — the page has no
dependency on the shell; just self-drive the theme (above) and serve `weight-data.json`
from the same origin (`fetch(..., {cache:'no-store'})`).

**Dependencies (CDN, no build):** Chart.js 4.4.1 · hammer.js 2.0.8 ·
chartjs-plugin-zoom 2.0.1 (cdnjs). Everything else is vanilla.

## 8. Design tokens

Surfaces: light `#ffffff`/`#f1efe8`, dark `#262624`/`#33322f`. Accents: weight line
`#2caaf0`, projection `#E0A53C`, target `#1D9E75`, sim marker `#f06fa0`, purple accent
(sliders / target card / waist series) `#a64ce8`. Score-style semantics: green ≥ good, amber
mid, red poor — zone fills at 8–10% alpha so they read in both themes. The rate chart reuses
the same three: green `#1D9E75`, amber `#E0A53C`, red `#E24B4A`, with its safety band as a
green fill at 12–16% alpha and gap warnings in amber. No new tokens were added for v2.
