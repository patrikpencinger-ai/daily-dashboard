# Patrik · Daily Dashboard

A single-page dashboard with three tabs — **Sleep & recovery**, **Training**, and
**Intake**. `index.html` is a thin shell that embeds three standalone dashboard pages,
each with its own dark/light + EN/HR + font-size controls.

```
daily-dashboard/
├── index.html     ← tab shell — embeds the three pages below, auto-sizes them
├── sleep.html     ← rich sleep & recovery dashboard (Chart.js, self-contained)
├── training.html  ← rich training dashboard (Chart.js, self-contained)
├── intake.html    ← intake dashboard — reads data.json
├── data.json      ← THE data layer for Intake — edit this to refresh intake
└── README.md
```

Each page also opens on its own (e.g. `sleep.html` directly) — the shell just stitches
them into one tabbed view and resizes each embed to fit its content.

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

- **Sleep & Training** (`sleep.html`, `training.html`) currently carry their data inline
  (they're snapshots from a Claude/Freddy export). To refresh, regenerate the page in a
  Claude chat and overwrite the file.
- **Intake** (`intake.html`) reads `data.json` — the lightweight path:
  1. Ask Claude (Freddy connected) to output an updated `data.json` in the same shape.
  2. Replace `data.json`, then `git commit -am "refresh" && git push`.

No credentials live in the repo.

### `data.json` shape (Intake — keep keys identical)
- `meta` — as-of dates per source
- `intake` — `date`, `dayType`, `target {kcal,p,c,f}`, `total {kcal,p,c,f}`, `tdee`, `log[]`

(`sleep` and `training` keys may still exist in `data.json` from the earlier version;
they're no longer read by the current pages and can be left or removed.)
