# Daily Dashboard — how it gets its data & how you fill it

This is a **static** dashboard. There is no live database and nothing auto-syncs.
Every number you see was put there by you (or by Claude on your behalf) and saved into a
file. "Updating the dashboard" = editing a file and pushing it to GitHub.

There are **two different data mechanisms** — one for Intake, one for Sleep/Training.

---

## The big picture

```
                 YOU                          THE FILES                 WHAT YOU SEE
  ─────────────────────────────────   ─────────────────────────   ──────────────────
  log food in a Claude chat ───────▶  data.json  ──────────────▶  INTAKE tab
  Garmin + Hevy (via Freddy chat) ─▶  sleep.html / training.html ▶  SLEEP / TRAINING tabs
```

- **Intake tab** reads its numbers live from `data.json`. Edit that one file → the tab
  updates. This is the easy, frequent one.
- **Sleep & Training tabs** have their numbers *baked inside* `sleep.html` and
  `training.html` (they're snapshots generated from your Garmin/Hevy data). To refresh
  them you regenerate the whole page in a Claude chat and overwrite the file.

Nothing updates until you `git push` (see "Saving changes" at the bottom).

---

## 1. INTAKE (food) — the one you'll do daily

**Yes — keep logging food in your daily intake chat with Claude.** That doesn't change.
The only new step is: at the end of the day, have that chat hand you an updated
`data.json`, which you drop into the project and push.

### The routine
1. Log your meals in your intake chat as you normally do.
2. When you want the dashboard current, paste this into that chat:

   > Output my updated `data.json` for the dashboard, using exactly this shape and keys.
   > Compute `total` as the sum of the food log. Today is a `<rest day / training day>`.
   >
   > ```json
   > {
   >   "meta": { "intake_asof": "2026-06-13" },
   >   "intake": {
   >     "date": "SAT 2026-06-13",
   >     "dayType": "training day",
   >     "target": { "kcal": 2000, "p": 160, "c": 170, "f": 75 },
   >     "total":  { "kcal": 0, "p": 0, "c": 0, "f": 0 },
   >     "tdee": 2490,
   >     "log": [
   >       { "name": "Example food 100g", "kcal": 0, "p": 0, "c": 0, "f": 0 }
   >     ]
   >   }
   > }
   > ```

3. Replace the contents of `data.json` with what it gives you.
4. Push (see bottom). The Intake tab now shows today.

### What each field does
| Field | Meaning |
|---|---|
| `date`, `dayType` | shown under the title (e.g. "SAT 2026-06-13 · training day") |
| `target` | your macro goals — the bars fill toward these |
| `total` | the day's actual totals — drives the cards, bars, and table footer |
| `tdee` | your total daily burn — the "Energy balance" deficit = `tdee − total.kcal` |
| `log[]` | each food row in the Food Log table |

Keep the **keys** exactly the same; only change the values.

> Tip: you can also just open `data.json` and type the numbers in by hand — it's only a
> few lines. The chat is just the convenient way to total things up.

---

## 2. SLEEP & TRAINING — refreshed less often, via Freddy

These two tabs are full snapshots (charts, 7-day history, per-set heart-rate, etc.)
generated from your Garmin fenix 8 + Hevy data through your **Freddy** Claude connection.
The data is embedded in the HTML, so you don't edit a data file — you regenerate the page.

### To refresh Sleep or Training
1. Open the Claude chat where Freddy (Garmin/Hevy) is connected.
2. Ask it to pull your latest sleep / training data and **regenerate the dashboard page**
   (the same one that produced `sleep.html` / `training.html`).
3. Save the new HTML over `sleep.html` (or `training.html`), keeping the **filename the
   same**.
4. Push.

Because `index.html` just embeds whatever `sleep.html` / `training.html` contain, the new
version shows up automatically — no other edits needed.

---

## 3. Saving changes (makes it live)

Nothing is online until you push. Always the same three commands:

```powershell
cd "C:\Users\patri\OneDrive\CLAUDE\daily-dashboard"
git add .
git commit -m "update intake for 2026-06-13"
git push
```

GitHub Pages redeploys within ~1 minute, at:
**https://patrikpencinger-ai.github.io/daily-dashboard/**

---

## Frequently asked

**Do I keep using my fitness/intake chat?**
Yes. Log food there as usual. The chat's new job is to also spit out `data.json` when you
ask. Nothing about your logging habit changes.

**Does logging food automatically update the website?**
No. It's deliberately manual: log → get `data.json` → push. One ~30-second step a day.
(If you ever want it fully automatic, that needs a small server pulling the APIs on a
schedule — more moving parts; not set up today.)

**Why isn't Sleep/Training read from `data.json` too?**
The earlier "simple" version did that. The new rich versions are far more detailed
(multi-series charts, per-set HR, 12-week trends) — easier and more reliable to ship as
self-contained snapshots than to wire every series through one JSON file.

**Do I need the computer for this?**
You need to (a) save the file and (b) run `git push`. Both happen on the PC where this
folder lives. Editing can be done in any text editor — or just ask Claude to do the edit
and push for you.
