// Coach narrative (TREND / FLAG / PRESCRIPTION / LEVER, EN + HR in one call), ask-the-coach,
// and the API-mode config. Contract: .foreman/api-contract.md; slot spec: REFRESH.md section 3a.
//
// KV (binding LIVE)
//   cfg:mode            "current" (default, never calls the API) | "api"
//   cfg:functions       {<fn>: {model, effort, maxTokens, enabled}} (merged over DEFAULT_FUNCTIONS)
//   narr:<workoutId>    narrative item for one workout, TTL 30 d
//   narr:daily:<date>   daily narrative item (Europe/Zagreb date), TTL 30 d
//   narr:index          [{key, kind, workoutId, createdAt}] newest first (lets /live/narrative avoid list())
//   narr:queue          [{id, at, attempts}] webhook narratives not finished inline (retried by the 10-minute cron)
//   meta:narrDaily      {at, date, ok, err} last daily run
//
// STATIC_RULES is the cached system block: byte-identical across calls (no dates, no numbers
// from the data). Volatile context and the task go in the user message.

import { callClaude } from "./claude.js";
import { buildContext } from "./context.js";
import { getJSON, getWorkout, putJSON } from "./store.js";
import { zgDate } from "./usage.js";

// ---- config -------------------------------------------------------------------------

export const MODES = ["current", "api"];
// Cron expressions (UTC) — must match wrangler.toml [triggers]. 05:40 UTC = 07:40 Zagreb in
// summer time (CEST) and 06:40 in winter time (CET).
export const CRON_EVERY_10 = "*/10 * * * *";
export const DAILY_CRON = "40 5 * * *";
export const FUNCTION_IDS = ["narrative_workout", "narrative_daily", "coach_chat"];
export const ALLOWED_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
export const EFFORTS = ["low", "medium", "high"];
export const MAX_TOKENS_RANGE = [100, 2000];
export const DEFAULT_FUNCTIONS = {
  narrative_workout: { model: "claude-opus-5-5", effort: "low", maxTokens: 700, enabled: true },
  narrative_daily: { model: "claude-opus-5-5", effort: "low", maxTokens: 700, enabled: true },
  coach_chat: { model: "claude-opus-5-5", effort: "low", maxTokens: 900, enabled: true },
};

export async function getMode(kv) {
  const m = await getJSON(kv, "cfg:mode");
  return MODES.includes(m) ? m : "current";
}

export async function getFunctions(kv) {
  const stored = (await getJSON(kv, "cfg:functions")) || {};
  const out = {};
  for (const id of FUNCTION_IDS) out[id] = { ...DEFAULT_FUNCTIONS[id], ...(stored[id] || {}) };
  return out;
}

/**
 * Validate a PUT /admin/config body {mode?, functions?: {<fn>: {model?, effort?, maxTokens?, enabled?}}}.
 * Returns {errors[], mode?, functions?} (functions = full merged map ready to store).
 */
export function validateConfig(body, current) {
  const errors = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: ["body must be a JSON object"] };
  const allowedTop = ["mode", "functions"];
  for (const k of Object.keys(body)) if (!allowedTop.includes(k)) errors.push(`unknown field: ${k}`);
  const out = { errors };
  if ("mode" in body) {
    if (!MODES.includes(body.mode)) errors.push(`mode must be one of ${MODES.join("|")}`);
    else out.mode = body.mode;
  }
  if ("functions" in body) {
    const f = body.functions;
    if (!f || typeof f !== "object" || Array.isArray(f)) {
      errors.push("functions must be an object");
    } else {
      const next = {};
      for (const id of FUNCTION_IDS) next[id] = { ...current[id] };
      for (const [id, patch] of Object.entries(f)) {
        if (!FUNCTION_IDS.includes(id)) { errors.push(`unknown function: ${id}`); continue; }
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) { errors.push(`${id} must be an object`); continue; }
        for (const [k, v] of Object.entries(patch)) {
          if (k === "model") {
            if (!ALLOWED_MODELS.includes(v)) errors.push(`${id}.model must be one of ${ALLOWED_MODELS.join("|")}`);
            else next[id].model = v;
          } else if (k === "effort") {
            if (!EFFORTS.includes(v)) errors.push(`${id}.effort must be one of ${EFFORTS.join("|")}`);
            else next[id].effort = v;
          } else if (k === "maxTokens") {
            const nt = Number(v);
            if (!Number.isInteger(nt) || nt < MAX_TOKENS_RANGE[0] || nt > MAX_TOKENS_RANGE[1]) {
              errors.push(`${id}.maxTokens must be an integer ${MAX_TOKENS_RANGE[0]}-${MAX_TOKENS_RANGE[1]}`);
            } else next[id].maxTokens = nt;
          } else if (k === "enabled") {
            if (typeof v !== "boolean") errors.push(`${id}.enabled must be true or false`);
            else next[id].enabled = v;
          } else {
            errors.push(`unknown field: ${id}.${k}`);
          }
        }
      }
      out.functions = next;
    }
  }
  return out;
}

