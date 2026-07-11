# Weight tab — portable specification

Self-contained spec of the daily-dashboard **Weight** tab, written so the feature can be
rebuilt or embedded in another project without access to this repo. Source of truth here:
[`weight.html`](weight.html) (single file, ~450 lines, no build step) + [`weight-data.json`](weight-data.json).

---

## 1. What it is

A weight-journey page: weekly scale averages plotted from the start of a fitness journey,
with BMI zones, milestone markers, an adjustable projection to a target weight, a
date simulator, and playful weight-loss equivalents. Bilingual (EN/HR), light/dark themed,
mouse-wheel zoomable. Pure static HTML+JS — data comes from one small JSON file.

## 2. Data contract — `weight-data.json`

```json
{
  "meta": {
    "version": "wt-1.0",
    "asOf": "2026-06-27",            // last measured day (shown as freshness)
    "refreshedAt": "2026-06-27T19:55:00+02:00",  // ISO 8601 with offset
    "note": "weekly scale averages, manually updated"
  },
  "config": {
    "heightM": 1.73,                  // used for all BMI math
    "targetKg": 90,                   // default target (slider overrides, persisted)
    "ratePerMonth": 1.8               // default loss rate kg/month (slider overrides)
  },
  "weeks": [                          // ascending; one entry per measured week
    { "d": "2025-11-20", "w": 130.5 } // d = week-start date (ISO), w = avg kg
  ]
}
```

Rules: `weeks` is append-only, ascending by date, gaps allowed (missed weeks are simply
absent — the chart connects across them). Weight is a weekly average, one decimal.
Update is **manual**: append a week, bump `meta.asOf` + `meta.refreshedAt`.
Requires ≥ 2 entries (week-over-week delta is computed unguarded).

## 3. Page layout (top to bottom)

1. **Header** — title + EN/HR buttons + font-size toggle (CSS `zoom:1.5` class `big`).
2. **KPI cards** (5): Current weight (+ week range) · Last weigh-in Δ (🔥 if best drop of
   the trailing 8) · Total lost (click cycles the equivalent shown, hover tooltip
   translated) · BMI (+ next zone boundary in kg) · Target (+ ETA date + BMI at target).
3. **Progress bar** — start → target, 🏃 emoji at `%`, 🏆 at the end, % label centered.
4. **The Journey chart** (Chart.js) — see §4.
5. **Planner cards** — target-weight slider `70–110 step 0.5`, rate slider
   `0.2–4 step 0.1` kg/month, live ETA sentence; Crystal-ball `<input type=date>` → §5.
6. **Milestone chips** — every achieved milestone + "next: −N kg at X (Y to go)" +
   a Ryanair cabin-bag joke chip once total lost ≥ 10 kg.
7. **Equivalents grid** — total lost expressed in 🐈 house cats (4.5 kg), 🎳 bowling
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
- 🏅 every −5 kg from start: first week whose `w ≤ start − 5k`.
- 👑 each BMI class crossed (40/35/30/25): first week `w ≤ BMI×h²`.
- 🎄/🍔 biggest week-over-week gain > +0.5 kg (🎄 if Dec/Jan, else 🍔), labeled
  "holidays happened".
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
(sliders/target card) `#a64ce8`. Score-style semantics: green ≥ good, amber mid,
red poor — zone fills at 8–10% alpha so they read in both themes.
