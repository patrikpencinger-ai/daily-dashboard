// Authenticated local-pipeline API: /live/hr, /live/hr/<id>, /live/strava/sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildDescription } from "../src/format.js";
import { handle, makeRuntime } from "../src/index.js";
import { hrDoc } from "../src/match.js";
import { processWebhook } from "../src/process.js";
import { fakeCtx, jsonResponse, MemoryKV, noSleep, scriptedFetch } from "./helpers.mjs";

const raw = JSON.parse(readFileSync(new URL("./fixtures/hevy-2026-09-26.json", import.meta.url), "utf8"));
const NOW = Date.parse("2026-09-26T08:30:00Z");
const AUTH = "b".repeat(64);
const env = (extra = {}) => ({
  LIVE: new MemoryKV(),
  HEVY_API_KEY: "test-hevy",
  STRAVA_CLIENT_ID: "1",
  STRAVA_CLIENT_SECRET: "test-secret",
  STRAVA_REFRESH_TOKEN: "seed-refresh",
  WEBHOOK_AUTH: AUTH,
  ...extra,
});
const req = (path, init = {}) => new Request(`https://hevy.er45.com${path}`, init);
const authed = (path, init = {}) => req(path, { ...init, headers: { Authorization: AUTH, ...(init.headers || {}) } });

const watch = {
  id: 555, name: "Weight Training", sport_type: "WeightTraining",
  start_date: "2026-09-26T07:08:00Z", start_date_local: "2026-09-26T09:08:00Z", elapsed_time: 3500,
};
const run = { id: 9, name: "Run", sport_type: "Run", start_date: "2026-09-26T05:00:00Z", elapsed_time: 60 };
const TIME = [0, 1, 2, 5, 6];
const HR = [90, 92, 94, 120, 122];

// The exact dict tools/strava_sync.py hr_cache_doc builds (same keys, same order).
const EXPECTED_DOC = {
  startTime: "2026-09-26T07:08:00.000Z",
  sampleCount: 5,
  streams: { heart_rate: { unit: "bpm", values: HR } },
  timestamps: TIME,
  source: "strava",
  stravaId: 555,
  name: "Weight Training",
};

function apis({ activities = () => [watch, run], streams = true, activity = {}, rateLimited = false } = {}) {
  const puts = [];
  const f = scriptedFetch([
    ["GET", /api\.hevyapp\.com\/v1\/workouts\/744c0280/, () => jsonResponse(raw)],
    ["GET", /api\.hevyapp\.com\/v1\/workouts\?/, () => jsonResponse({ page: 1, page_count: 1, workouts: [raw] })],
    ["POST", /strava\.com\/oauth\/token/, () => jsonResponse({
      access_token: "acc", refresh_token: "rotated", expires_at: NOW / 1000 + 21600,
    })],
    ["GET", /\/athlete\/activities/, () => (rateLimited
      ? jsonResponse({ message: "Rate Limit Exceeded" }, 429)
      : jsonResponse(activities(), 200, { "X-RateLimit-Limit": "200,2000", "X-RateLimit-Usage": "3,40" }))],
    ["GET", /\/activities\/555\/streams/, () => (streams
      ? jsonResponse({ time: { data: TIME }, heartrate: { data: HR } })
      : jsonResponse({ message: "not found" }, 404))],
    ["GET", /\/activities\/555$/, () => jsonResponse({ ...watch, description: "", ...activity })],
    ["GET", /\/activities\/9$/, () => jsonResponse({ ...run })],
    ["PUT", /\/activities\/555$/, (u, init) => {
      puts.push(JSON.parse(init.body));
      return jsonResponse({ id: 555 });
    }],
  ]);
  f.puts = puts;
  return f;
}

const call = async (e, f, request) => handle(request, e, fakeCtx(), makeRuntime(e, { fetch: f, sleep: noSleep, now: () => NOW }));

test("new endpoints: no / wrong / unset auth -> 401 and no upstream call", async () => {
  const paths = [["/live/hr?since=2026-09-20", "GET"], ["/live/hr/555", "GET"], ["/live/strava/sync?days=3", "POST"]];
  for (const [p, method] of paths) {
    for (const [e, headers] of [
      [env(), {}],
      [env(), { Authorization: "wrong" }],
      [env(), { Authorization: AUTH + "0" }],
      [env({ WEBHOOK_AUTH: undefined }), { Authorization: AUTH }],
      [env({ WEBHOOK_AUTH: "" }), { Authorization: "" }],
    ]) {
      const f = apis();
      const res = await call(e, f, req(p, { method, headers }));
      assert.equal(res.status, 401, `${method} ${p}`);
      assert.deepEqual(await res.json(), { ok: false, code: "unauthorized", error: "unauthorized" });
      assert.equal(f.calls.length, 0, "nothing fetched without auth");
    }
  }
});

