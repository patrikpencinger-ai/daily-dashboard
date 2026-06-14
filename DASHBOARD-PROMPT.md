# Pushing data from the "fitness journey" chat → the dashboard

The dashboard at **dash.er45.com** is a static site. Its data lives in three JSON files in
the GitHub repo **`patrikpencinger-ai/daily-dashboard`** (branch `main`). Committing to that
repo auto-deploys to Cloudflare in ~1 minute. The site reads:

- `sleep-data.json` — sleep & recovery tab
- `training-data.json` — training tab
- `data.json` — food intake tab

Paste the block below into your **fitness-journey chat** (best: set it as a project
instruction so it's always available).

---

## ⬇️ Paste this into the fitness-journey chat

> You can update my live health dashboard — the GitHub repo `patrikpencinger-ai/daily-dashboard`
> (branch `main`). Committing there auto-deploys to dash.er45.com.
>
> **When I say "refresh the dashboard":**
> 1. Pull my latest data from the connectors — Garmin sleep/HRV/RHR (Freddy), Hevy, Intervals.icu.
> 2. In the repo, read `REFRESH.md`, `sleep-data.json` and `training-data.json` to learn the
>    exact shapes, then follow `REFRESH.md` precisely.
> 3. Regenerate `sleep-data.json` and `training-data.json` with the freshest numbers and newly
>    written bilingual (EN + HR) insights, keeping every JSON key and structure identical.
> 4. Commit both files to `main`, message `refresh: <YYYY-MM-DD>`. Do **not** touch `data.json`.
> 5. Reply with one line summarising what changed.
>
> **When I say "update food":**
> 1. Take today's food as we've tracked it in this chat.
> 2. Write `data.json` in exactly this shape (totals are computed by the site — omit them):
>    ```json
>    {
>      "meta": { "intake_asof": "YYYY-MM-DD" },
>      "intake": {
>        "date": "DDD YYYY-MM-DD",
>        "dayType": "training day | rest day",
>        "target": { "kcal": 2000, "p": 160, "c": 170, "f": 75 },
>        "tdee": 3000,
>        "log": [ { "name": "Food 100g", "kcal": 0, "p": 0, "c": 0, "f": 0 } ]
>      }
>    }
>    ```
> 3. Commit `data.json` to `main`, message `food: <YYYY-MM-DD>`.
> 4. Edits during the day: when I add / change / remove an item, rewrite the **whole**
>    `data.json` and commit again.
>
> **If you can't write to the repo:** instead of committing, output the complete file
> contents in a code block and I'll commit them.

---

## What the chat needs for "refresh the dashboard" to push by itself
- The **health connectors** (it already has these — that's where your data + insights come from).
- **Write access to the GitHub repo.** If the project has a GitHub connector/MCP, it commits
  directly. If not, see the fallback above (it outputs the JSON, you commit).

After any push, opening dash.er45.com (or hitting the **↻ Refresh** button) shows the update.
