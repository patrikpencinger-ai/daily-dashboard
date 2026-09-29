// End-to-end processing against scripted Hevy / Strava APIs and an in-memory KV.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildDescription } from "../src/format.js";
import { handle, makeRuntime } from "../src/index.js";
import { processWebhook, runCron } from "../src/process.js";
import { fakeCtx, jsonResponse, MemoryKV, noSleep, scriptedFetch } from "./helpers.mjs";

const raw = JSON.parse(readFileSync(new URL("./fixtures/hevy-2026-09-26.json", import.meta.url), "utf8"));
const NOW = Date.parse("2026-09-26T08:30:00Z");
const env = () => ({
  LIVE: new MemoryKV(),
  HEVY_API_KEY: "test-hevy",
  STRAVA_CLIENT_ID: "1",
  STRAVA_CLIENT_SECRET: "test-secret",
  STRAVA_REFRESH_TOKEN: "seed-refresh",
  WEBHOOK_AUTH: "hook-secret",
});

function apis({ activities, streams = true, activity = {} }) {
  const puts = [];
  const f = scriptedFetch([
    ["GET", /api\.hevyapp\.com\/v1\/workouts\/744c0280/, () => jsonResponse(raw)],
    ["POST", /strava\.com\/oauth\/token/, () => jsonResponse({
      access_token: "acc", refresh_token: "rotated", expires_at: NOW / 1000 + 21600,
    })],
    ["GET", /\/athlete\/activities/, () => jsonResponse(activities(), 200, {
      "X-RateLimit-Limit": "200,2000", "X-RateLimit-Usage": "3,40",
    })],
    ["GET", /\/activities\/555\/streams/, () => (streams
      ? jsonResponse({ time: { data: [0, 1, 2, 5, 6] }, heartrate: { data: [90, 92, 94, 120, 122] } })
      : jsonResponse({ message: "not found" }, 404))],
    ["GET", /\/activities\/555$/, () => jsonResponse({
      id: 555, name: "Weight Training", description: "", start_date: "2026-09-26T07:08:00Z", ...activity,
    })],
    ["PUT", /\/activities\/555$/, (u, init) => {
      puts.push(JSON.parse(init.body));
      return jsonResponse({ id: 555 });
    }],
  ]);
  f.puts = puts;
  return f;
}

const watch = { id: 555, sport_type: "WeightTraining", start_date: "2026-09-26T07:08:00Z", elapsed_time: 3500 };

test("webhook -> Hevy fetch -> Strava rename + HR attached", async () => {
  const e = env();
  const f = apis({ activities: () => [watch, { id: 9, sport_type: "Run", start_date: "2026-09-26T07:00:00Z", elapsed_time: 60 }] });
  const rt = makeRuntime(e, { fetch: f, sleep: noSleep, now: () => NOW });
  const rec = await processWebhook(rt, raw.id);

  assert.equal(rec.status, "hr-attached");
  assert.deepEqual(rec.strava, { id: 555, name: raw.title, renamedAt: new Date(NOW).toISOString() });
  assert.deepEqual(rec.hr, { startTime: "2026-09-26T07:08:00.000Z", t: [0, 5], v: [92, 121] });
  assert.equal(rec.totals.tonnageWork, 12670);
  assert.equal(f.puts.length, 1);
  assert.equal(f.puts[0].name, raw.title);
  assert.equal(f.puts[0].description, buildDescription(raw));
  assert.equal(JSON.parse(await e.LIVE.get("strava:tokens")).refresh_token, "rotated");
  assert.equal(await e.LIVE.get(`p:${raw.id}`), null);
  const hevyCall = f.calls.find((c) => c.url.includes("hevyapp"));
  assert.equal(hevyCall.init.headers["api-key"], "test-hevy");

  const res = await handle(new Request("https://x/live/recent?days=14"), e, fakeCtx(), rt);
  const j = await res.json();
  assert.equal(j.workouts.length, 1);
  const w = j.workouts[0];
  assert.deepEqual(Object.keys(w), ["id", "title", "start", "end", "updatedAt", "exercises", "totals", "muscles", "strava", "hr", "status"]);
  assert.deepEqual(Object.keys(w.exercises[0]), ["title", "templateId", "notes", "equipment", "primary", "secondary", "sets"]);
});

test("identical description with our footer -> no PUT", async () => {
  const e = env();
  const f = apis({
    activities: () => [watch],
    activity: { name: raw.title, description: buildDescription(raw) },
  });
  const rt = makeRuntime(e, { fetch: f, sleep: noSleep, now: () => NOW });
  const rec = await processWebhook(rt, raw.id);
  assert.equal(f.puts.length, 0);
  assert.equal(rec.status, "hr-attached");
});

