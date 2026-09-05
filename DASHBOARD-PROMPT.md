# Food logging — instruction for the "fitness journey" chat

**How publishing works:** a claude.ai chat can't commit to the repo (its connectors are
read-only). So the dashboard is published from **Claude Code** by saying
`refresh the dashboard` (see the README "How it refreshes"). The fitness-journey chat's job
is just to **track food and hand you a JSON block** to paste into Claude Code.

Paste the block below into your fitness-journey chat (best: set it as a project instruction).

---

## ⬇️ Paste this into the fitness-journey chat

> Track my food for the day. Whenever I ask "give me the food block" (or after any change),
> output **only** a fenced `json` code block in exactly this shape — no prose around it:
>
> ```json
> {
>   "meta": { "intake_asof": "YYYY-MM-DD" },
>   "intake": {
>     "date": "DDD YYYY-MM-DD",
>     "dayType": "training day | rest day",
>     "tdee": 3000,
>     "veg": 4,
>     "log": [ { "name": "<food>", "kcal": 0, "p": 0, "c": 0, "f": 0 } ]
>   }
> }
> ```
>
> **Targets:** do NOT put a `target` object in the block. The dashboard resolves it from the
> `targets` block in `data.json` using `dayType`. The current scheme is
> **training day 2,200 kcal / 180 P / 212 C / 70 F** and
> **rest day 1,750 kcal / 180 P / 111 C / 65 F** — flat protein, carbohydrate shifted onto
> training days, same ~14,000 kcal a week. Fat is a **floor**, not a ceiling: 65–70 g is the
> minimum for hormones and gallbladder emptying, so going over is fine and going under is
> what gets flagged. Use these figures when you tell me how the day is tracking, but leave
> them out of the JSON.
>
> **`dayType`** must be exactly `"training day"` or `"rest day"` — it is what selects the
> targets.
>
> **`veg`** is an optional integer: portions of vegetables, fruit and legumes that day
> (target 5). **Omit the field entirely if I did not count them** — absent means "not
> logged", `0` means "I ate none", and the dashboard shows those differently. Same rule for
> the optional `wholegrainG` (grams of wholegrain) if I mention it.
>
> **`tdee`** = rest base 2,420 kcal plus the net burn of that day's session (the gross
> Garmin session kcal minus about 81 kcal per hour of basal metabolism, which would have
> been burned anyway). On a rest day it is just 2,420.
>
> Rules: estimate macros per item; keep the **full running list** for the whole day; when I
> add/remove/change something, re-output the **entire** updated block; whole numbers; don't
> include totals (the dashboard computes them); never invent or pro-rate a day I didn't log.

---

## Then publish it

Copy that block → in **Claude Code** (on this repo) paste it and say **`refresh the dashboard`**
(or `update food` for food only). Claude merges the day into the `days[]` array of
`data.json`, stamps `target` from the `targets` block, pulls fresh sleep/training, and
pushes → dash.er45.com updates in ~1 min.

## Where the numbers live

`data.json` carries the profile and the targets once, so they don't have to be repeated in
every block:

```json
"athlete": { "weightKg": 108.4, "age": 47, "heightCm": 173, "bmr": 1935, "restTdee": 2420 },
"targets": {
  "training day": { "kcal": 2200, "p": 180, "c": 212, "f": 70 },
  "rest day":     { "kcal": 1750, "p": 180, "c": 111, "f": 65 }
}
```

`bmr` is Mifflin-St Jeor at 108.4 kg / 173 cm / 47 y; `restTdee` is BMR × 1.25. When body
weight moves enough to matter, these get rebased once in `data.json` — not in the chat
prompt, and not per day. If you change them, say so in `meta.note` with the date.
