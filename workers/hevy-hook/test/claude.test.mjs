// Claude client (mocked fetch), narrative schema / rules, context size, webhook + cron hooks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRequest, callClaude, FALLBACK_BETA, pingClaude } from "../src/claude.js";
import { approxTokens, buildContext, CONTEXT_MAX_TOKENS, topSet } from "../src/context.js";
import { handle, makeRuntime, runScheduled } from "../src/index.js";
import {
  afterWebhook, DAILY_CRON, LOAD_DEFS, NARRATIVE_SCHEMA, parseNarrative, processNarrativeQueue,
  REFRESH_3A, runCoach, runNarrative, STATIC_RULES,
} from "../src/narrative.js";
import { putWorkout } from "../src/store.js";
import { fakeCtx, jsonResponse, MemoryKV } from "./helpers.mjs";

const NOW = Date.parse("2026-10-10T08:00:00Z");
const KEY = "sk-ant-test-0000000000000000";
const MSG_URL = "https://api.anthropic.com/v1/messages";

const NARR = {
  en: {
    trend: "Work tonnage is 14,380 kg over the last seven days against 11,950 kg the seven days before.",
    flag: "No flag trips this week.",
    prescription: "Next session: Romanian deadlift, 3 × 8 at 100 kg.",
    lever: "Sleep is the lever: the session ended at 21:40; lights out by 23:00.",
  },
  hr: {
    trend: "Radna tonaža je 14.380 kg u zadnjih sedam dana prema 11.950 kg sedam dana prije.",
    flag: "Ovaj tjedan nema upozorenja.",
    prescription: "Sljedeći trening: rumunjsko mrtvo dizanje, 3 × 8 sa 100 kg.",
    lever: "Poluga je san: trening je završio u 21:40; gašenje svjetla do 23:00.",
  },
};

const USAGE = { input_tokens: 1200, cache_creation_input_tokens: 2600, cache_read_input_tokens: 0, output_tokens: 450 };
const message = (over = {}) => ({
  id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5",
  content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(NARR) }],
  stop_reason: "end_turn", stop_details: null, usage: USAGE, ...over,
});

/** Scripted Anthropic API: each call takes the next response (object -> 200 JSON, function -> its result). */
function claudeApi(queue) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === "function") return next(url, init);
    return jsonResponse(next);
  };
  f.calls = calls;
  return f;
}

function rt(env, fetchImpl, now = NOW, sleeps = []) {
  const clock = { t: now };
  const r = makeRuntime(env, { fetch: fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, now: () => clock.t });
  r.clock = clock;
  return r;
}

const baseEnv = (over = {}) => ({ LIVE: new MemoryKV(), ANTHROPIC_API_KEY: KEY, ...over });
const callOpts = (over = {}) => ({
  fn: "narrative_workout", model: "claude-opus-5-5", effort: "low", maxTokens: 700,
  system: STATIC_RULES, user: "CONTEXT (JSON):\n{}\n\nTASK: test", schema: NARRATIVE_SCHEMA, ...over,
});

// ---- request shape ------------------------------------------------------------------------