test("wrong method with auth -> 405; Bearer form accepted", async () => {
  const e = env();
  assert.equal((await call(e, apis(), authed("/live/hr?since=2026-09-20", { method: "POST" }))).status, 405);
  assert.equal((await call(e, apis(), authed("/live/strava/sync"))).status, 405);
  const res = await call(e, apis(), req("/live/hr?since=2026-09-20", { headers: { Authorization: `Bearer ${AUTH}` } }));
  assert.equal(res.status, 200);
});

test("hrDoc = strava_sync.py hr_cache_doc schema; null without a usable stream", () => {
  const doc = hrDoc(watch, { time: { data: TIME }, heartrate: { data: HR } });
  assert.deepEqual(doc, EXPECTED_DOC);
  assert.deepEqual(Object.keys(doc), Object.keys(EXPECTED_DOC));
  assert.equal(hrDoc(watch, { time: { data: [0, 1] }, heartrate: { data: [90] } }), null);
  assert.equal(hrDoc(watch, null), null);
  assert.equal(hrDoc({ ...watch, start_date: "2026-09-26T07:08:00.750Z" }, { time: { data: [0] }, heartrate: { data: [80] } }).startTime,
    "2026-09-26T07:08:00.000Z");
});

test("GET /live/hr?since lists strength activities only; sampleCount null until cached", async () => {
  const e = env();
  const f = apis();
  const res = await call(e, f, authed("/live/hr?since=2026-09-20"));
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.deepEqual(list, [{
    stravaId: 555, name: "Weight Training", startTime: "2026-09-26T07:08:00.000Z",
    startDateLocal: "2026-09-26T09:08:00Z", workoutId: null, sampleCount: null,
  }]);
  const listCall = f.calls.find((c) => c.url.includes("/athlete/activities"));
  assert.equal(new URL(listCall.url).searchParams.get("after"), String(Date.parse("2026-09-20T00:00:00Z") / 1000));
  assert.equal(listCall.init.headers.Authorization, "Bearer acc");

  for (const bad of ["", "?since=2026-9-1", "?since=yesterday", "?since=2026-13-45"]) {
    assert.equal((await call(e, apis(), authed(`/live/hr${bad}`))).status, 400, bad);
  }
});

test("GET /live/hr/<id>: fetch on demand -> exact schema, cached in KV hr:<id> with TTL", async () => {
  const e = env();
  const f = apis();
  const res = await call(e, f, authed("/live/hr/555"));
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.deepEqual(doc, EXPECTED_DOC);
  assert.deepEqual(Object.keys(doc), ["startTime", "sampleCount", "streams", "timestamps", "source", "stravaId", "name"]);
  const stored = e.LIVE.m.get("hr:555");
  assert.equal(stored.opts.expirationTtl, 20 * 86400);
  assert.deepEqual(stored.metadata, { sampleCount: 5 });

  // second call is served from KV (no Strava call) and the list now shows sampleCount
  const f2 = apis();
  assert.deepEqual(await (await call(e, f2, authed("/live/hr/555"))).json(), EXPECTED_DOC);
  assert.equal(f2.calls.length, 0);
  const list = await (await call(e, apis(), authed("/live/hr?since=2026-09-20"))).json();
  assert.equal(list[0].sampleCount, 5);
});

test("GET /live/hr/<id>: no stream -> 404 no-hr (remembered), non-strength / bad id -> 404 / 400", async () => {
  const e = env();
  const r = await call(e, apis({ streams: false }), authed("/live/hr/555"));
  assert.equal(r.status, 404);
  assert.equal((await r.json()).code, "no-hr");
  const f2 = apis();
  assert.equal((await call(e, f2, authed("/live/hr/555"))).status, 404);
  assert.equal(f2.calls.length, 0, "no-hr marker served from KV");
  assert.equal(e.LIVE.m.get("hr:555").opts.expirationTtl, 6 * 3600);

  const r9 = await call(env(), apis(), authed("/live/hr/9"));
  assert.equal(r9.status, 404);
  assert.equal((await r9.json()).code, "not-found");
  assert.equal((await call(env(), apis(), authed("/live/hr/abc"))).status, 400);
  assert.equal((await call(env(), apis(), authed("/live/hr/77777"))).status, 404, "unknown activity");
});

