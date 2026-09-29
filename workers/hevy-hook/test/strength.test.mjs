import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import templates from "../templates.json" with { type: "json" };
import { computeStrength, isFailure, isHard, orderedSets, tonnage } from "../src/strength.js";

// Copy of <cache>/strength/raw/hevy/2026-09-26_744c0280-bf24-4ad4-9562-69a0cedaae7d.json
const raw = JSON.parse(readFileSync(new URL("./fixtures/hevy-2026-09-26.json", import.meta.url), "utf8"));

// strength-data.json (tools/build_strength.py, baseline 184fa1a) for that workout
const EXPECTED_TOTALS = {
  tonnageAll: 13030.0, tonnageWork: 12670.0, sets: 19, workSets: 18,
  hardSets: 15, failureSets: 4, avgRPE: 8.06,
};
const EXPECTED_MUSCLES = {
  biceps: { hardSets: 4.5, tonnageWork: 2110.0 }, calves: { hardSets: 1.5, tonnageWork: 1260.0 },
  chest: { hardSets: 1.0, tonnageWork: 2796.0 }, forearms: { hardSets: 1.5, tonnageWork: 1260.0 },
  glutes: { hardSets: 1.5, tonnageWork: 1200.0 }, hamstrings: { hardSets: 4.5, tonnageWork: 3720.0 },
  lats: { hardSets: 3.0, tonnageWork: 2520.0 }, quadriceps: { hardSets: 3.0, tonnageWork: 2400.0 },
  shoulders: { hardSets: 2.5, tonnageWork: 2982.0 }, triceps: { hardSets: 1.5, tonnageWork: 2190.0 },
  upper_back: { hardSets: 1.5, tonnageWork: 1260.0 },
};

test("2026-09-26 totals equal strength-data.json", () => {
  const { totals } = computeStrength(raw, templates);
  assert.deepEqual(totals, EXPECTED_TOTALS);
});

test("2026-09-26 muscles equal strength-data.json (keys sorted)", () => {
  const { muscles } = computeStrength(raw, templates);
  assert.deepEqual(muscles, EXPECTED_MUSCLES);
  assert.deepEqual(Object.keys(muscles), Object.keys(EXPECTED_MUSCLES).sort());
});

test("2026-09-26 exercises carry template muscles / equipment", () => {
  const { exercises } = computeStrength(raw, templates);
  assert.deepEqual(exercises.map((e) => [e.title, e.primary, e.secondary, e.equipment]), [
    ["Front Squat", "quadriceps", ["hamstrings", "glutes"], "barbell"],
    ["Seated Leg Curl (Machine)", "hamstrings", ["calves"], "machine"],
    ["Chest Press (Machine)", "chest", ["shoulders", "triceps"], "machine"],
    ["Lat Pulldown (Cable)", "lats", ["upper_back", "biceps", "forearms"], "machine"],
    ["Seated Shoulder Press (Machine)", "shoulders", ["triceps"], "machine"],
    ["Preacher Curl (Machine)", "biceps", [], "machine"],
  ]);
  assert.deepEqual(exercises[0].sets[0], { type: "warmup", kg: 60, reps: 6, rpe: 6 });
  assert.equal(exercises[1].notes, "Sjedeci xxl");
  assert.equal(exercises[0].templateId, "5046D0A9");
});

test("unknown template -> muscle 'other', equipment null", () => {
  const w = {
    exercises: [{
      index: 0, title: "Mystery", exercise_template_id: "NOPE",
      sets: [{ index: 0, type: "normal", weight_kg: 10, reps: 10, rpe: 8 }],
    }],
  };
  const r = computeStrength(w, templates);
  assert.deepEqual(r.muscles, { other: { hardSets: 1, tonnageWork: 100 } });
  assert.equal(r.exercises[0].equipment, null);
});

test("set semantics match build_strength.py", () => {
  assert.equal(isHard("warmup", 9), false);
  assert.equal(isHard("failure", null), true);
  assert.equal(isHard("normal", null), null);
  assert.equal(isHard("normal", 7), true);
  assert.equal(isFailure("normal", 9.5), true);
  assert.equal(isFailure("failure", null), true);
  assert.equal(tonnage(null, 10), 0);
  assert.equal(tonnage(0, 10), 0);
  assert.equal(tonnage(22.5, 10), 225);
});

test("supersets interleave round-robin", () => {
  const w = {
    exercises: [
      { index: 0, superset_id: 1, sets: [{ index: 0, n: "a0" }, { index: 1, n: "a1" }] },
      { index: 1, superset_id: 1, sets: [{ index: 0, n: "b0" }] },
      { index: 2, superset_id: null, sets: [{ index: 0, n: "c0" }] },
    ],
  };
  assert.deepEqual(orderedSets(w).map((o) => o.set.n), ["a0", "b0", "a1", "c0"]);
});
