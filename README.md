# Patrik · Daily Dashboard

A static, five-tab personal health dashboard — **Sleep & recovery**, **Training**,
**Intake**, **Weight**, **Health** — served at **https://dash.er45.com**.

`index.html` is a thin shell. Each tab is a standalone page in a same-origin `<iframe>`,
and **each tab fetches its own JSON data file at runtime** (`{cache:'no-store'}`). No build
step, no server code, no database, no credentials in the repo. Refreshing data means
rewriting a JSON file and pushing — the HTML never changes on a data refresh.

Every tab page also opens standalone (e.g. `sleep.html`) and carries its own EN/HR,
light/dark and font-size controls. The shell pushes its theme down into every frame
(dark is the default) and auto-sizes each frame to its content.

---

## File map

```
daily-dashboard/
├── index.html            tab shell — 5 iframes, theme push, auto-sizing,
│                         "last refresh" chips read from each file's meta
├── sleep.html            Sleep & recovery (Chart.js)  →  fetch sleep-data.json
├── training.html         Training (Chart.js)          →  fetch training-data.json
│                                                      +  fetch sleep-data.json
│                                                         (readiness / recovery input)
├── intake.html           Intake / food log            →  fetch data.json
│                                                      +  fetch weight-data.json
│                                                         (weigh-in reconciliation)
├── weight.html           Weight journey (Chart.js)    →  fetch weight-data.json
├── health.html           Clinical markers             →  fetch clinical-data.json
│
├── sleep-data.json       AUTO   sleep, HRV, RHR, 90-day recovery trend + EN/HR text
├── training-data.json    AUTO   gym + swim history, per-set HR, energy + EN/HR text
├── data.json             MANUAL food log, athlete profile, macro targets by day type
├── weight-data.json      MANUAL weekly scale averages, waist series, planner config
├── clinical-data.json    MANUAL BP, labs, medications, symptoms (empty until measured)
│
├── wrangler.toml         Cloudflare Workers static-assets config (serves the repo root)
├── .assetsignore         keeps *.md, wrangler.toml, .assetsignore, .gitignore unpublished
│
├── REFRESH.md            the exact procedure the refresh agent follows
├── MANUAL.md             the operator's manual — how you feed it data day to day
├── DASHBOARD-PROMPT.md   the instruction block for the "fitness journey" food chat
├── WEIGHT.md             portable spec of the Weight tab
└── README.md
```

## Data flow

```
  SOURCE                    WHO WRITES IT              FILE                 TAB
  ──────────────────────    ────────────────────────   ──────────────────   ─────────
  Garmin fenix 8  ┐
  Hevy            ├──────▶  routine                ▶  sleep-data.json    ▶  Sleep
  Intervals.icu   ┘         "dashboard-morning-       training-data.json ▶  Training
  Open-Meteo (air temp) ▶    refresh" (06:00-07:30)

  you, in a chat        ▶  Claude, on request     ▶  data.json          ▶  Intake
  scale + tape measure  ▶  Claude, on request     ▶  weight-data.json   ▶  Weight
  clinic / pharmacy     ▶  Claude, on request     ▶  clinical-data.json ▶  Health

                    git push to main
                          │
                          ▼
              Cloudflare Workers static assets  ──▶  https://dash.er45.com  (~1 min)
```

Two tabs read a **second** file as well: Training also fetches `sleep-data.json` (recovery
is an input to what you should lift today), and Intake also fetches `weight-data.json` (a
food log is only credible against the scale). Cross-tab reads are one-way — a tab never
writes a file it does not own.

**Automated vs manual — the line matters.** The scheduled routine stages **only**
`sleep-data.json` and `training-data.json`. It is forbidden from touching `data.json`,
`weight-data.json` and `clinical-data.json` (REFRESH.md §1e), because those hold things
only you can know: what you ate, what the scale said, what the lab said. Nothing in this
repo auto-syncs food, weight or clinical data.

---

## How it refreshes

**Automatically.** The Claude app routine **`dashboard-morning-refresh`** runs at 06:00,
06:30, 07:00 and 07:30. The first attempt that finds fresh Garmin data pulls sleep +
training, rewrites the two auto files (numbers *and* the bilingual EN/HR analysis text),
commits and pushes; the later attempts are catch-ups for a slow watch→phone sync.
[`REFRESH.md`](REFRESH.md) is the spec it follows, down to the field formulas and the
four-slot format of the coaching text.

**By hand.** In a Claude session that has the wearable connector *and* this repo, say
`refresh the dashboard`. Same procedure, same two files.

**Food, weight, clinical.** You supply the content; Claude writes the file. See
[`MANUAL.md`](MANUAL.md) for the exact phrasings, and
[`DASHBOARD-PROMPT.md`](DASHBOARD-PROMPT.md) for the instruction block that makes the
"fitness journey" chat emit a paste-ready food block.

The header **↻ Refresh** button in the shell only re-reads the published JSON in the
browser — it does not pull anything new from the wearables.

---

## Preview locally

The pages `fetch()` their JSON and embed each other, so they must be **served**, not opened
as `file://`. A tiny static server is committed for exactly this:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .claude\serve.ps1
# then open http://127.0.0.1:8100
```

Port **8100**, root = the repo directory, correct MIME types for `.html`/`.json`.
`.claude/launch.json` registers the same thing as a launch configuration named
`dashboard`. (`.claude/` is gitignored — local tooling, not part of the site.)

Any other static server works too (`python -m http.server 8100`, `npx serve`,
VS Code Live Server) — the only requirement is that `index.html` and the JSON files are
served from the same origin.

---

## Deploy

```powershell
git add <the files you changed>
git commit -m "describe the change"
git push
```

Every push to `main` redeploys via Cloudflare Workers static assets (`wrangler.toml`,
`[assets] directory = "./"` — no build, no Worker script) to **dash.er45.com**, typically
within a minute. `.assetsignore` keeps the Markdown docs and config out of the served
asset set, so the docs are versioned here but not published.

Stage files by name. `git add .` is how an unfinished edit from another session ends up in
a refresh commit.

---

## Data contracts in one line each

| File | Shape | Notes |
|---|---|---|
| `sleep-data.json` | `{meta, num{lastNight, week, sleepWake, trend}, text{en,hr}}` | `num.trend[]` is an append-only ≥90-day series of `{d, rhr, hrv, score, durH, deepH, awakeMin}`, one row per calendar day, nulls on untracked nights |
| `training-data.json` | `{meta, num{kpis, daily, energy, burn, bridge, mld, gym, swim}, text{en,hr}}` | `num.gym[]` / `num.swim[]` are append-only session histories; gym rows carry `lift` and `top{w,reps}`; `tmax`/`tmin` are **air** temperature |
| `data.json` | `{meta, athlete, targets, targetsNote, days[]}` | targets are per **day type** (training / rest); `days[].veg` is optional and absent means "not logged", not zero |
| `weight-data.json` | `{meta, config, weeks[], waist[]}` | weekly scale averages + optional waist series — see [`WEIGHT.md`](WEIGHT.md) |
| `clinical-data.json` | `{meta, markers[], meds[], symptoms[]}` | ships empty; the Health tab renders "not yet measured" per marker |

Full field-by-field definitions live in [`REFRESH.md`](REFRESH.md) (§1c, §1d, §3c–§3e) and,
for the Weight tab, in [`WEIGHT.md`](WEIGHT.md).
