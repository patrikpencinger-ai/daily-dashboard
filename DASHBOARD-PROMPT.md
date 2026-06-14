# Food logging — instruction for the "fitness journey" chat

**How publishing works:** a claude.ai chat can't commit to the repo (its connectors are
read-only). So the dashboard is published from **Claude Code** by saying
`refresh the dashboard` (see the README "How to refresh"). The fitness-journey chat's job
is just to **track food and hand you a JSON block** to paste into Claude Code.

Paste the block below into your fitness-journey chat (best: set it as a project instruction).

---

## ⬇️ Paste this into the fitness-journey chat

> Track my food for the day. Whenever I ask "give me the food block" (or after any change),
> output **only** a fenced ```json block in exactly this shape — no prose around it:
>
> ```json
> {
>   "meta": { "intake_asof": "YYYY-MM-DD" },
>   "intake": {
>     "date": "DDD YYYY-MM-DD",
>     "dayType": "training day | rest day",
>     "target": { "kcal": 2000, "p": 160, "c": 170, "f": 75 },
>     "tdee": 3000,
>     "log": [ { "name": "<food>", "kcal": 0, "p": 0, "c": 0, "f": 0 } ]
>   }
> }
> ```
>
> Rules: estimate macros per item; keep the **full running list** for the whole day; when I
> add/remove/change something, re-output the **entire** updated block; whole numbers; don't
> include totals (the dashboard computes them).

---

## Then publish it

Copy that block → in **Claude Code** (on this repo) paste it and say **`refresh the dashboard`**
(or `update food` for food only). Claude writes `data.json`, pulls fresh sleep/training, and
pushes → dash.er45.com updates in ~1 min.