// ---- static rules (cached system block) ------------------------------------------------

// Verbatim copies of REFRESH.md (section 3a and "Load definitions"); test/claude.test.mjs
// fails when REFRESH.md changes and these copies drift. Regenerate: see README "Coach rules".
export const REFRESH_3A = `### 3a. \`rec\` — four slots, in this order, nothing else

\`text.<lang>.rec\` in **both** \`training-data.json\` and \`sleep-data.json\` is one string made
of exactly four slots, in order, written as plain sentences with no headings, numbering or
labels. **Each slot ≤ 60 words in EN** (HR is the same four slots in the same order with
the same numbers; it may run ~10% longer for grammar). **Whole \`rec\` ≤ 240 words EN.**

| Slot | Name | What it must contain | Reads from |
|---|---|---|---|
| 1 | **TREND** | One sentence with numbers: the thing that moved. Training \`rec\` → this week's tonnage and ACWR vs the previous week, or swim pace vs the previous swim, whichever moved more. Sleep \`rec\` → duration / score / RHR / HRV against the 28-day baseline (7-night if 28 is short). | \`num.gym[].vol\`, \`num.swim[].sec100\`, \`num.trend[]\` |
| 2 | **FLAG** | The **single** most important risk right now, named with the number that triggered it — or the literal word "none" when nothing trips. Never two flags. | see the flag ladder below |
| 3 | **PRESCRIPTION** | Exactly one next session. Gym: \`lift / sets × reps / load kg\`. Swim: \`distance / interval / target pace per 100\`. Nothing else — no alternatives, no "or". | \`num.gym[].lift\` + \`num.gym[].top\` |
| 4 | **LEVER** | One nutrition or sleep lever, tied to a number from today. Not general advice. | \`data.json\` targets/log, \`num.sleepWake\`, \`num.trend[]\` |

**Flag ladder (slot 2).** Evaluate in order, report the first that trips, stop:

1. **ACWR > 1.3** — acute (last 7 d tonnage) ÷ chronic (28 d tonnage ÷ 4). Cite both the
   ratio and the acute tonnage.
2. **Top-set jump > 10%** — the most recent \`top.w\` for a lift vs that same lift's previous
   \`top.w\`. Cite the two loads and the percentage.
3. **Sleep debt** — count of nights under 7 h in the last 7 \`trend\` rows with a non-null
   \`durH\`. Cite the count and the shortfall in hours.
4. **RHR / HRV divergence** — RHR above its 28-day baseline while HRV is below its own.
   Cite both numbers and both baselines.
5. Nothing tripped → **"none"** (or its HR equivalent). Say it in one short clause and move
   on; do not pad the slot to justify the absence.

**Prescription rule (slot 3) — the hard one.** The prescribed lift **must** appear in
\`num.gym[].lift\` within the **last 4 weeks** (today − 27 days … today). A lift that is only
in \`num.mld\`, or whose last \`num.gym\` appearance is older than 4 weeks, is **retired** and
must never be prescribed, no matter how long the "gap" since it was last done. *The gap is
not a debt — it is the athlete's programme changing.* Anchor the load to the most recent
\`top\` for the prescribed lift; when the flag in slot 2 is ACWR > 1.3 or a top-set jump,
the prescription must be the reduced/alternative session, not the same load again.

**Ban list — none of this may appear in any \`rec\`, in either language:**

- Window-boundary artifacts: "first week in the window", "only two lifting days sit in the
  window now", "fewer sessions on this board than the previous board". The window moving is
  not news.
- Detection-confidence talk: "detection is uncertain", "flagged \`cf:0\`", "the \`*\` means",
  anything about how the data was derived.
- Hedging about data availability: "if you logged more days", "assuming the missing days",
  "data is incomplete so". Either the number is there and you use it, or the sentence does
  not exist.
- **More than one prescription.** One session. Not "goblet today, and keep two swims a
  week, and log Friday, and bedtime 22:30".
- A "Next: …" recap sentence at the end restating the four slots.
- Prescribing a retired lift (see above).

**Worked example of the shape** (numbers from \`training-data.json\` as of 2026-09-05 — this
is the shape to hit, not a template to reuse):

> Tonnage is 27,720 kg over the last seven days against 45,112 the week before, with the
> 28-day chronic load at 26,670 kg a week — an ACWR of 1.04. *(slot 1)*
> The flag is the hack-squat top set: 170 kg × 12 on Aug 27 became 200 kg × 6 on Sep 3, a
> 17.6% load jump in seven days — tendon adaptation lags that by weeks. *(slot 2)*
> Next session: front squat, 4 × 8 at 80 kg — the load held on Aug 23 and Aug 29.
> *(slot 3)*
> Fat is the lever: Thursday logged 51 g against the 70 g training-day floor, and all three
> logged days landed 49–51 g. Add ~20 g of fat to a main meal. *(slot 4)*`;
export const LOAD_DEFS = `### Load definitions

| Field | Definition |
|---|---|
| \`tonnageWork\` | Σ kg × reps over sets whose Hevy type is not \`warmup\` (\`tonnageAll\` includes them) |
| hard set | non-warm-up set with RPE ≥ 7 (no RPE → unknown, except type \`failure\` → hard) |
| failure | RPE ≥ 9.5 or type \`failure\` |
| \`e1rm\` | kg × (1 + (reps + 10 − RPE) / 30); no RPE → RIR 0; none for warm-ups, unloaded or rep-less sets |
| \`sRPE\` | average RPE of the work sets × main-block minutes (\`mainMin\`; Hevy duration if no HR) |
| \`hrLoad\` | Edwards TRIMP over the main block, HRmax 173 (\`hrMax\`): 1 Hz zone weight 1–5 for 50–60 / 60–70 / 70–80 / 80–90 / ≥ 90 % HRmax, below 50 % = 0, in zone-minutes |
| muscle credit | per exercise: hard sets and \`tonnageWork\` credited 1 × to the primary muscle and 0.5 × to each secondary, from the Hevy exercise templates |
| ACWR (\`weekly\`) | acute = last 7 d ÷ (last 28 d ÷ 4), on \`tonnageWork\` and on \`sRPE\` |`;

