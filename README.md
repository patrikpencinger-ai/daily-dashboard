# Patrik · Daily Dashboard

A single-page dashboard with three tabs — **Sleep & recovery**, **Training**, and
**Intake**. `index.html` is a thin shell that embeds three standalone dashboard pages,
each with its own dark/light + EN/HR + font-size controls.

```
daily-dashboard/
├── index.html          ← tab shell — embeds the three pages below, auto-sizes them
├── sleep.html          ← sleep & recovery dashboard (Chart.js)   reads sleep-data.json
├── training.html       ← training dashboard (Chart.js)           reads training-data.json
├── intake.html         ← intake dashboard                        reads data.json
├── sleep-data.json     ← Sleep data + analysis (auto-refreshed from Garmin)
├── training-data.json  ← Training data + analysis (Garmin + Hevy + Intervals)
├── data.json           ← Intake data (food log / macros)
├── REFRESH.md          ← exact procedure a Claude agent follows to refresh the data
└── README.md
```

Every page is data-driven: the HTML never changes on a refresh, only the JSON does.
Each page also opens standalone (e.g. `sleep.html`).

---

## Run it locally

The pages fetch (`data.json`) and embed each other, so they must be **served**, not
opened as files (browsers block this over `file://`). Any static server works:

```bash
cd daily-dashboard
python3 -m http.server 8000   # then open http://localhost:8000
# or: npx serve   ·   or VS Code "Live Server"
```

---

## It's live online (GitHub Pages)

Pushed to GitHub and served via Pages. To update after editing any file:

```bash
git add .
git commit -m "describe the change"
git push
```

Pages redeploys automatically within ~1 minute.

---

## Refreshing the data

- **Sleep & Training** pull automatically from the wearable connector (Garmin + Hevy +
  Intervals.icu). A Claude agent runs the procedure in [`REFRESH.md`](REFRESH.md), which
  rewrites `sleep-data.json` + `training-data.json` and pushes. On-demand: say *"refresh
  the dashboard"* in a Claude session that has the connector + this repo. Daily auto:
  via a scheduled cloud routine (same procedure).
- **Intake** (`intake.html`) reads `data.json` — logged manually for now (food log).
  Edit `data.json` (or have Claude output it) and push.

No credentials live in the repo.

### `data.json` shape (Intake — keep keys identical)
- `meta` — as-of dates per source
- `intake` — `date`, `dayType`, `target {kcal,p,c,f}`, `total {kcal,p,c,f}`, `tdee`, `log[]`