test("request: cached system block, effort + json_schema, fallbacks on Opus/Sonnet only, no thinking/sampling", () => {
  const { body, headers } = buildRequest({ model: "claude-opus-5-5", maxTokens: 700, effort: "low", system: "S", user: "U", schema: NARRATIVE_SCHEMA });
  assert.deepEqual(body.system, [{ type: "text", text: "S", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(body.messages, [{ role: "user", content: "U" }]);
  assert.deepEqual(body.output_config, { effort: "low", format: { type: "json_schema", schema: NARRATIVE_SCHEMA } });
  assert.equal(body.fallbacks, "default");
  assert.equal(headers["anthropic-beta"], FALLBACK_BETA);
  assert.equal(FALLBACK_BETA, "server-side-fallback-2026-07-01");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  for (const k of ["thinking", "temperature", "top_p", "top_k", "tool_choice", "budget_tokens"]) assert.ok(!(k in body), k);
  assert.ok(!("x-api-key" in headers));

  const s = buildRequest({ model: "claude-sonnet-5-5", maxTokens: 700, effort: "medium", system: "S", user: "U" });
  assert.equal(s.body.fallbacks, "default");
  assert.deepEqual(s.body.output_config, { effort: "medium" }); // plain text: no format

  const h = buildRequest({ model: "claude-haiku-5-5", maxTokens: 700, effort: "low", system: "S", user: "U", schema: NARRATIVE_SCHEMA });
  assert.ok(!("fallbacks" in h.body)); // Haiku 5.5 has no server-side fallback
  assert.ok(!("anthropic-beta" in h.headers));
});

// ---- callClaude ---------------------------------------------------------------------------

test("200: JSON parsed, usage + USD logged to usage:<day> and usage:recent", async () => {
  const env = baseEnv();
  const f = claudeApi([message()]);
  const r = await callClaude(rt(env, f), callOpts());
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, NARR);
  assert.deepEqual(r.usage, { in: 1200, cacheRead: 0, cacheWrite: 2600, out: 450 });
  assert.equal(r.usd, 0.0268);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, MSG_URL);
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.headers["x-api-key"], KEY);
  assert.ok(f.calls[0].init.signal); // timeout wired
  const day = await env.LIVE.get("usage:2026-10-10", "json");
  assert.equal(day.length, 1);
  assert.deepEqual(
    { fn: day[0].fn, model: day[0].model, effort: day[0].effort, in: day[0].in, cacheRead: day[0].cacheRead, cacheWrite: day[0].cacheWrite, out: day[0].out, usd: day[0].usd, ok: day[0].ok, err: day[0].err },
    { fn: "narrative_workout", model: "claude-opus-5-5", effort: "low", in: 1200, cacheRead: 0, cacheWrite: 2600, out: 450, usd: 0.0268, ok: true, err: null },
  );
  assert.equal((await env.LIVE.get("usage:recent", "json")).length, 1);
});

test("refusal: ok=false, err refusal:<category>, usage still logged", async () => {
  const env = baseEnv();
  const f = claudeApi([message({
    content: [], stop_reason: "refusal",
    stop_details: { type: "refusal", category: "cyber", explanation: "x" },
    usage: { input_tokens: 1200, output_tokens: 0 },
  })]);
  const r = await callClaude(rt(env, f), callOpts());
  assert.equal(r.ok, false);
  assert.equal(r.err, "refusal:cyber");
  assert.equal(r.data, null);
  const day = await env.LIVE.get("usage:2026-10-10", "json");
  assert.equal(day[0].err, "refusal:cyber");
  assert.equal(day[0].stop, "refusal");
  assert.equal(day[0].usd, 0.0048);
});

test("max_tokens: structured output -> error; plain text -> truncated answer kept", async () => {
  const env = baseEnv();
  const cut = message({ stop_reason: "max_tokens", content: [{ type: "text", text: "{\"en\":{\"trend\":\"Ton" }] });
  const r = await callClaude(rt(env, claudeApi([cut])), callOpts());
  assert.equal(r.ok, false);
  assert.equal(r.err, "max_tokens");
  assert.equal(r.data, null);

  const prose = message({ stop_reason: "max_tokens", content: [{ type: "text", text: "Your squat volume is" }] });
  const t = await callClaude(rt(env, claudeApi([prose])), callOpts({ fn: "coach_chat", schema: null }));
  assert.equal(t.ok, true);
  assert.equal(t.truncated, true);
  assert.equal(t.text, "Your squat volume is");
});