const ROLE = `You are the strength and recovery coach behind a personal training dashboard for one athlete who lifts (logged in the Hevy app, heart rate from a Garmin watch via Strava) and swims. You write the short coaching text that the dashboard shows next to the athlete's numbers, in English (en) and Croatian (hr). You are direct, specific and numerate. You never invent a number: every number you write is in the CONTEXT JSON of the request or is computed from numbers in it (a difference, a ratio, a percentage).`;

const TASKS = `## Tasks you receive

Each request ends with a TASK line. There are three kinds.

1. NARRATIVE (kind "workout"): the athlete has just logged the session named by focusWorkoutId. Write the four slots of section 3a for the training side, using that session as the newest data point.
2. NARRATIVE (kind "daily"): the morning check-in. Write the four slots of section 3a from everything in the context as of asOf.
3. COACH QUESTION: the athlete asks one question. Answer it (see "Answer format" below).

## Answer format

- NARRATIVE tasks: answer as JSON only, exactly {"en":{"trend":"...","flag":"...","prescription":"...","lever":"..."},"hr":{"trend":"...","flag":"...","prescription":"...","lever":"..."}}. Each value is one slot written as plain sentences: no slot names, no labels, no numbering, no markdown, no line breaks. Each English slot is at most 60 words; each Croatian slot carries the same content and numbers and may run about 10% longer for grammar. The "en" and "hr" objects say the same thing.
- COACH QUESTION tasks: answer in plain text in the language the task names (en = English, hr = Croatian), at most 250 words, no headings, no tables, no JSON. Use the numbers in the context; prescribe at most one session; the ban list below applies. If the question is outside training, recovery, sleep or nutrition, say in one sentence that you only cover those.

## How the CONTEXT JSON maps onto section 3a

The context is computed from the live workout log (the last 20 days) and replaces the dashboard files that section 3a names:

- weekly[] = rolling 7-day windows ending today, newest first (weekly[0] = the last 7 days). tonnageWork is work-set tonnage in kg (warm-ups excluded). It stands in for num.gym[].vol in slot 1 and flag 1. A window with tonnageWork null is outside the log's reach: do not compare against it and do not mention it.
- acwr, acuteTonnage, chronicWeeklyTonnage = the ACWR of the load definitions on tonnageWork. When acwr is "n/a", flag 1 cannot be evaluated: skip it silently and go on to flag 2.
- topSets[] = per lift, the newest top set (last) and the previous session's top set (prev), with jumpPct = the load change in percent. This is flag 2 and the anchor for the slot 3 load. It stands in for num.gym[].top.
- lifts20d[] = every lift logged in the last 20 days. These are all inside the 4-week window of the prescription rule, so any of them may be prescribed; a lift that is not in this list must not be prescribed.
- sessions[] = up to five newest sessions: date, title, durMin, tonnageWork, hardSets, failureSets, avgRPE, and top = the top work set per exercise (kg, reps, rpe).
- muscles7d = hard sets per muscle group over the last 7 days (primary muscle 1.0, secondary 0.5).
- hrMatch = heart-rate peaks matched to sets for the newest session that has them: expected and matched set counts, confSetsPct (share of sets matched with confidence), the anchor lift with its peak times (s) and peak heart rates (bpm), maxSetPeakHR and sessionHR {avg, max}. Use heart rate as training information (effort, recovery between sets). Never discuss how the matching was done or how confident it is (ban list).
- sleep and readiness = sleep and recovery numbers when present; null when absent. Flags 3 and 4 need them: when they are null, skip flags 3 and 4 silently.
- Slot 4 (LEVER) is one sleep or nutrition lever tied to a number that is in the context. When sleep is null, anchor it on a training number instead (for example the session's end time and duration for a sleep lever, or the tonnage and failure sets for a fuelling lever). Never invent a sleep or food number, and never say that a number is missing.`;

