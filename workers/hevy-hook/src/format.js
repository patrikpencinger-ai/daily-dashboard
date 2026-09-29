// Strava name/description builder — 1:1 port of tools/strava_sync.py
// (fmt_num, fmt_set, fmt_exercise, workout_totals, build_description, build_name).
// Input is a raw Hevy API workout (weight_kg, reps, rpe, type, duration_seconds,
// distance_meters; exercise notes; workout description).

import { pyFixed, pyThousands0 } from "./pyfmt.js";

export const FOOTER = "— synced from Hevy";
export const MUL = "×";
export const DASH = "—";
export const DOT = " · ";
export const GE = "≥";

const isNone = (v) => v === null || v === undefined;
const pyStr = (v) => (typeof v === "string" ? v : "");
const lower = (t) => (t || "normal").toLowerCase();

/** 80.0 -> '80', 62.5 -> '62.5', 7.25 -> '7.25'. */
export function fmtNum(x) {
  const f = Number(x);
  if (Number.isInteger(f)) return String(f);
  return pyFixed(f, 2).replace(/0+$/, "").replace(/\.$/, "");
}

/** One set -> 'kg×reps @RPE (marker)'. RPE omitted on warm-ups. */
export function fmtSet(s) {
  const stype = lower(s.type);
  const w = s.weight_kg;
  const reps = s.reps;
  const dur = s.duration_seconds;
  const dist = s.distance_meters;
  const hasW = !isNone(w) && Number(w) > 0;

  let core;
  if (!isNone(reps)) {
    core = hasW ? `${fmtNum(w)}${MUL}${reps}` : `BW${MUL}${reps}`;
  } else if (dur) {
    core = hasW ? `${fmtNum(w)}kg${MUL}${fmtNum(dur)}s` : `${fmtNum(dur)}s`;
  } else if (dist) {
    core = `${fmtNum(dist)}m`;
  } else {
    core = "?";
  }

  const rpe = s.rpe;
  if (!isNone(rpe) && stype !== "warmup") core += ` @${fmtNum(rpe)}`;
  if (stype === "warmup") core += " (wu)";
  else if (stype === "failure") core += " (f)";
  else if (stype === "dropset") core += " (d)";
  return core;
}

export function fmtExercise(ex) {
  const title = (pyStr(ex.title) || "Exercise").trim();
  const sets = ex.sets || [];
  if (!sets.length) return title;
  return `${title} ${DASH} ` + sets.map(fmtSet).join(DOT);
}

/** [work tonnage kg, work set count, hard sets RPE>=7]. Warm-ups excluded. */
export function workoutTotals(workout) {
  let tonnage = 0;
  let nSets = 0;
  let hard = 0;
  for (const ex of workout.exercises || []) {
    for (const s of ex.sets || []) {
      if (lower(s.type) === "warmup") continue;
      nSets += 1;
      if (!isNone(s.weight_kg) && !isNone(s.reps)) tonnage += Number(s.weight_kg) * Number(s.reps);
      if (!isNone(s.rpe) && Number(s.rpe) >= 7) hard += 1;
    }
  }
  return [tonnage, nSets, hard];
}

export function buildDescription(workout) {
  const exs = workout.exercises || [];
  const lines = exs.map(fmtExercise);
  const [tonnage, nSets, hard] = workoutTotals(workout);
  const parts = lines.length ? [lines.join("\n")] : [];
  parts.push(`Work tonnage ${pyThousands0(tonnage)} kg · ${nSets} sets · hard sets (RPE${GE}7) ${hard}`);

  const notes = [];
  const wdesc = pyStr(workout.description).trim();
  if (wdesc) notes.push(wdesc);
  for (const ex of exs) {
    const n = pyStr(ex.notes).trim();
    if (n) notes.push(`${(pyStr(ex.title) || "Exercise").trim()}: ${n}`);
  }
  if (notes.length) parts.push("Notes:\n" + notes.join("\n"));

  parts.push(FOOTER);
  return parts.join("\n\n");
}

export function buildName(workout) {
  return (pyStr(workout.title) || "Weight Training").trim();
}