test("webhook path stores the full-resolution doc next to the 5 s downsample", async () => {
  const e = env();
  const f = apis({ activities: () => [watch] });
  const rec = await processWebhook(makeRuntime(e, { fetch: f, sleep: noSleep, now: () => NOW }), raw.id);
  assert.equal(rec.status, "hr-attached");
  const doc = JSON.parse(e.LIVE.m.get("hr:555").value);
  assert.deepEqual(doc, { ...EXPECTED_DOC, name: raw.title }, "name = the renamed title");
  const list = await (await call(e, apis(), authed("/live/hr?since=2026-09-20"))).json();
  assert.equal(list[0].workoutId, raw.id, "workoutId from the live index");
  assert.equal(list[0].sampleCount, 5);
});

test("POST /live/strava/sync: dry-run plans, live run PUTs, footer skip, force", async () => {
  const e = env();
  const f = apis();
  const dry = await (await call(e, f, authed("/live/strava/sync?days=3&dryRun=1", { method: "POST" }))).json();
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.days, 3);
  assert.equal(dry.activities, 1);
  assert.equal(dry.workouts, 1);
  assert.equal(dry.updated, 1);
  assert.equal(dry.items[0].action, "would-update");
  assert.equal(f.puts.length, 0);

  const live = await (await call(e, f, authed("/live/strava/sync?days=3", { method: "POST" }))).json();
  assert.equal(live.updated, 1);
  assert.equal(live.items[0].action, "updated");
  assert.deepEqual(f.puts, [{ name: raw.title, description: buildDescription(raw) }]);

  const synced = apis({ activity: { name: "Old", description: "x\n\n— synced from Hevy" } });
  const s = await (await call(e, synced, authed("/live/strava/sync?days=3", { method: "POST" }))).json();
  assert.equal(s.skipped, 1);
  assert.equal(synced.puts.length, 0);
  const forced = apis({ activity: { name: "Old", description: "x\n\n— synced from Hevy" } });
  const fz = await (await call(e, forced, authed("/live/strava/sync?days=3&force=1", { method: "POST" }))).json();
  assert.equal(fz.updated, 1);
  assert.equal(forced.puts.length, 1);

  const same = apis({ activity: { name: raw.title, description: buildDescription(raw) } });
  const u = await (await call(e, same, authed("/live/strava/sync?days=99&force=1", { method: "POST" }))).json();
  assert.equal(u.unchanged, 1);
  assert.equal(u.days, 30, "days clamped");
  assert.equal(same.puts.length, 0);
});

test("errors: secrets missing -> 503 not-configured (names only); Strava 429 -> 503 rate-limited + Retry-After", async () => {
  const e = env({ STRAVA_REFRESH_TOKEN: undefined, HEVY_API_KEY: undefined });
  const r1 = await call(e, apis(), authed("/live/hr?since=2026-09-20"));
  assert.equal(r1.status, 503);
  const j1 = await r1.json();
  assert.equal(j1.code, "not-configured");
  assert.deepEqual(j1.missing, ["STRAVA_REFRESH_TOKEN"]);
  const r2 = await call(e, apis(), authed("/live/strava/sync", { method: "POST" }));
  assert.deepEqual((await r2.json()).missing, ["HEVY_API_KEY", "STRAVA_REFRESH_TOKEN"]);

  const e3 = env();
  const r3 = await call(e3, apis({ rateLimited: true }), authed("/live/hr?since=2026-09-20"));
  assert.equal(r3.status, 503);
  assert.equal((await r3.json()).code, "rate-limited");
  assert.ok(Number(r3.headers.get("Retry-After")) >= 1);
  assert.ok(e3.LIVE.m.has("strava:throttle"));

  const e4 = env();
  const bad = scriptedFetch([["POST", /oauth\/token/, () => jsonResponse({ message: "Bad Request" }, 400)]]);
  const r4 = await call(e4, bad, authed("/live/hr/555"));
  assert.equal(r4.status, 503);
  const j4 = await r4.json();
  assert.equal(j4.code, "strava-auth");
  assert.ok(!JSON.stringify(j4).includes("test-secret") && !JSON.stringify(j4).includes("seed-refresh"));
});