const FORMAT = `## Units and number format

- Loads in kg, tonnage in kg. Sets x reps as "4 × 8", load as "at 80 kg".
- English: thousands separator comma, decimal point (27,720 kg; ACWR 1.04; 17.6%). Dates as "Oct 9".
- Croatian: thousands separator dot, decimal comma (27.720 kg; ACWR 1,04; 17,6 %). Dates as "9. 10.".
- Round ACWR to two decimals, percentages to one decimal, tonnage to the kilogram.
- Name lifts as they appear in the context (the Hevy exercise title); in Croatian you may keep the English lift name.
- Heart rate in bpm, durations in minutes.

## Glossary (en -> hr)

tonnage -> tonaža; work set -> radna serija; warm-up set -> serija zagrijavanja; hard set (RPE 7 or more) -> teška serija; failure set -> serija do otkaza; top set -> najteža serija; reps -> ponavljanja; load -> opterećenje; acute load -> akutno opterećenje; chronic load -> kronično opterećenje; ACWR -> ACWR (omjer akutnog i kroničnog opterećenja); deload -> rasterećenje; rest between sets -> odmor između serija; resting heart rate -> puls u mirovanju; heart-rate variability -> varijabilnost srčanog ritma (HRV); sleep debt -> manjak sna; session -> trening; next session -> sljedeći trening; the flag is none -> nema upozorenja; protein -> proteini; fat -> masti; carbohydrate -> ugljikohidrati; lights out -> gašenje svjetla.

RPE = rate of perceived exertion on the 1-10 scale of the Hevy log; RPE 10 = no reps left. e1RM = estimated one-rep max. RIR = reps in reserve (10 - RPE).`;

