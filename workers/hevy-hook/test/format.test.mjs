import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDescription, buildName, fmtExercise, fmtSet, workoutTotals, FOOTER, DASH, DOT, MUL, GE,
} from "../src/format.js";
import { pyFixed, pyRound, pyThousands0 } from "../src/pyfmt.js";

// Same sample as `python tools/strava_sync.py selftest`
const sample = {
  title: "Legs A",
  exercises: [{
    title: "Front Squat",
    sets: [
      { type: "warmup", weight_kg: 60, reps: 6, rpe: 6 },
      { type: "normal", weight_kg: 80, reps: 10, rpe: 7.5 },
      { type: "normal", weight_kg: 80, reps: 10, rpe: 8 },
      { type: "normal", weight_kg: 80, reps: 10, rpe: 9 },
    ],
  }],
};

test("exercise line matches the Python selftest", () => {
  assert.equal(fmtExercise(sample.exercises[0]), "Front Squat — 60×6 (wu) · 80×10 @7.5 · 80×10 @8 · 80×10 @9");
  assert.equal(fmtExercise(sample.exercises[0]),
    `Front Squat ${DASH} 60${MUL}6 (wu)${DOT}80${MUL}10 @7.5${DOT}80${MUL}10 @8${DOT}80${MUL}10 @9`);
});

test("work tonnage 2,400 / 3 sets / 3 hard; full description", () => {
  const [ton, n, hard] = workoutTotals(sample);
  assert.equal(pyThousands0(ton), "2,400");
  assert.equal(n, 3);
  assert.equal(hard, 3);
  const desc = buildDescription(sample);
  assert.ok(desc.includes(`Work tonnage 2,400 kg · 3 sets · hard sets (RPE${GE}7) 3`));
  assert.ok(desc.endsWith(FOOTER));
  assert.equal(desc,
    "Front Squat — 60×6 (wu) · 80×10 @7.5 · 80×10 @8 · 80×10 @9\n\n"
    + "Work tonnage 2,400 kg · 3 sets · hard sets (RPE≥7) 3\n\n"
    + "— synced from Hevy");
  assert.equal(buildName(sample), "Legs A");
  assert.equal(buildName({}), "Weight Training");
});

test("set markers, bodyweight, duration, distance", () => {
  assert.equal(fmtSet({ type: "failure", weight_kg: 62.5, reps: 8, rpe: 10 }), "62.5×8 @10 (f)");
  assert.equal(fmtSet({ type: "dropset", weight_kg: 40, reps: 12 }), "40×12 (d)");
  assert.equal(fmtSet({ type: "normal", reps: 12 }), "BW×12");
  assert.equal(fmtSet({ type: "normal", weight_kg: 0, reps: 12, rpe: 7 }), "BW×12 @7");
  assert.equal(fmtSet({ type: "normal", duration_seconds: 60, reps: null }), "60s");
  assert.equal(fmtSet({ type: "normal", weight_kg: 20, duration_seconds: 45 }), "20kg×45s");
  assert.equal(fmtSet({ type: "normal", distance_meters: 400 }), "400m");
  assert.equal(fmtSet({ type: "normal" }), "?");
  assert.equal(fmtSet({ weight_kg: 22.6796, reps: 10, rpe: 7.25 }), "22.68×10 @7.25");
});

test("notes block: workout description then exercise notes", () => {
  const w = {
    title: "X",
    description: " hello ",
    exercises: [{ title: "A", notes: "n1", sets: [] }, { title: "B", notes: "  ", sets: [{ reps: 5 }] }],
  };
  assert.equal(buildDescription(w),
    "A\nB — BW×5\n\nWork tonnage 0 kg · 1 sets · hard sets (RPE≥7) 0\n\nNotes:\nhello\nA: n1\n\n— synced from Hevy");
});

test("Python-compatible rounding (half-even on the exact binary value)", () => {
  assert.equal(pyFixed(0.125, 2), "0.12"); // exact tie -> even
  assert.equal(pyFixed(0.375, 2), "0.38");
  assert.equal(pyFixed(2.675, 2), "2.67"); // binary value is below the tie
  assert.equal(pyFixed(2.5, 0), "2");
  assert.equal(pyFixed(3.5, 0), "4");
  assert.equal(pyRound(0.25, 1), 0.2);
  assert.equal(pyRound(0.35, 1), 0.3); // 0.35 is 0.34999... in binary
  assert.equal(pyRound(null, 1), null);
  assert.equal(pyThousands0(1234567.5), "1,234,568");
  assert.equal(pyThousands0(12670), "12,670");
});
