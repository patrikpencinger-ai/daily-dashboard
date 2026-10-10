// /admin/* through handle(): Access gate, CORS, config validation, usage, runs, status, ping,
// plus /live/pipeline and the additive /live/health fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCESS_TEAM, resetJwksCache } from "../src/access.js";
import { handle, makeRuntime } from "../src/index.js";
import { DEFAULT_FUNCTIONS } from "../src/narrative.js";
import { putWorkout } from "../src/store.js";
import { logUsage } from "../src/usage.js";
import { fakeCtx, jsonResponse, MemoryKV } from "./helpers.mjs";

const NOW = Date.parse("2026-10-10T08:00:00Z");
const AUD = "test-aud-admin";
const KEY = "sk-ant-test-admin-000000";
const BASE = "https://hevy.er45.com";

const b64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
const kp = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"],
);
const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
const JWK = { kty: "RSA", kid: "admin-k1", alg: "RS256", n: pub.n, e: pub.e };
async function jwt(over = {}) {
  const h = enc({ alg: "RS256", kid: "admin-k1", typ: "JWT" });
  const p = enc({ aud: [AUD], iss: ACCESS_TEAM, email: "athlete@example.com", exp: NOW / 1000 + 3600, iat: NOW / 1000, ...over });
  const s = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(s))}`;
}
const TOKEN = await jwt();

const NARR = {
  en: { trend: "Tonnage rose.", flag: "No flag trips.", prescription: "Next session: squat, 4 × 8 at 80 kg.", lever: "Lights out by 23:00." },
  hr: { trend: "Tonaža je porasla.", flag: "Nema upozorenja.", prescription: "Sljedeći trening: čučanj, 4 × 8 sa 80 kg.", lever: "Gašenje svjetla do 23:00." },
};

function setup({ aud = AUD, key = KEY, claude = null } = {}) {
  resetJwksCache();
  const env = { LIVE: new MemoryKV(), ACCESS_AUD: aud, ANTHROPIC_API_KEY: key, WEBHOOK_AUTH: "hook-secret" };
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init, body: init.body ? JSON.parse(init.body) : null });
    if (u === `${ACCESS_TEAM}/cdn-cgi/access/certs`) return jsonResponse({ keys: [JWK] });
    if (u.startsWith("https://api.anthropic.com/v1/models")) return jsonResponse({ data: [] });
    if (u === "https://api.anthropic.com/v1/messages") return claude ? claude(init) : jsonResponse({ error: "unexpected" }, 500);
    return jsonResponse({ error: "no route" }, 404);
  };
  const rt = makeRuntime(env, { fetch: f, sleep: async () => {}, now: () => NOW });
  const call = async (method, path, { body, token = TOKEN, origin, headers = {} } = {}) => {
    const h = { ...headers };
    if (token) h["Cf-Access-Jwt-Assertion"] = token;
    if (origin) h.Origin = origin;
    if (body !== undefined) h["Content-Type"] = "application/json";
    const res = await handle(new Request(BASE + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) }), env, fakeCtx(), rt);
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
  };
  const claudeCalls = () => calls.filter((c) => c.url === "https://api.anthropic.com/v1/messages");
  return { env, rt, call, calls, claudeCalls };
}

const claudeOk = (text, usage = { input_tokens: 800, cache_read_input_tokens: 3000, output_tokens: 120 }) => () => jsonResponse({
  id: "m", type: "message", role: "assistant", model: "claude-opus-5-5",
  content: [{ type: "text", text }], stop_reason: "end_turn", stop_details: null, usage,
});

// ---- gate ------------------------------------------------------------------------------

test("ACCESS_AUD empty -> every /admin/* is 503 'admin not configured' (incl. OPTIONS, unknown paths)", async () => {
  const { call, calls } = setup({ aud: "" });
  for (const [m, p] of [["GET", "/admin/status"], ["PUT", "/admin/config"], ["OPTIONS", "/admin/config"], ["GET", "/admin/nope"], ["POST", "/admin/coach"]]) {
    const r = await call(m, p);
    assert.equal(r.status, 503, `${m} ${p}`);
    assert.deepEqual(r.json, { ok: false, error: "admin not configured" });
  }
  assert.equal(calls.length, 0);
});

test("no token / bad token / wrong aud -> 401; valid token -> 200", async () => {
  const { call } = setup();
  assert.equal((await call("GET", "/admin/status", { token: null })).status, 401);
  assert.equal((await call("GET", "/admin/status", { token: "x.y.z" })).status, 401);
  assert.equal((await call("GET", "/admin/status", { token: await jwt({ aud: ["other"] }) })).status, 401);
  assert.equal((await call("GET", "/admin/status", { token: await jwt({ exp: NOW / 1000 - 3600 }) })).status, 401);
  const ok = await call("GET", "/admin/status");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Cache-Control"), "no-store");
});

test("CORS: credentials only for dash.er45.com; preflight 204 without a token; unknown origin gets nothing", async () => {
  const { call } = setup();
  const dash = await call("GET", "/admin/config", { origin: "https://dash.er45.com" });
  assert.equal(dash.headers.get("Access-Control-Allow-Origin"), "https://dash.er45.com");
  assert.equal(dash.headers.get("Access-Control-Allow-Credentials"), "true");
  const local = await call("GET", "/admin/config", { origin: "http://localhost:8100" });
  assert.equal(local.headers.get("Access-Control-Allow-Origin"), "http://localhost:8100");
  assert.equal(local.headers.get("Access-Control-Allow-Credentials"), null);
  const evil = await call("GET", "/admin/config", { origin: "https://evil.example" });
  assert.equal(evil.headers.get("Access-Control-Allow-Origin"), null);
  const pre = await call("OPTIONS", "/admin/config", { token: null, origin: "https://dash.er45.com" });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("Access-Control-Allow-Methods"), /PUT/);
  assert.equal(pre.headers.get("Access-Control-Allow-Credentials"), "true");
});

test("wrong method -> 405 with Allow; unknown admin path -> 404", async () => {
  const { call } = setup();
  const r = await call("DELETE", "/admin/config");
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("Allow"), "GET, PUT, OPTIONS");
  assert.equal((await call("GET", "/admin/nope")).status, 404);
});

// ---- config ---------------------------------------------------------------------------

test("GET /admin/config: defaults (mode current, Opus 5.5 low, 700 / chat 900), PRICES, cap", async () => {
  const { call } = setup();
  const r = await call("GET", "/admin/config");
  assert.equal(r.json.mode, "current");
  assert.deepEqual(r.json.functions, DEFAULT_FUNCTIONS);
  assert.deepEqual(r.json.functions.coach_chat, { model: "claude-opus-5-5", effort: "low", maxTokens: 900, enabled: true });
  assert.deepEqual(r.json.allowed.models, ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  assert.deepEqual(r.json.allowed.efforts, ["low", "medium", "high"]);
  assert.equal(r.json.prices["claude-opus-5-5"].input, 4);
  assert.equal(r.json.maxUsdPerDay, 1);
  assert.equal(r.json.crons.daily, "40 5 * * *");
});

test("PUT /admin/config: validation errors -> 400, nothing stored", async () => {
  const { call, env } = setup();
  const bad = [
    [{ mode: "turbo" }, /mode must be one of current\|api/],
    [{ functions: { coach_chat: { model: "gpt-4" } } }, /coach_chat\.model must be one of/],
    [{ functions: { coach_chat: { model: "claude-opus-4-8" } } }, /coach_chat\.model/],
    [{ functions: { narrative_daily: { effort: "max" } } }, /effort must be one of low\|medium\|high/],
    [{ functions: { narrative_daily: { maxTokens: 99 } } }, /maxTokens must be an integer 100-2000/],
    [{ functions: { narrative_daily: { maxTokens: 2001 } } }, /maxTokens/],
    [{ functions: { narrative_daily: { maxTokens: 500.5 } } }, /maxTokens/],
    [{ functions: { narrative_daily: { enabled: "yes" } } }, /enabled must be true or false/],
    [{ functions: { summarize: {} } }, /unknown function: summarize/],
    [{ functions: { coach_chat: { temperature: 1 } } }, /unknown field: coach_chat\.temperature/],
    [{ extra: 1 }, /unknown field: extra/],
    [[1, 2], /JSON object/],
  ];
  for (const [body, re] of bad) {
    const r = await call("PUT", "/admin/config", { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.json.errors.join("; "), re);
  }
  assert.equal((await call("PUT", "/admin/config", { body: "{not json" })).status, 400);
  assert.equal(await env.LIVE.get("cfg:mode"), null);
  assert.equal(await env.LIVE.get("cfg:functions"), null);
});

test("PUT /admin/config: valid patch stored and merged; GET reflects it", async () => {
  const { call, env } = setup();
  const r = await call("PUT", "/admin/config", {
    body: { mode: "api", functions: { coach_chat: { model: "claude-haiku-5-5", effort: "medium", maxTokens: 2000 }, narrative_daily: { enabled: false } } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.mode, "api");
  assert.deepEqual(r.json.functions.coach_chat, { model: "claude-haiku-5-5", effort: "medium", maxTokens: 2000, enabled: true });
  assert.equal(r.json.functions.narrative_daily.enabled, false);
  assert.deepEqual(r.json.functions.narrative_workout, DEFAULT_FUNCTIONS.narrative_workout);
  assert.equal(await env.LIVE.get("cfg:mode", "json"), "api");
  const g = await call("GET", "/admin/config");
  assert.equal(g.json.functions.coach_chat.model, "claude-haiku-5-5");
  // back to current
  assert.equal((await call("PUT", "/admin/config", { body: { mode: "current" } })).json.mode, "current");
});

// ---- usage ----------------------------------------------------------------------------

test("GET /admin/usage: grouping, defaults (last 30 Zagreb days), validation; /usage/recent", async () => {
  const { call, env } = setup();
  await logUsage(env.LIVE, { fn: "narrative_workout", model: "claude-opus-5-5", effort: "low", in: 1200, cacheRead: 0, cacheWrite: 2600, out: 450, usd: 0.0268, ms: 4100, ok: true, err: null }, NOW - 3 * 86400 * 1000);
  await logUsage(env.LIVE, { fn: "coach_chat", model: "claude-opus-5-5", effort: "low", in: 800, cacheRead: 3000, cacheWrite: 0, out: 120, usd: 0.0062, ms: 2000, ok: true, err: null }, NOW);
  const day = await call("GET", "/admin/usage");
  assert.equal(day.status, 200);
  assert.deepEqual([day.json.from, day.json.to, day.json.group], ["2026-09-11", "2026-10-10", "day"]);
  assert.deepEqual(day.json.rows.map((r) => [r.key, r.calls, r.usd]), [["2026-10-07", 1, 0.0268], ["2026-10-10", 1, 0.0062]]);
  assert.deepEqual(Object.keys(day.json.rows[0]).slice(0, 7), ["key", "calls", "inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "usd"]);
  assert.equal(day.json.totals.usd, 0.033);
  const fn = await call("GET", "/admin/usage?group=function&from=2026-10-10&to=2026-10-10");
  assert.deepEqual(fn.json.rows.map((r) => r.key), ["coach_chat"]);
  assert.deepEqual((await call("GET", "/admin/usage?group=model")).json.rows.map((r) => [r.key, r.calls]), [["claude-opus-5-5", 2]]);
  assert.deepEqual((await call("GET", "/admin/usage?group=week")).json.rows.map((r) => r.key), ["2026-W41"]);
  assert.deepEqual((await call("GET", "/admin/usage?group=month")).json.rows.map((r) => r.key), ["2026-10"]);
  assert.equal((await call("GET", "/admin/usage?group=year")).status, 400);
  assert.equal((await call("GET", "/admin/usage?from=2026-10-10&to=2026-10-01")).status, 400);
  assert.equal((await call("GET", "/admin/usage?from=2026-13-01")).status, 400);
  assert.equal((await call("GET", "/admin/usage?from=2024-01-01&to=2026-10-10")).status, 400);
  const recent = await call("GET", "/admin/usage/recent");
  assert.deepEqual(recent.json.items.map((e) => [e.fn, e.ms]), [["coach_chat", 2000], ["narrative_workout", 4100]]);
});

// ---- runs ----------------------------------------------------------------------------

async function seedWorkout(env) {
  const start = NOW - 3600 * 1000;
  await putWorkout(env.LIVE, {
    id: "wk-admin-1", title: "Legs", start: new Date(start).toISOString(), end: new Date(start + 60 * 60000).toISOString(),
    updatedAt: new Date(start).toISOString(),
    exercises: [{ title: "Squat (Barbell)", sets: [{ type: "normal", kg: 80, reps: 8, rpe: 8 }] }],
    totals: { tonnageWork: 640, hardSets: 1, failureSets: 0, avgRPE: 8 }, muscles: { quadriceps: { hardSets: 1, tonnageWork: 640 } },
    strava: null, hr: null, status: "received",
  }, NOW);
}

test("mode current: narrative/run and coach -> 409, no Claude call", async () => {
  const { call, env, claudeCalls } = setup({ claude: claudeOk(JSON.stringify(NARR)) });
  await seedWorkout(env);
  const a = await call("POST", "/admin/narrative/run", { body: { workoutId: "daily" } });
  assert.deepEqual([a.status, a.json.err], [409, "mode-current"]);
  const b = await call("POST", "/admin/narrative/run", { body: { workoutId: "latest" } });
  assert.deepEqual([b.status, b.json.err], [409, "mode-current"]);
  const c = await call("POST", "/admin/coach", { body: { question: "How am I doing?", lang: "en" } });
  assert.deepEqual([c.status, c.json.err], [409, "mode-current"]);
  assert.equal(claudeCalls().length, 0);
});

test("mode api: narrative/run latest + daily; unknown id 404; bad id 400", async () => {
  const { call, env, claudeCalls } = setup({ claude: claudeOk(JSON.stringify(NARR)) });
  await env.LIVE.put("cfg:mode", JSON.stringify("api"));
  await seedWorkout(env);
  const w = await call("POST", "/admin/narrative/run", { body: { workoutId: "latest" } });
  assert.equal(w.status, 200);
  assert.deepEqual([w.json.ok, w.json.item.workoutId, w.json.item.kind], [true, "wk-admin-1", "workout"]);
  const d = await call("POST", "/admin/narrative/run", { body: { workoutId: "daily" } });
  assert.deepEqual([d.status, d.json.item.kind], [200, "daily"]);
  // manual daily re-run overwrites (cron would skip)
  assert.equal((await call("POST", "/admin/narrative/run", { body: { workoutId: "daily" } })).status, 200);
  assert.equal(claudeCalls().length, 3);
  assert.equal((await call("POST", "/admin/narrative/run", { body: { workoutId: "wk-missing-9" } })).status, 404);
  assert.equal((await call("POST", "/admin/narrative/run", { body: { workoutId: "../etc" } })).status, 400);
});

test("coach: validation; answer + usage + usd; cap -> 429", async () => {
  const { call, env, claudeCalls } = setup({ claude: claudeOk("Hold 80 kg for 4 × 8 on Monday.") });
  await env.LIVE.put("cfg:mode", JSON.stringify("api"));
  await seedWorkout(env);
  assert.equal((await call("POST", "/admin/coach", { body: {} })).status, 400);
  assert.equal((await call("POST", "/admin/coach", { body: { question: "x".repeat(1001) } })).status, 400);
  assert.equal((await call("POST", "/admin/coach", { body: { question: "ok?", lang: "de" } })).status, 400);
  assert.equal(claudeCalls().length, 0);
  const r = await call("POST", "/admin/coach", { body: { question: "What next for squats?", lang: "en" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.answer, "Hold 80 kg for 4 × 8 on Monday.");
  assert.deepEqual(r.json.usage, { in: 800, cacheRead: 3000, cacheWrite: 0, out: 120 });
  // 800 x 4 + 3000 x 0.2 + 120 x 20 = 3,200 + 600 + 2,400 = 6,200 / 1e6
  assert.equal(r.json.usd, 0.0062);
  // cap reached
  env.MAX_USD_PER_DAY = "0.005";
  const capped = await call("POST", "/admin/coach", { body: { question: "Again?" } });
  assert.deepEqual([capped.status, capped.json.err], [429, "cap"]);
  assert.equal(claudeCalls().length, 1);
});

// ---- status / ping / pipeline / health ----------------------------------------------

test("POST /live/pipeline (auth) -> KV pipeline:last; GET /admin/status shows it", async () => {
  const { call, env } = setup();
  const hb = { host: "mac", ranAt: "2026-10-10T07:30:00Z", changed: true, commit: "abc1234", durationS: 42, errors: ["fetch-hr rc=3"] };
  assert.equal((await call("POST", "/live/pipeline", { token: null, body: hb })).status, 401);
  assert.equal((await call("POST", "/live/pipeline", { token: null, headers: { Authorization: "wrong" }, body: hb })).status, 401);
  assert.equal((await call("GET", "/live/pipeline", { token: null, headers: { Authorization: "hook-secret" } })).status, 405);
  assert.equal((await call("POST", "/live/pipeline", { token: null, headers: { Authorization: "hook-secret" }, body: "nope" })).status, 400);
  const ok = await call("POST", "/live/pipeline", { token: null, headers: { Authorization: "Bearer hook-secret" }, body: hb });
  assert.deepEqual([ok.status, ok.json], [200, { ok: true }]);
  assert.deepEqual(await env.LIVE.get("pipeline:last", "json"), { ...hb, receivedAt: new Date(NOW).toISOString() });

  await logUsage(env.LIVE, { fn: "coach_chat", usd: 0.01, ok: false, err: "http 500" }, NOW);
  const s = await call("GET", "/admin/status");
  assert.equal(s.status, 200);
  assert.deepEqual(s.json.pipeline.commit, "abc1234");
  assert.equal(s.json.mode, "current");
  assert.equal(s.json.apiKeyConfigured, true);
  assert.equal(s.json.spendTodayUsd, 0.01);
  assert.deepEqual(s.json.cron, { every10: "*/10 * * * *", daily: "40 5 * * *", lastAt: null, pending: 0 });
  assert.equal(s.json.lastErrors[0].err, "http 500");
  assert.deepEqual(s.json.kv, { workouts: 0, pending: 0, hr: 0, narratives: 0 });
});

test("GET /admin/ping: free models check, no usage logged", async () => {
  const { call, calls, env } = setup();
  const r = await call("GET", "/admin/ping");
  assert.deepEqual(r.json, { ok: true, status: 200, ms: 0 });
  assert.ok(calls.some((c) => c.url === "https://api.anthropic.com/v1/models?limit=1"));
  assert.equal(await env.LIVE.get("usage:recent"), null);
  const nokey = setup({ key: "" });
  assert.deepEqual((await nokey.call("GET", "/admin/ping")).json, { ok: false, status: 0, error: "ANTHROPIC_API_KEY not configured" });
});

test("/live/health: additive mode + spendTodayUsd; existing fields unchanged", async () => {
  const { call, env } = setup();
  await logUsage(env.LIVE, { usd: 0.0268, ok: true }, NOW);
  const h = await call("GET", "/live/health", { token: null });
  assert.equal(h.status, 200);
  assert.equal(h.json.mode, "current");
  assert.equal(h.json.spendTodayUsd, 0.0268);
  assert.equal(h.json.maxUsdPerDay, 1);
  for (const k of ["ok", "status", "lastWebhookAt", "lastCronAt", "pending", "missingSecrets", "kv", "lastError"]) assert.ok(k in h.json, k);
  assert.ok(!JSON.stringify(h.json).includes(KEY));
});