const EXAMPLE = `## Example of the JSON shape (invented numbers; match the shape, never reuse the numbers)

{"en":{"trend":"Work tonnage is 14,380 kg over the last seven days against 11,950 kg the seven days before, a 20.3% rise carried by two lower-body sessions.","flag":"The flag is the Romanian deadlift top set: 100 kg × 8 on Oct 2 became 115 kg × 6 on Oct 8, a 15.0% load jump in six days.","prescription":"Next session: Romanian deadlift, 3 × 8 at 100 kg — the load held on Oct 2.","lever":"Sleep is the lever: Wednesday's 74-minute session ended at 21:40 with 4 failure sets; lights out by 23:00 keeps that load from eating into recovery."},"hr":{"trend":"Radna tonaža je 14.380 kg u zadnjih sedam dana prema 11.950 kg u sedam dana prije, rast od 20,3 % koji nose dva treninga donjeg dijela tijela.","flag":"Upozorenje je najteža serija rumunjskog mrtvog dizanja: 100 kg × 8 od 2. 10. postalo je 115 kg × 6 do 8. 10., skok opterećenja od 15,0 % u šest dana.","prescription":"Sljedeći trening: rumunjsko mrtvo dizanje, 3 × 8 sa 100 kg — opterećenje koje je držalo 2. 10.","lever":"Poluga je san: srijedin trening od 74 minute završio je u 21:40 s 4 serije do otkaza; gašenje svjetla do 23:00 čuva oporavak od tog opterećenja."}}

When no flag trips, the flag slot is one short clause, for example {"flag":"No flag trips this week."} in English and {"flag":"Ovaj tjedan nema upozorenja."} in Croatian.`;

export const STATIC_RULES = [
  ROLE,
  TASKS,
  "## Section 3a of the dashboard spec (REFRESH.md), verbatim. Where it names dashboard files, read the CONTEXT JSON as described above.",
  REFRESH_3A,
  "## Load definitions (REFRESH.md), verbatim",
  LOAD_DEFS,
  FORMAT,
  EXAMPLE,
].join("\n\n");

// ---- output schema + parsing ----------------------------------------------------------

const SLOT_KEYS = ["trend", "flag", "prescription", "lever"];
const slots = {
  type: "object",
  additionalProperties: false,
  required: SLOT_KEYS,
  properties: Object.fromEntries(SLOT_KEYS.map((k) => [k, { type: "string" }])),
};
export const NARRATIVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["en", "hr"],
  properties: { en: slots, hr: slots },
};
export const WORD_LIMIT = { en: 60, hr: 66 };

export const wordCount = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

/** Validate a structured-output object. {ok, en, hr, warnings[]} or {ok:false, error}. */
export function parseNarrative(data) {
  if (!data || typeof data !== "object") return { ok: false, error: "not an object" };
  const out = { ok: true, warnings: [] };
  for (const lang of ["en", "hr"]) {
    const o = data[lang];
    if (!o || typeof o !== "object") return { ok: false, error: `missing ${lang}` };
    out[lang] = {};
    for (const k of SLOT_KEYS) {
      if (typeof o[k] !== "string" || !o[k].trim()) return { ok: false, error: `missing ${lang}.${k}` };
      const v = o[k].replace(/\s+/g, " ").trim();
      out[lang][k] = v;
      const wc = wordCount(v);
      if (wc > WORD_LIMIT[lang]) out.warnings.push(`${lang}.${k} ${wc} words > ${WORD_LIMIT[lang]}`);
    }
  }
  return out;
}

// ---- tasks ----------------------------------------------------------------------------

function userMessage(contextJson, task) {
  return `CONTEXT (JSON):\n${contextJson}\n\nTASK: ${task}`;
}

export function workoutTask(rec) {
  return `NARRATIVE, kind "workout". The session just logged is "${String(rec.title || "").slice(0, 80)}" (focusWorkoutId). Write the four slots as JSON.`;
}

export function dailyTask(date) {
  return `NARRATIVE, kind "daily", for ${date}. Write the four slots as JSON.`;
}

export function coachTask(question, lang) {
  return `COACH QUESTION. Answer in ${lang === "hr" ? "Croatian (hr)" : "English (en)"} as plain text, at most 250 words.\nQuestion: ${question}`;
}

