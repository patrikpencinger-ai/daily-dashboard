# Patrik · Health Dashboard

A single-page dashboard integrating **Sleep**, **Training**, and **Intake** with tab
navigation, dark/light + EN/HR toggles. All data lives in `data.json` — the rendering
in `index.html` never changes, so refreshing the dashboard is a one-file edit.

```
health-dashboard/
├── index.html    ← markup + styles + rendering (don't touch to update data)
├── data.json     ← THE data layer — edit this to refresh
└── README.md
```

---

## Run it locally

`index.html` fetches `data.json`, so it must be **served**, not opened as a file
(browsers block `fetch()` over `file://`).

```bash
cd health-dashboard
python3 -m http.server 8000
# open http://localhost:8000
```

Any static server works (`npx serve`, VS Code Live Server, etc.).

---

## Put it online (no backend)

Pick one. All free, all serve static files.

**GitHub Pages**
```bash
git init && git add . && git commit -m "health dashboard"
gh repo create patrik-health --public --source=. --push
# repo → Settings → Pages → Branch: main / root → Save
```

**Vercel** — `vercel --prod` from the folder.
**Netlify** — drag the folder onto app.netlify.com/drop.

You get a live URL in under a minute. It serves whatever is in `data.json`.

---

## Refreshing the data (recommended: Claude-refresh)

The data sources (Garmin sleep/HRV, Hevy strength) aren't directly callable from a
browser. The low-friction path keeps Claude in the loop:

1. In a Claude chat with Freddy connected, ask it to pull the latest sleep / training
   metrics and your logged intake, and to **output an updated `data.json`** in this
   exact shape.
2. Replace `data.json`.
3. `git commit -am "refresh" && git push` (Pages/Vercel/Netlify redeploys automatically).

No credentials live in the repo. Updates take seconds.

### `data.json` shape (keep keys identical)
- `meta` — as-of dates per source
- `sleep.last` — score, durationMin, rhr, hrv, stage minutes, bed/wake
- `sleep.trailing7` — `[{ d, score }]`, most recent last
- `training` — status, vo2max, rhr, fitnessAge, `recent[]`
- `intake` — date, dayType, target, total, tdee, `log[]`

`hrv: null` renders as "—". Fill it once a source provides it.

---

## Going fully dynamic (optional, later)

If you want auto-refresh without Claude in the loop, add a serverless function
(Vercel/Netlify) that pulls from the **real** APIs and writes `data.json` on a schedule:

| Source | API | Notes |
|---|---|---|
| Strength | Hevy official API | clean, API-key auth |
| Workouts/plans | intervals.icu API | already connected |
| Sleep / HRV / RHR | Garmin (unofficial lib) | needs your login server-side; grey-area ToS |

Freddy stays the Claude-side analysis bridge — it isn't the web data source.
Credentials live in the serverless env, never in the repo or the browser.

Decision point: a 30-second daily paste-and-commit is often less hassle than
maintaining a Garmin scraper. Start with the Claude-refresh; graduate only if you
actually want it hands-off.