test("no Strava activity yet -> strava-pending, cron retries and completes", async () => {
  const e = env();
  let acts = [];
  const f = apis({ activities: () => acts, streams: false });
  let now = NOW;
  const rt = makeRuntime(e, { fetch: f, sleep: noSleep, now: () => now });
  const rec = await processWebhook(rt, raw.id);
  assert.equal(rec.status, "strava-pending");
  const p = JSON.parse(await e.LIVE.get(`p:${raw.id}`));
  assert.equal(p.stage, "strava");
  assert.ok(p.sync.description.endsWith("— synced from Hevy"));

  // too early: nextAt not reached -> still pending
  now = NOW + 60 * 1000;
  let r = await runCron(rt, now);
  assert.equal(r.pending, 1);

  acts = [watch];
  now = NOW + 11 * 60 * 1000;
  r = await runCron(rt, now);
  assert.equal(r.pending, 0);
  const stored = JSON.parse(await e.LIVE.get(`w:${raw.id}`));
  assert.equal(stored.status, "strava-renamed"); // streams 404 -> no HR
  assert.equal(f.puts.length, 1);
  const cron = JSON.parse(await e.LIVE.get("meta:cron"));
  assert.equal(cron.pending, 0);
});

test("pending older than 24 h is dropped and status falls back to received", async () => {
  const e = env();
  const f = apis({ activities: () => [] });
  let now = NOW;
  const rt = makeRuntime(e, { fetch: f, sleep: noSleep, now: () => now });
  await processWebhook(rt, raw.id);
  now = NOW + 25 * 3600 * 1000;
  const r = await runCron(rt, now);
  assert.equal(r.pending, 0);
  assert.equal(JSON.parse(await e.LIVE.get(`w:${raw.id}`)).status, "received");
});

test("Strava 429 -> throttled, stays pending, no further Strava calls", async () => {
  const e = env();
  const f = scriptedFetch([
    ["GET", /api\.hevyapp\.com\/v1\/workouts\//, () => jsonResponse(raw)],
    ["POST", /oauth\/token/, () => jsonResponse({ access_token: "a", refresh_token: "r", expires_at: NOW / 1000 + 21600 })],
    ["GET", /\/athlete\/activities/, () => jsonResponse({ message: "Rate Limit Exceeded" }, 429, {
      "X-RateLimit-Limit": "200,2000", "X-RateLimit-Usage": "201,500",
    })],
  ]);
  const rt = makeRuntime(e, { fetch: f, sleep: noSleep, now: () => NOW });
  const rec = await processWebhook(rt, raw.id);
  assert.equal(rec.status, "strava-pending");
  assert.ok(JSON.parse(await e.LIVE.get("strava:throttle")).until > NOW);
  const listCalls = f.calls.filter((c) => c.url.includes("/athlete/activities")).length;
  assert.equal(listCalls, 1, "429 is not hammered");
});

test("no Strava secrets -> stored as received + pending; Hevy 5xx -> pending stage hevy", async () => {
  const e = { LIVE: new MemoryKV(), HEVY_API_KEY: "k" };
  const f = scriptedFetch([["GET", /hevyapp/, () => jsonResponse(raw)]]);
  const rt = makeRuntime(e, { fetch: f, sleep: noSleep, now: () => NOW });
  const rec = await processWebhook(rt, raw.id);
  assert.equal(rec.status, "received");
  assert.equal(JSON.parse(await e.LIVE.get(`p:${raw.id}`)).stage, "strava");

  const e2 = { LIVE: new MemoryKV(), HEVY_API_KEY: "k" };
  const f2 = scriptedFetch([["GET", /hevyapp/, () => jsonResponse({}, 503)]]);
  const rt2 = makeRuntime(e2, { fetch: f2, sleep: noSleep, now: () => NOW });
  assert.equal(await processWebhook(rt2, raw.id), null);
  assert.equal(f2.calls.length, 4, "4 attempts with backoff");
  assert.equal(JSON.parse(await e2.LIVE.get(`p:${raw.id}`)).stage, "hevy");
});

test("hourly events poll ingests updates and removes deleted workouts", async () => {
  const e = { LIVE: new MemoryKV(), HEVY_API_KEY: "k" };
  await e.LIVE.put("w:gone", JSON.stringify({ id: "gone", start: raw.start_time }), { metadata: { start: raw.start_time } });
  await e.LIVE.put("index", JSON.stringify([{ id: "gone", start: raw.start_time, end: raw.end_time }]));
  const f = scriptedFetch([["GET", /workouts\/events/, (u) => {
    assert.equal(u.searchParams.get("pageSize"), "10");
    assert.match(u.searchParams.get("since"), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    return jsonResponse({ page: 1, page_count: 1, events: [
      { type: "updated", workout: raw }, { type: "deleted", id: "gone", deleted_at: "2026-09-26T08:00:00Z" }] });
  }]]);
  const now = Date.parse("2026-09-26T09:10:00Z");
  const rt = makeRuntime(e, { fetch: f, sleep: noSleep, now: () => now });
  const r = await runCron(rt, now);
  assert.deepEqual(r.events, { ingested: 1, deleted: 1 });
  assert.equal(await e.LIVE.get("w:gone"), null);
  assert.ok(await e.LIVE.get(`w:${raw.id}`));
  assert.deepEqual(JSON.parse(await e.LIVE.get("index")).map((x) => x.id), [raw.id]);

  // :00 slot is skipped (Hevy asks not to poll at xx:00)
  const e3 = { LIVE: new MemoryKV(), HEVY_API_KEY: "k" };
  const f3 = scriptedFetch([]);
  const t0 = Date.parse("2026-09-26T10:00:00Z");
  await runCron(makeRuntime(e3, { fetch: f3, sleep: noSleep, now: () => t0 }), t0);
  assert.equal(f3.calls.length, 0);
});