// ---- storage ------------------------------------------------------------------------------

export const NARR_TTL_S = 30 * 86400;
const INDEX_MAX = 60;
const iso = (ms) => new Date(ms).toISOString();

async function storeNarrative(kv, key, item) {
  await putJSON(kv, key, item, { expirationTtl: NARR_TTL_S });
  const idx = ((await getJSON(kv, "narr:index")) || []).filter((e) => e && e.key !== key);
  idx.unshift({ key, kind: item.kind, workoutId: item.workoutId, createdAt: item.createdAt });
  await putJSON(kv, "narr:index", idx.slice(0, INDEX_MAX));
}

/** Public items for GET /live/narrative?days=N (newest first, at most 30). */
export async function listNarratives(kv, days, now) {
  const cutoff = now - days * 86400 * 1000;
  const idx = ((await getJSON(kv, "narr:index")) || [])
    .filter((e) => e && Date.parse(e.createdAt) >= cutoff)
    .slice(0, 30);
  const recs = await Promise.all(idx.map((e) => getJSON(kv, e.key)));
  return recs.filter(Boolean).map((r) => ({
    workoutId: r.workoutId ?? null,
    kind: r.kind,
    createdAt: r.createdAt,
    model: r.model,
    effort: r.effort,
    en: r.en,
    hr: r.hr,
  }));
}

// ---- runs ----------------------------------------------------------------------------------

const RETRYABLE = /^(network|timeout|http 429|http 5\d\d)/;
export const isRetryable = (err) => RETRYABLE.test(String(err || ""));

/**
 * One narrative call. Requires mode "api" (also for manual runs: mode "current" means 0 spend).
 * Automatic runs also require the function to be enabled.
 * @returns {ok, err?, item?, usage?, usd?, skipped?}
 */
export async function runNarrative(rt, { kind, workoutId = null, manual = false }) {
  const kv = rt.env.LIVE;
  if ((await getMode(kv)) !== "api") return { ok: false, err: "mode-current" };
  const fnId = kind === "daily" ? "narrative_daily" : "narrative_workout";
  const fn = (await getFunctions(kv))[fnId];
  if (!fn.enabled && !manual) return { ok: false, err: "disabled" };

  const now = rt.now();
  let rec = null;
  if (kind === "workout") {
    rec = await getWorkout(kv, workoutId);
    if (!rec) return { ok: false, err: "unknown-workout" };
  }
  const date = zgDate(now);
  const { json, tokens } = await buildContext(kv, now, { focusId: workoutId });
  const task = kind === "daily" ? dailyTask(date) : workoutTask(rec);
  const r = await callClaude(rt, {
    fn: fnId, model: fn.model, effort: fn.effort, maxTokens: fn.maxTokens,
    system: STATIC_RULES, user: userMessage(json, task), schema: NARRATIVE_SCHEMA,
  });
  if (!r.ok) return { ok: false, err: r.err, skipped: !!r.skipped, usage: r.usage, usd: r.usd };
  const p = parseNarrative(r.data);
  if (!p.ok) return { ok: false, err: `bad-schema: ${p.error}`, usage: r.usage, usd: r.usd };

  const item = {
    workoutId: kind === "workout" ? workoutId : null,
    kind,
    createdAt: iso(rt.now()),
    model: r.model,
    effort: fn.effort,
    en: p.en,
    hr: p.hr,
    warnings: p.warnings,
    date,
    workoutUpdatedAt: rec ? rec.updatedAt || null : null,
    contextTokens: tokens,
    usd: r.usd,
  };
  await storeNarrative(kv, kind === "daily" ? `narr:daily:${date}` : `narr:${workoutId}`, item);
  return { ok: true, item, usage: r.usage, usd: r.usd };
}

