import { test } from "node:test";
import assert from "node:assert/strict";
import { checkWebhookAuth, corsHeaders, fetchRetry, safeEqual } from "../src/http.js";
import { handle, makeRuntime } from "../src/index.js";
import { fakeCtx, jsonResponse, MemoryKV, noSleep } from "./helpers.mjs";

const SECRET = "a".repeat(64);
const req = (path, init = {}) => new Request(`https://hevy.er45.com${path}`, init);

test("safeEqual", async () => {
  assert.equal(await safeEqual("abc", "abc"), true);
  assert.equal(await safeEqual("abc", "abd"), false);
  assert.equal(await safeEqual("abc", "abcd"), false);
});

test("webhook auth: exact value or Bearer form; unset secret never matches", async () => {
  const mk = (h) => req("/hook/hevy", { method: "POST", headers: h ? { Authorization: h } : {} });
  assert.equal(await checkWebhookAuth(mk(SECRET), SECRET), true);
  assert.equal(await checkWebhookAuth(mk(`Bearer ${SECRET}`), SECRET), true);
  assert.equal(await checkWebhookAuth(mk(SECRET + "x"), SECRET), false);
  assert.equal(await checkWebhookAuth(mk(null), SECRET), false);
  assert.equal(await checkWebhookAuth(mk(""), ""), false);
  assert.equal(await checkWebhookAuth(mk("anything"), undefined), false);
});

test("CORS: only the dashboard origins are echoed", () => {
  for (const o of ["https://dash.er45.com", "http://127.0.0.1:8100", "http://localhost:8100"]) {
    const h = corsHeaders(req("/live/recent", { headers: { Origin: o } }));
    assert.equal(h["Access-Control-Allow-Origin"], o);
    assert.equal(h["Access-Control-Allow-Methods"], "GET, OPTIONS");
  }
  const bad = corsHeaders(req("/live/recent", { headers: { Origin: "https://evil.example" } }));
  assert.equal(bad["Access-Control-Allow-Origin"], undefined);
  assert.equal(bad.Vary, "Origin");
});

test("router: 404 / 405 / OPTIONS / 401 / 400 / 200", async () => {
  const env = { LIVE: new MemoryKV(), WEBHOOK_AUTH: SECRET };
  const ctx = fakeCtx();
  const rt = makeRuntime(env, { fetch: async () => jsonResponse({}, 500), sleep: noSleep });

  assert.equal((await handle(req("/"), env, ctx, rt)).status, 404);
  assert.equal((await handle(req("/nope"), env, ctx, rt)).status, 404);
  const r405 = await handle(req("/hook/hevy"), env, ctx, rt);
  assert.equal(r405.status, 405);
  assert.equal(r405.headers.get("Allow"), "POST");
  assert.equal((await handle(req("/live/recent", { method: "POST" }), env, ctx, rt)).status, 405);

  const pre = await handle(req("/live/recent", { method: "OPTIONS", headers: { Origin: "https://dash.er45.com" } }), env, ctx, rt);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("Access-Control-Allow-Origin"), "https://dash.er45.com");

  const body = JSON.stringify({ workoutId: "744c0280-bf24-4ad4-9562-69a0cedaae7d" });
  assert.equal((await handle(req("/hook/hevy", { method: "POST", body }), env, ctx, rt)).status, 401);
  assert.equal((await handle(req("/hook/hevy", { method: "POST", body, headers: { Authorization: "wrong" } }), env, ctx, rt)).status, 401);
  assert.equal(ctx.tasks.length, 0, "no processing without auth");

  const bad = await handle(req("/hook/hevy", { method: "POST", body: "{}", headers: { Authorization: SECRET } }), env, ctx, rt);
  assert.equal(bad.status, 400);

  const ok = await handle(req("/hook/hevy", { method: "POST", body, headers: { Authorization: SECRET } }), env, ctx, rt);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal(ctx.tasks.length, 1, "processing deferred to waitUntil");
  await Promise.all(ctx.tasks);
});

