// Totals / muscles for one Hevy workout — 1:1 port of the relevant parts of
// tools/build_strength.py (tonnage, is_hard, is_failure, ordered_sets, and the
// per-workout block of build()).  The HR-peak <-> set matching is NOT ported:
// the morning pipeline stays the source of truth for strength-data.json.

import { r1, r2 } from "./pyfmt.js";

const isNone = (v) => v === null || v === undefined;
const truthy = (v) => !(v === null || v === undefined || v === 0 || v === "" || v === false || Number.isNaN(v));

export function tonnage(kg, reps) {
  if (!truthy(kg) || !truthy(reps)) return 0.0;
  return Number(kg) * Number(reps);
}

/** true / false / null (null = unknown: work set without RPE that is not "failure"). */
export function isHard(setType, rpe) {
  if (setType === "warmup") return false;
  if (isNone(rpe)) return setType === "failure" ? true : null;
  return rpe >= 7;
}

export function isFailure(setType, rpe) {
  return setType === "failure" || (!isNone(rpe) && rpe >= 9.5);
}

const idx = (o, dflt = 0) => (isNone(o.index) ? dflt : o.index);

/** Chronological set list (exercise order x set order; exercises sharing a
 *  superset_id are interleaved round-robin in listed order). */
export function orderedSets(workout) {
  const exs = [...(workout.exercises || [])].sort((a, b) => idx(a) - idx(b));
  const groups = [];
  for (const ex of exs) {
    const sid = isNone(ex.superset_id) ? null : ex.superset_id;
    if (sid !== null && groups.length && groups[groups.length - 1][0] === sid) {
      groups[groups.length - 1][1].push(ex);
    } else {
      groups.push([sid, [ex]]);
    }
  }
  const out = [];
  for (const [, members] of groups) {
    const seqs = members.map((m) => [...(m.sets || [])].sort((a, b) => idx(a) - idx(b)));
    let k = 0;
    while (seqs.some((s) => k < s.length)) {
      members.forEach((m, mi) => {
        const s = seqs[mi];
        if (k < s.length) out.push({ ex: m, exIdx: idx(m), set: s[k] });
      });
      k += 1;
    }
  }
  return out;
}

/**
 * @param workout raw Hevy API workout
 * @param templates {id: [primary, [secondary...], equipment]} (compact templates.json shape)
 * @returns {exercises, totals, muscles}
 */
export function computeStrength(workout, templates) {
  const sets = orderedSets(workout);
  const setRows = sets.map((o) => {
    const s = o.set;
    const typ = s.type || "normal";
    const kg = isNone(s.weight_kg) ? null : s.weight_kg;
    const reps = isNone(s.reps) ? null : s.reps;
    const rpe = isNone(s.rpe) ? null : s.rpe;
    return {
      ex: o.exIdx, type: typ, kg, reps, rpe,
      tonnage: r1(tonnage(kg, reps)),
      hard: isHard(typ, rpe), failure: isFailure(typ, rpe),
    };
  });

  const work = setRows.filter((r) => r.type !== "warmup");
  const rpes = work.filter((r) => r.rpe !== null).map((r) => r.rpe);
  let avgRpe = null;
  if (rpes.length) {
    let sum = 0;
    for (const v of rpes) sum += v;
    avgRpe = sum / rpes.length;
  }

  const musc = new Map();
  const add = (m, wt, hs, ton) => {
    if (!musc.has(m)) musc.set(m, { hardSets: 0.0, tonnageWork: 0.0 });
    const v = musc.get(m);
    v.hardSets += wt * hs;
    v.tonnageWork += wt * ton;
  };

  const exercises = [];
  const exSorted = [...(workout.exercises || [])].sort((a, b) => idx(a) - idx(b));
  for (const ex of exSorted) {
    const t = templates[ex.exercise_template_id] || null;
    const prim = (t && t[0]) || "other";
    const sec = (t && t[1]) || [];
    const exr = setRows.filter((r) => r.ex === ex.index);
    const exw = exr.filter((r) => r.type !== "warmup");
    const hs = exw.filter((r) => r.hard).length;
    let ton = 0;
    for (const r of exw) ton += r.tonnage;
    add(prim, 1.0, hs, ton);
    for (const m of sec) add(m, 0.5, hs, ton);

    const exSets = [...(ex.sets || [])].sort((a, b) => idx(a) - idx(b));
    exercises.push({
      title: ex.title,
      templateId: ex.exercise_template_id ?? null,
      notes: ex.notes || "",
      equipment: t ? (t[2] ?? null) : null,
      primary: prim,
      secondary: sec,
      sets: exSets.map((s) => ({
        type: s.type || "normal",
        kg: isNone(s.weight_kg) ? null : s.weight_kg,
        reps: isNone(s.reps) ? null : s.reps,
        rpe: isNone(s.rpe) ? null : s.rpe,
      })),
    });
  }

  let tonAll = 0;
  for (const r of setRows) tonAll += r.tonnage;
  let tonWork = 0;
  for (const r of work) tonWork += r.tonnage;

  const totals = {
    tonnageAll: r1(tonAll),
    tonnageWork: r1(tonWork),
    sets: setRows.length,
    workSets: work.length,
    hardSets: work.filter((r) => r.hard).length,
    failureSets: work.filter((r) => r.failure).length,
    avgRPE: r2(avgRpe),
  };

  const muscles = {};
  for (const m of [...musc.keys()].sort()) {
    const v = musc.get(m);
    muscles[m] = { hardSets: r1(v.hardSets), tonnageWork: r1(v.tonnageWork) };
  }
  return { exercises, totals, muscles };
}

/** Template ids a workout uses that the given map does not know. */
export function unknownTemplateIds(workout, templates) {
  const out = new Set();
  for (const ex of workout.exercises || []) {
    const id = ex.exercise_template_id;
    if (id && !templates[id]) out.add(id);
  }
  return [...out];
}

/** Hevy /v1/exercise_templates/{id} response -> compact [primary, [secondary], equipment]. */
export function compactTemplate(t) {
  return [t.primary_muscle_group || null, t.secondary_muscle_groups || [], t.equipment ?? null];
}