test("429 then 200: one retry after Retry-After seconds", async () => {
  const env = baseEnv();
  const sleeps = [];
  const f = claudeApi([
    () => jsonResponse({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429, { "retry-after": "3" }),
    message(),
  ]);
  const r = await callClaude(rt(env, f, NOW, sleeps), callOpts());
  assert.equal(r.ok, true);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(sleeps, [3000]);
  assert.equal((await env.LIVE.get("usage:2026-10-10", "json")).length, 1); // one logical call
});

test("5xx: at most 2 retries (backoff 2 s, 4 s), then error logged", async () => {
  const env = baseEnv();
  const sleeps = [];
  const f = claudeApi([() => jsonResponse({ type: "error", error: { type: "overloaded_error" } }, 529)]);
  const r = await callClaude(rt(env, f, NOW, sleeps), callOpts());
  assert.equal(r.ok, false);
  assert.equal(r.err, "http 529 overloaded_error");
  assert.equal(f.calls.length, 3);
  assert.deepEqual(sleeps, [2000, 4000]);
  const day = await env.LIVE.get("usage:2026-10-10", "json");
  assert.deepEqual([day[0].ok, day[0].usd, day[0].err], [false, 0, "http 529 overloaded_error"]);
});

test("400 is not retried; long Retry-After is not waited for", async () => {
  const env = baseEnv();
  const f = claudeApi([() => jsonResponse({ type: "error", error: { type: "invalid_request_error" } }, 400)]);
  const r = await callClaude(rt(env, f), callOpts());
  assert.equal(r.err, "http 400 invalid_request_error");
  assert.equal(f.calls.length, 1);
  const g = claudeApi([() => jsonResponse({ type: "error", error: { type: "rate_limit_error" } }, 429, { "retry-after": "120" })]);
  const r2 = await callClaude(rt(env, g), callOpts());
  assert.equal(r2.err, "http 429 rate_limit_error");
  assert.equal(g.calls.length, 1);
});

test("network error retried; timeout aborts (not retried)", async () => {
  const env = baseEnv();
  let n = 0;
  const flaky = claudeApi([() => { n += 1; throw new TypeError("fetch failed"); }, message()]);
  const r = await callClaude(rt(env, flaky), callOpts());
  assert.equal(r.ok, true);
  assert.equal(n, 1);

  const hang = async (url, init) => new Promise((_, rej) => {
    init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  let calls = 0;
  const r2 = await callClaude(rt(env, async (u, i) => { calls += 1; return hang(u, i); }), callOpts({ timeoutMs: 20 }));
  assert.equal(r2.ok, false);
  assert.equal(r2.err, "timeout");
  assert.equal(calls, 1);
});

test("bad JSON text from a structured call -> bad-json", async () => {
  const env = baseEnv();
  const r = await callClaude(rt(env, claudeApi([message({ content: [{ type: "text", text: "not json" }] })])), callOpts());
  assert.equal(r.ok, false);
  assert.equal(r.err, "bad-json");
});

test("no API key -> skipped, nothing sent", async () => {
  const env = baseEnv({ ANTHROPIC_API_KEY: undefined });
  const f = claudeApi([message()]);
  const r = await callClaude(rt(env, f), callOpts());
  assert.deepEqual([r.ok, r.err, r.skipped], [false, "not-configured", true]);
  assert.equal(f.calls.length, 0);
});

test("daily cap: at/over MAX_USD_PER_DAY the call is skipped and logged {skipped, reason:'cap'}", async () => {
  const env = baseEnv({ MAX_USD_PER_DAY: "0.05" });
  const f = claudeApi([message()]);
  const r1 = await callClaude(rt(env, f), callOpts()); // 0.0268
  const r2 = await callClaude(rt(env, f), callOpts()); // 0.0536 total
  assert.equal(r1.ok && r2.ok, true);
  const r3 = await callClaude(rt(env, f), callOpts());
  assert.deepEqual([r3.ok, r3.skipped, r3.err, r3.spent, r3.cap], [false, true, "cap", 0.0536, 0.05]);
  assert.equal(f.calls.length, 2);
  const day = await env.LIVE.get("usage:2026-10-10", "json");
  assert.deepEqual([day[2].skipped, day[2].reason, day[2].usd], [true, "cap", 0]);
  // next Zagreb day starts at 0
  const r4 = await callClaude(rt(env, f, Date.parse("2026-10-10T22:30:00Z")), callOpts());
  assert.equal(r4.ok, true);
});

test("the API key never reaches KV", async () => {
  const env = baseEnv();
  await callClaude(rt(env, claudeApi([message()])), callOpts());
  await callClaude(rt(env, claudeApi([() => jsonResponse({ error: { type: "authentication_error" } }, 401)])), callOpts());
  for (const [, v] of env.LIVE.m) assert.ok(!v.value.includes(KEY));
});

test("ping: GET /v1/models, 200 -> ok, 401 -> invalid key (no tokens, nothing logged)", async () => {
  const env = baseEnv();
  const ok = claudeApi([{ data: [{ id: "claude-opus-5-5" }] }]);
  assert.deepEqual(await pingClaude(rt(env, ok)), { ok: true, status: 200, ms: 0 });
  assert.match(ok.calls[0].url, /\/v1\/models\?limit=1$/);
  assert.equal(ok.calls[0].init.method, "GET");
  const bad = claudeApi([() => jsonResponse({ error: { type: "authentication_error" } }, 401)]);
  assert.deepEqual(await pingClaude(rt(env, bad)), { ok: false, status: 401, ms: 0, error: "invalid API key" });
  assert.equal(env.LIVE.m.size, 0);
});

// ---- rules + schema -------------------------------------------------------------------------

test("STATIC_RULES: REFRESH.md 3a + load definitions verbatim, >= 2048 tokens (chars/4), no volatile data", () => {
  const refresh = readFileSync(new URL("../../../REFRESH.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.ok(refresh.includes(REFRESH_3A), "REFRESH.md section 3a changed: regenerate REFRESH_3A in src/narrative.js");
  assert.ok(refresh.includes(LOAD_DEFS), "REFRESH.md load definitions changed: regenerate LOAD_DEFS in src/narrative.js");
  assert.ok(REFRESH_3A.startsWith("### 3a.") && REFRESH_3A.includes("**Ban list"));
  assert.ok(STATIC_RULES.includes(REFRESH_3A) && STATIC_RULES.includes(LOAD_DEFS));
  assert.ok(approxTokens(STATIC_RULES) >= 2048, `only ~${approxTokens(STATIC_RULES)} tokens`);
  assert.match(STATIC_RULES, /answer as JSON only/);
  assert.ok(!/2026-10-1\d/.test(STATIC_RULES)); // no run dates in the cached prefix
});

test("NARRATIVE_SCHEMA: closed objects, all four slots required in en and hr", () => {
  assert.equal(NARRATIVE_SCHEMA.additionalProperties, false);
  assert.deepEqual(NARRATIVE_SCHEMA.required, ["en", "hr"]);
  for (const lang of ["en", "hr"]) {
    const s = NARRATIVE_SCHEMA.properties[lang];
    assert.equal(s.additionalProperties, false);
    assert.deepEqual(s.required, ["trend", "flag", "prescription", "lever"]);
  }
});

test("parseNarrative: valid, missing slot, word-limit warnings", () => {
  const p = parseNarrative(NARR);
  assert.equal(p.ok, true);
  assert.deepEqual(p.warnings, []);
  assert.deepEqual(p.en, NARR.en);
  assert.deepEqual(parseNarrative({ en: NARR.en }), { ok: false, error: "missing hr" });
  assert.deepEqual(parseNarrative({ en: { ...NARR.en, lever: " " }, hr: NARR.hr }), { ok: false, error: "missing en.lever" });
  assert.equal(parseNarrative(null).ok, false);
  const long = parseNarrative({ en: { ...NARR.en, trend: "word ".repeat(61) }, hr: { ...NARR.hr, flag: "riječ ".repeat(67) } });
  assert.equal(long.ok, true);
  assert.deepEqual(long.warnings, ["en.trend 61 words > 60", "hr.flag 67 words > 66"]);
});

// ---- context ------------------------------------------------------------------------------

const DAY = 86400 * 1000;
function synthRecord(i, start, nEx = 12) {
  const exercises = Array.from({ length: nEx }, (_, k) => ({
    title: `Exercise number ${k} (Barbell)`, templateId: `T${k}`, notes: "", equipment: "barbell", primary: "quadriceps", secondary: [],
    sets: [
      { type: "warmup", kg: 40, reps: 10, rpe: null },
      ...Array.from({ length: 4 }, () => ({ type: "normal", kg: 60 + k + (i % 3) * 5, reps: 8, rpe: 8 })),
    ],
  }));
  return {
    id: `wk-${String(i).padStart(4, "0")}`, title: `Session ${i}`,
    start: new Date(start).toISOString(), end: new Date(start + 70 * 60000).toISOString(),
    updatedAt: new Date(start + 80 * 60000).toISOString(), exercises,
    totals: { tonnageAll: 12000, tonnageWork: 10000 + i, sets: 60, workSets: 48, hardSets: 48, failureSets: 2, avgRPE: 8 },
    muscles: { quadriceps: { hardSets: 30, tonnageWork: 6000 }, glutes: { hardSets: 9, tonnageWork: 2000 } },
    strava: null, hr: { startTime: new Date(start).toISOString(), t: [0, 5, 10], v: [100, 150, 140] }, status: "hr-attached",
  };
}

async function seed(kv, n = 14) {
  const recs = [];
  for (let i = 0; i < n; i++) {
    const r = synthRecord(i, NOW - (i + 0.5) * DAY);
    if (i === 0) {
      r.hrMatch = {
        method: "anchor-js", expected: 48, matched: 44, confSetsPct: 81,
        anchor: { exercise: "Exercise number 0 (Barbell)", tPeaks: [1300, 1500, 1700], peakHR: [151, 155, 157] },
        sets: [{ ex: 0, set: 1, tPeak: 1300, peakHR: 151, hrStart: 110, restBeforeS: 120, conf: 0.8 }, { ex: 0, set: 2, tPeak: 1500, peakHR: 162, conf: 0.7 }],
      };
    }
    await putWorkout(kv, r, NOW);
    recs.push(r);
  }
  return recs;
}

test("context: <= CONTEXT_MAX_TOKENS (<= 4000) for 14 heavy sessions; precomputed numbers", async () => {
  const kv = new MemoryKV();
  const recs = await seed(kv, 14);
  const { ctx, json, tokens } = await buildContext(kv, NOW, { focusId: recs[0].id });
  assert.ok(CONTEXT_MAX_TOKENS <= 4000);
  assert.ok(tokens <= CONTEXT_MAX_TOKENS, `context ~${tokens} tokens`);
  assert.equal(tokens, Math.ceil(json.length / 4));
  assert.equal(ctx.asOf, "2026-10-10");
  assert.equal(ctx.focusWorkoutId, recs[0].id);
  assert.ok(ctx.sessions.length >= 1 && ctx.sessions.length <= 5);
  assert.equal(ctx.sessions[0].id, recs[0].id);
  // rolling windows: 7 sessions in the last 7 days (i = 0..6), 7 in the window before
  assert.equal(ctx.weekly[0].sessions, 7);
  assert.equal(ctx.weekly[0].tonnageWork, Array.from({ length: 7 }, (_, i) => 10000 + i).reduce((a, b) => a + b));
  assert.equal(ctx.weekly[1].sessions, 7);
  assert.equal(ctx.weekly[2].tonnageWork, null); // before the 20-day KV horizon
  assert.equal(ctx.acwr, "n/a");
  assert.equal(ctx.muscles7d.quadriceps, 210);
  assert.equal(ctx.hrMatch.confSetsPct, 81);
  assert.equal(ctx.hrMatch.maxSetPeakHR, 162);
  assert.deepEqual(ctx.hrMatch.sessionHR, { avg: 130, max: 150 });
  assert.ok(!("sets" in ctx.hrMatch));
  assert.equal(ctx.sleep, null);
  const t0 = ctx.topSets.find((t) => t.ex === "Exercise number 0 (Barbell)");
  // i=0 -> 60 kg, i=1 -> 65 kg: (60-65)/65 = -7.7 %
  assert.deepEqual([t0.last.kg, t0.prev.kg, t0.jumpPct], [60, 65, -7.7]);
});

test("context: ACWR computed when four covered windows are supplied through extras", async () => {
  const kv = new MemoryKV();
  const weekly = [12000, 10000, 9000, 9000].map((t, i) => ({ from: `w${i}`, to: `w${i}`, tonnageWork: t, sessions: 3 }));
  const { ctx } = await buildContext(kv, NOW, { extras: { weekly } });
  assert.equal(ctx.acwr, 1.2); // 12000 / (40000 / 4)
  assert.equal(ctx.chronicWeeklyTonnage, 10000);
});

test("topSet: heaviest work set; rep-only exercises -> most reps; warm-ups ignored", () => {
  assert.deepEqual(topSet({ sets: [{ type: "warmup", kg: 100, reps: 5 }, { type: "normal", kg: 80, reps: 8, rpe: 8 }, { type: "normal", kg: 80, reps: 10, rpe: 9 }] }), { kg: 80, reps: 10, rpe: 9 });
  assert.deepEqual(topSet({ sets: [{ type: "normal", kg: null, reps: 12, rpe: null }, { type: "normal", kg: null, reps: 15, rpe: null }] }), { kg: null, reps: 15, rpe: null });
  assert.equal(topSet({ sets: [{ type: "warmup", kg: 20, reps: 10 }] }), null);
});

// ---- narrative runs + hooks ------------------------------------------------------------------

test("mode 'current' (default): no API call anywhere", async () => {
  const env = baseEnv();
  const recs = await seed(env.LIVE, 2);
  const f = claudeApi([message()]);
  const r = rt(env, f);
  assert.deepEqual(await runNarrative(r, { kind: "workout", workoutId: recs[0].id, manual: true }), { ok: false, err: "mode-current" });
  assert.equal(await afterWebhook(r, recs[0]), null);
  assert.deepEqual(await runCoach(r, { question: "How is my squat?", lang: "en" }), { ok: false, err: "mode-current" });
  assert.equal((await runScheduled({ cron: DAILY_CRON }, env, r)).daily.err, "mode-current");
  assert.equal(f.calls.length, 0);
});

test("workout narrative: stored as narr:<id>, indexed, served by /live/narrative", async () => {
  const env = baseEnv();
  await env.LIVE.put("cfg:mode", JSON.stringify("api"));
  const recs = await seed(env.LIVE, 3);
  const f = claudeApi([message()]);
  const r = rt(env, f);
  const out = await runNarrative(r, { kind: "workout", workoutId: recs[0].id });
  assert.equal(out.ok, true);
  const body = f.calls[0].body;
  assert.equal(body.system[0].text, STATIC_RULES);
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.max_tokens, 700);
  assert.equal(body.output_config.effort, "low");
  assert.match(body.messages[0].content, /^CONTEXT \(JSON\):\n\{/);
  assert.match(body.messages[0].content, /TASK: NARRATIVE, kind "workout"/);
  assert.ok(approxTokens(body.system[0].text) + approxTokens(body.messages[0].content) <= 6000); // contract: <= 6K input

  const stored = await env.LIVE.get(`narr:${recs[0].id}`, "json");
  assert.deepEqual([stored.kind, stored.workoutId, stored.model, stored.effort], ["workout", recs[0].id, "claude-opus-5-5", "low"]);
  assert.deepEqual(stored.en, NARR.en);
  assert.equal(env.LIVE.m.get(`narr:${recs[0].id}`).opts.expirationTtl, 30 * 86400);

  const res = await handle(new Request("https://hevy.er45.com/live/narrative?days=14", { headers: { Origin: "https://dash.er45.com" } }), env, fakeCtx(), r);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://dash.er45.com");
  const j = await res.json();
  assert.equal(j.mode, "api");
  assert.deepEqual(j.items, [{
    workoutId: recs[0].id, kind: "workout", createdAt: new Date(NOW).toISOString(),
    model: "claude-opus-5-5", effort: "low", en: NARR.en, hr: NARR.hr,
  }]);
});

test("afterWebhook: one call per webhook; resend of an unchanged workout costs nothing", async () => {
  const env = baseEnv();
  await env.LIVE.put("cfg:mode", JSON.stringify("api"));
  const recs = await seed(env.LIVE, 2);
  const f = claudeApi([message()]);
  const r = rt(env, f);
  assert.equal((await afterWebhook(r, recs[0])).ok, true);
  assert.deepEqual(await afterWebhook(r, recs[0]), { ok: true, skipped: "unchanged" });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await env.LIVE.get("narr:queue", "json"), []);
  // edited workout -> new narrative
  await putWorkout(env.LIVE, { ...recs[0], updatedAt: new Date(NOW + 1000).toISOString() }, NOW);
  await afterWebhook(r, { ...recs[0], updatedAt: new Date(NOW + 1000).toISOString() });
  assert.equal(f.calls.length, 2);
});

test("disabled function: no automatic call", async () => {
  const env = baseEnv();
  await env.LIVE.put("cfg:mode", JSON.stringify("api"));
  await env.LIVE.put("cfg:functions", JSON.stringify({ narrative_workout: { enabled: false } }));
  const recs = await seed(env.LIVE, 1);
  const f = claudeApi([message()]);
  assert.equal(await afterWebhook(rt(env, f), recs[0]), null);
  assert.equal(f.calls.length, 0);
});

test("queue: inline failure (network) is finished by the cron after the grace period", async () => {
  const env = baseEnv();
  await env.LIVE.put("cfg:mode", JSON.stringify("api"));
  const recs = await seed(env.LIVE, 1);
  let fail = true;
  const f = claudeApi([() => { if (fail) throw new TypeError("fetch failed"); return jsonResponse(message()); }]);
  const r = rt(env, f);
  const first = await afterWebhook(r, recs[0]);
  assert.deepEqual([first.ok, first.err], [false, "network"]);
  assert.equal(f.calls.length, 3); // 1 + 2 retries
  assert.equal((await env.LIVE.get("narr:queue", "json")).length, 1);

  fail = false;
  r.clock.t = NOW + 60 * 1000; // inside the grace period: untouched
  assert.equal(await processNarrativeQueue(r), null);
  r.clock.t = NOW + 6 * 60 * 1000;
  const second = await runScheduled({ cron: "*/10 * * * *", scheduledTime: r.clock.t }, env, r);
  assert.equal(second.narrative.ok, true);
  assert.deepEqual(await env.LIVE.get("narr:queue", "json"), []);
  assert.ok(await env.LIVE.get(`narr:${recs[0].id}`, "json"));
});

test("queue: a non-retryable failure (refusal, cap) is not retried", async () => {
  const env = baseEnv();
  await env.LIVE.put("cfg:mode", JSON.stringify("api"));
  const recs = await seed(env.LIVE, 1);
  const f = claudeApi([message({ content: [], stop_reason: "refusal", stop_details: { category: null } })]);
  const r = await afterWebhook(rt(env, f), recs[0]);
  assert.equal(r.err, "refusal:unknown");
  assert.deepEqual(await env.LIVE.get("narr:queue", "json"), []);
});

test("daily cron: one narrative per Zagreb date, stored as narr:daily:<date>", async () => {
  const env = baseEnv();
  await env.LIVE.put("cfg:mode", JSON.stringify("api"));
  await seed(env.LIVE, 3);
  const f = claudeApi([message()]);
  const r = rt(env, f, Date.parse("2026-10-10T05:40:00Z"));
  const a = await runScheduled({ cron: DAILY_CRON }, env, r);
  assert.equal(a.daily.ok, true);
  assert.match(f.calls[0].body.messages[0].content, /TASK: NARRATIVE, kind "daily", for 2026-10-10/);
  const stored = await env.LIVE.get("narr:daily:2026-10-10", "json");
  assert.deepEqual([stored.kind, stored.workoutId], ["daily", null]);
  const b = await runScheduled({ cron: DAILY_CRON }, env, r);
  assert.deepEqual(b.daily, { ok: true, skipped: "already-done" });
  assert.equal(f.calls.length, 1);
  assert.deepEqual((await env.LIVE.get("meta:narrDaily", "json")).ok, true);
});

test("coach: same cached system block, plain-text answer, usage logged as coach_chat", async () => {
  const env = baseEnv();
  await env.LIVE.put("cfg:mode", JSON.stringify("api"));
  await seed(env.LIVE, 2);
  const f = claudeApi([message({ content: [{ type: "text", text: "  Keep the squat at 65 kg for 4 × 8.  " }], usage: { input_tokens: 900, cache_read_input_tokens: 3100, output_tokens: 60 } })]);
  const r = await runCoach(rt(env, f), { question: "Should I add weight to the squat?", lang: "hr" });
  assert.deepEqual([r.ok, r.answer], [true, "Keep the squat at 65 kg for 4 × 8."]);
  const body = f.calls[0].body;
  assert.equal(body.system[0].text, STATIC_RULES);
  assert.equal(body.max_tokens, 900);
  assert.ok(!("format" in body.output_config));
  assert.match(body.messages[0].content, /COACH QUESTION\. Answer in Croatian \(hr\)/);
  // 900 x 4 + 3100 x 0.2 + 60 x 20 = 3,600 + 620 + 1,200 = 5,420 / 1e6
  assert.equal(r.usd, 0.00542);
  assert.equal((await env.LIVE.get("usage:recent", "json"))[0].fn, "coach_chat");
});

test("webhook end-to-end in mode 'api': Hevy fetch -> stored -> narrative in waitUntil", async () => {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/hevy-2026-09-26.json", import.meta.url), "utf8"));
  const env = baseEnv({ HEVY_API_KEY: "test-hevy", WEBHOOK_AUTH: "hook-secret" }); // no Strava -> pending
  await env.LIVE.put("cfg:mode", JSON.stringify("api"));
  const claude = claudeApi([message()]);
  const f = async (url, init = {}) => {
    if (/api\.hevyapp\.com\/v1\/workouts\//.test(String(url))) return jsonResponse(raw);
    if (String(url).startsWith("https://api.anthropic.com/")) return claude(url, init);
    return jsonResponse({ error: "no route" }, 404);
  };
  const now = Date.parse("2026-09-26T08:30:00Z");
  const r = rt(env, f, now);
  const ctx = fakeCtx();
  const res = await handle(new Request("https://hevy.er45.com/hook/hevy", {
    method: "POST", headers: { Authorization: "hook-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ workoutId: raw.id }),
  }), env, ctx, r);
  assert.equal(res.status, 200);
  await Promise.all(ctx.tasks);
  assert.equal(claude.calls.length, 1);
  const ctxJson = JSON.parse(claude.calls[0].body.messages[0].content.split("\n\nTASK:")[0].replace("CONTEXT (JSON):\n", ""));
  assert.equal(ctxJson.focusWorkoutId, raw.id);
  assert.equal(ctxJson.sessions[0].tonnageWork, 12670);
  const stored = await env.LIVE.get(`narr:${raw.id}`, "json");
  assert.equal(stored.kind, "workout");
  assert.equal(stored.workoutUpdatedAt, raw.updated_at);
});