test("health with no secrets: 200, degraded, names only", async () => {
  const env = { LIVE: new MemoryKV() };
  const res = await handle(req("/live/health", { headers: { Origin: "http://localhost:8100" } }), env, fakeCtx());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "http://localhost:8100");
  const j = await res.json();
  assert.equal(j.ok, false);
  assert.equal(j.status, "degraded");
  assert.equal(j.pending, 0);
  assert.equal(j.lastWebhookAt, null);
  assert.equal(j.lastCronAt, null);
  assert.deepEqual(j.missingSecrets, ["HEVY_API_KEY", "STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET", "STRAVA_REFRESH_TOKEN", "WEBHOOK_AUTH"]);
});

test("recent: empty list, days clamped", async () => {
  const env = { LIVE: new MemoryKV() };
  const res = await handle(req("/live/recent?days=999"), env, fakeCtx());
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(j.workouts, []);
  assert.ok(Date.parse(j.generatedAt));
});

test("fetchRetry: 429 (Retry-After 7) then 503 then 200 -> waits 7 s, 4 s; 404 not retried", async () => {
  const seq = [jsonResponse({}, 429, { "Retry-After": "7" }), jsonResponse({}, 503), jsonResponse({ ok: 1 }, 200)];
  const slept = [];
  const r = await fetchRetry("u", {}, { fetchImpl: async () => seq.shift(), sleep: async (ms) => slept.push(ms) });
  assert.equal(r.status, 200);
  assert.deepEqual(slept, [7000, 4000]);

  let n = 0;
  const r404 = await fetchRetry("u", {}, { fetchImpl: async () => { n += 1; return jsonResponse({}, 404); }, sleep: noSleep });
  assert.equal(r404.status, 404);
  assert.equal(n, 1);

  let m = 0;
  await assert.rejects(fetchRetry("u", {}, {
    attempts: 3, fetchImpl: async () => { m += 1; throw new Error("boom"); }, sleep: noSleep,
  }));
  assert.equal(m, 3);
});

test("/hook/hevy body: parsed from raw text whatever the Content-Type; > 64 KB -> 413; bad JSON -> 400", async () => {
  const env = { LIVE: new MemoryKV(), WEBHOOK_AUTH: SECRET };
  const ctx = fakeCtx();
  const rt = makeRuntime(env, { fetch: async () => jsonResponse({}, 500), sleep: noSleep });
  const id = "744c0280-bf24-4ad4-9562-69a0cedaae7d";
  const post = (body, ct) => handle(req("/hook/hevy", {
    method: "POST", body, headers: ct ? { Authorization: SECRET, "Content-Type": ct } : { Authorization: SECRET },
  }), env, ctx, rt);
  for (const ct of ["text/plain;charset=UTF-8", "application/json", "application/x-www-form-urlencoded", null]) {
    const r = await post(JSON.stringify({ workoutId: id }), ct);
    assert.equal(r.status, 200, String(ct));
  }
  const bad = await post("{workoutId:", "application/json");
  assert.deepEqual([bad.status, (await bad.json()).error], [400, "body must be JSON"]);
  const big = await post(JSON.stringify({ workoutId: id, pad: "x".repeat(64 * 1024) }), "text/plain");
  assert.deepEqual([big.status, (await big.json()).error], [413, "body too large"]);
  assert.equal((await post("", "text/plain")).status, 400); // empty -> no workoutId
  assert.equal((await post("[1,2]", "text/plain")).status, 400);
  assert.equal(ctx.tasks.length, 4);
  await Promise.all(ctx.tasks);
});

test("CORS preflight allows Content-Type and Authorization request headers", () => {
  const h = corsHeaders(req("/live/health", { headers: { Origin: "https://dash.er45.com" } }));
  assert.equal(h["Access-Control-Allow-Headers"], "Content-Type, Authorization");
});