/** Ask-the-coach: same cached rules + context, plain-text answer. */
export async function runCoach(rt, { question, lang }) {
  const kv = rt.env.LIVE;
  if ((await getMode(kv)) !== "api") return { ok: false, err: "mode-current" };
  const fn = (await getFunctions(kv)).coach_chat;
  if (!fn.enabled) return { ok: false, err: "disabled" };
  const { json } = await buildContext(kv, rt.now());
  const r = await callClaude(rt, {
    fn: "coach_chat", model: fn.model, effort: fn.effort, maxTokens: fn.maxTokens,
    system: STATIC_RULES, user: userMessage(json, coachTask(question, lang)), schema: null,
  });
  return {
    ok: r.ok, err: r.err, skipped: !!r.skipped, answer: r.ok ? (r.text || "").trim() : null,
    truncated: r.truncated, usage: r.usage, usd: r.usd, model: r.model,
  };
}

// ---- webhook hook + queue ------------------------------------------------------------------

export const QUEUE_GRACE_MS = 5 * 60 * 1000; // an inline attempt may still be running
export const QUEUE_MAX_AGE_MS = 6 * 3600 * 1000;
export const QUEUE_MAX_ATTEMPTS = 2;

async function getQueue(kv) {
  const q = await getJSON(kv, "narr:queue");
  return Array.isArray(q) ? q : [];
}

async function queueRemove(kv, id) {
  const q = await getQueue(kv);
  if (q.some((e) => e.id === id)) await putJSON(kv, "narr:queue", q.filter((e) => e.id !== id));
}

/**
 * After a webhook stored a workout: in mode "api", queue it and try the narrative at once.
 * The queue entry survives a waitUntil that is cut short; the 10-minute cron finishes it.
 * One call per webhook at most; a re-sent webhook for an unchanged workout costs nothing.
 */
export async function afterWebhook(rt, rec) {
  if (!rec || !rec.id) return null;
  const kv = rt.env.LIVE;
  if ((await getMode(kv)) !== "api") return null;
  const fns = await getFunctions(kv);
  if (!fns.narrative_workout.enabled) return null;
  const prev = await getJSON(kv, `narr:${rec.id}`);
  if (prev && (prev.workoutUpdatedAt || null) === (rec.updatedAt || null)) return { ok: true, skipped: "unchanged" };

  const q = (await getQueue(kv)).filter((e) => e.id !== rec.id);
  q.push({ id: rec.id, at: rt.now(), attempts: 1 });
  await putJSON(kv, "narr:queue", q.slice(-20));
  const r = await runNarrative(rt, { kind: "workout", workoutId: rec.id });
  if (r.ok || !isRetryable(r.err)) await queueRemove(kv, rec.id);
  return r;
}

/** 10-minute cron: finish at most one queued webhook narrative. */
export async function processNarrativeQueue(rt) {
  const kv = rt.env.LIVE;
  const q = await getQueue(kv);
  if (!q.length) return null;
  if ((await getMode(kv)) !== "api") {
    await putJSON(kv, "narr:queue", []);
    return null;
  }
  const now = rt.now();
  const keep = [];
  let pick = null;
  for (const e of q) {
    if (now - e.at > QUEUE_MAX_AGE_MS || e.attempts >= QUEUE_MAX_ATTEMPTS) continue; // give up
    if (!pick && now - e.at >= QUEUE_GRACE_MS) {
      const done = await getJSON(kv, `narr:${e.id}`);
      if (done && Date.parse(done.createdAt) >= e.at) continue; // the inline run finished
      pick = { ...e, attempts: e.attempts + 1 };
      keep.push(pick);
      continue;
    }
    keep.push(e);
  }
  await putJSON(kv, "narr:queue", keep);
  if (!pick) return null;
  const r = await runNarrative(rt, { kind: "workout", workoutId: pick.id });
  if (r.ok || !isRetryable(r.err)) await queueRemove(kv, pick.id);
  return r;
}

/** Daily cron (07:40 Zagreb in summer time): one narrative per Zagreb date in mode "api". */
export async function runDailyNarrative(rt, { manual = false } = {}) {
  const kv = rt.env.LIVE;
  if ((await getMode(kv)) !== "api") return { ok: false, err: "mode-current" };
  const date = zgDate(rt.now());
  if (!manual && (await getJSON(kv, `narr:daily:${date}`))) return { ok: true, skipped: "already-done" };
  const r = await runNarrative(rt, { kind: "daily", manual });
  await putJSON(kv, "meta:narrDaily", { at: iso(rt.now()), date, ok: r.ok, err: r.err || null });
  return r;
}
