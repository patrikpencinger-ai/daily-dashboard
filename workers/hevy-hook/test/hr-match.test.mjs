import { test } from "node:test";
import assert from "node:assert/strict";
import { activityFor, downsampleHr, matchActivities } from "../src/match.js";

test("downsample: 5 s bins, mean rounded, bin start times", () => {
  const streams = {
    time: { data: [0, 1, 2, 3, 4, 5, 6, 12, 13] },
    heartrate: { data: [100, 101, 102, 103, 104, 110, 111, 120, 121] },
  };
  const hr = downsampleHr(streams, "2026-09-26T07:08:00Z");
  assert.deepEqual(hr, { startTime: "2026-09-26T07:08:00.000Z", t: [0, 5, 10], v: [102, 111, 121] });
});

test("downsample: 1 h of 1 Hz -> 720 points", () => {
  const t = Array.from({ length: 3600 }, (_, i) => i);
  const hr = downsampleHr({ time: { data: t }, heartrate: { data: t.map(() => 120) } }, "2026-09-26T07:08:00Z");
  assert.equal(hr.t.length, 720);
  assert.equal(hr.t[719], 3595);
  assert.ok(hr.v.every((v) => v === 120));
});

test("downsample: missing / mismatched streams -> null", () => {
  assert.equal(downsampleHr(null, "2026-09-26T07:08:00Z"), null);
  assert.equal(downsampleHr({ time: { data: [0, 1] } }, "2026-09-26T07:08:00Z"), null);
  assert.equal(downsampleHr({ time: { data: [0, 1] }, heartrate: { data: [100] } }, "2026-09-26T07:08:00Z"), null);
});

test("matching: python selftest case (±30 min) still holds", () => {
  const acts = [
    { id: 1, start_date: "2026-09-29T10:05:00Z", elapsed_time: 3600 },
    { id: 2, start_date: "2026-09-29T14:00:00Z", elapsed_time: 3600 },
  ];
  const wks = [{ id: "h1", start_time: "2026-09-29T12:00:00+02:00", end_time: "2026-09-29T13:00:00+02:00" }];
  const m = matchActivities(acts, wks, 30 * 60 * 1000);
  assert.ok(m[0][1] !== null);
  assert.equal(m[1][1], null);
});

test("matching: ±90 min window, closest start wins, 1:1", () => {
  // Hevy 07:28-08:02 (from the 2026-09-26 workout); watch activity starts ~20 min earlier
  const w = { id: "h", start_time: "2026-09-26T07:28:57+00:00", end_time: "2026-09-26T08:02:46+00:00" };
  const watch = { id: 10, start_date: "2026-09-26T07:08:00Z", elapsed_time: 3300 };
  const late = { id: 11, start_date: "2026-09-26T09:25:00Z", elapsed_time: 600 }; // within +90 min of end
  const far = { id: 12, start_date: "2026-09-26T09:40:00Z", elapsed_time: 600 };  // beyond +90 min
  assert.equal(activityFor("h", [late, watch, far], [w]).id, 10);
  assert.equal(activityFor("h", [late], [w]).id, 11);
  assert.equal(activityFor("h", [far], [w]), null);
  // a second workout closer to the late activity claims it
  const w2 = { id: "h2", start_time: "2026-09-26T09:20:00Z", end_time: "2026-09-26T09:50:00Z" };
  assert.equal(activityFor("h", [late], [w, w2]), null);
});
