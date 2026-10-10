// Compact coach context built from the live KV workouts (contract: .foreman/api-contract.md).
// Only precomputed numbers go to the model, never raw series. Target <= ~3K tokens (chars / 4).
//
// {asOf, focusWorkoutId, sessions[<=5], weekly[4], acwr, muscles7d, topSets[], lifts20d[],
//  hrMatch|null, sleep|null, readiness|null}
//
// Coverage: KV keeps workouts for WORKOUT_TTL_S (20 d), so a 7-day window that starts before
// that has tonnageWork null, and ACWR (needs 28 d) is "n/a" until a longer source is wired in
// through `extras.weekly` / `extras.acwr`. Sleep / readiness are hooks (`extras.sleep`,
// `extras.readiness`); the Worker has no sleep data in KV yet.

import { getIndex, getWorkout, WORKOUT_TTL_S } from "./store.js";
import { zgDate } from "./usage.js";

const DAY_MS = 86400 * 1000;
export const CONTEXT_MAX_TOKENS = 3000;
export const approxTokens = (s) => Math.ceil(String(s).length / 4);

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

/** Heaviest work set of an exercise (kg, then reps); rep-only exercises -> most reps. */
export function topSet(ex) {
  const work = (ex.sets || []).filter((s) => s && s.type !== "warmup" && num(s.reps) !== null);
  if (!work.length) return null;
  const loaded = work.filter((s) => num(s.kg) !== null && Number(s.kg) > 0);
  const pool = loaded.length ? loaded : work;
  let best = pool[0];
  for (const s of pool) {
    const kb = num(best.kg) || 0;
    const ks = num(s.kg) || 0;
    if (ks > kb || (ks === kb && Number(s.reps) > Number(best.reps))) best = s;
  }
  return { kg: num(best.kg), reps: Number(best.reps), rpe: num(best.rpe) };
}

function sessionOf(rec) {
  const t = rec.totals || {};
  const durMin = Math.round((Date.parse(rec.end) - Date.parse(rec.start)) / 60000);
  const top = [];
  for (const ex of rec.exercises || []) {
    const ts = topSet(ex);
    if (ts) top.push({ ex: ex.title, ...ts });
  }
  return {
    id: rec.id,
    date: zgDate(Date.parse(rec.start)),
    title: rec.title || "",
    durMin: Number.isFinite(durMin) && durMin > 0 ? durMin : null,
    tonnageWork: num(t.tonnageWork),
    hardSets: num(t.hardSets),
    failureSets: num(t.failureSets),
    avgRPE: num(t.avgRPE),
    top,
  };
}

function hrMatchOf(rec) {
  const m = rec.hrMatch;
  if (!m || typeof m !== "object") return null;
  const out = {
    workoutId: rec.id,
    date: zgDate(Date.parse(rec.start)),
    expected: num(m.expected),
    matched: num(m.matched),
    confSetsPct: num(m.confSetsPct),
    anchor: m.anchor ? {
      exercise: m.anchor.exercise || null,
      tPeaks: (m.anchor.tPeaks || []).slice(0, 6),
      peakHR: (m.anchor.peakHR || []).slice(0, 6),
    } : null,
  };
  const peaks = (m.sets || []).map((s) => num(s.peakHR)).filter((v) => v !== null);
  if (peaks.length) out.maxSetPeakHR = Math.max(...peaks);
  if (rec.hr && Array.isArray(rec.hr.v) && rec.hr.v.length) {
    let s = 0;
    for (const v of rec.hr.v) s += v;
    out.sessionHR = { avg: Math.round(s / rec.hr.v.length), max: Math.max(...rec.hr.v) };
  }
  return out;
}

/** Rolling 7-day windows ending now: [{from, to, tonnageWork|null, sessions|null}], newest first. */
function weeklyOf(recs, now) {
  const coverStart = now - WORKOUT_TTL_S * 1000;
  const out = [];
  for (let i = 0; i < 4; i++) {
    const hi = now - i * 7 * DAY_MS;
    const lo = hi - 7 * DAY_MS;
    const covered = lo >= coverStart;
    let ton = 0;
    let n = 0;
    for (const r of recs) {
      const t = Date.parse(r.start);
      if (t > lo && t <= hi) {
        ton += Number((r.totals && r.totals.tonnageWork) || 0);
        n += 1;
      }
    }
    out.push({
      from: zgDate(lo + 1), to: zgDate(hi),
      tonnageWork: covered ? Math.round(ton) : null,
      sessions: covered ? n : null,
    });
  }
  return out;
}

/** ACWR = acute (last 7 d) / (last 28 d / 4); "n/a" unless all four windows are covered. */
export function acwrOf(weekly) {
  if (weekly.length < 4 || weekly.some((w) => w.tonnageWork === null)) return { acwr: "n/a", acute: weekly[0] ? weekly[0].tonnageWork : null, chronicWeekly: null };
  const acute = weekly[0].tonnageWork;
  const chronic = weekly.reduce((s, w) => s + w.tonnageWork, 0) / 4;
  return { acwr: chronic > 0 ? r2(acute / chronic) : "n/a", acute, chronicWeekly: Math.round(chronic) };
}

function muscles7d(recs, now) {
  const acc = {};
  for (const r of recs) {
    if (Date.parse(r.start) <= now - 7 * DAY_MS) continue;
    for (const [g, v] of Object.entries(r.muscles || {})) acc[g] = (acc[g] || 0) + Number((v && v.hardSets) || 0);
  }
  return Object.fromEntries(Object.entries(acc).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([g, v]) => [g, r1(v)]));
}

/** Per lift: latest top set vs the previous session's top set, with the % load change. */
function topSetChanges(sessions) {
  const by = new Map(); // ex -> [{date, kg, reps}] newest first
  for (const s of sessions) {
    for (const t of s.top) {
      if (!by.has(t.ex)) by.set(t.ex, []);
      by.get(t.ex).push({ date: s.date, kg: t.kg, reps: t.reps });
    }
  }
  const out = [];
  for (const [ex, list] of by) {
    const last = list[0];
    const prev = list[1] || null;
    const jumpPct = prev && last.kg && prev.kg ? r1(((last.kg - prev.kg) / prev.kg) * 100) : null;
    out.push({ ex, last, prev, jumpPct });
  }
  return out.slice(0, 14);
}

/**
 * @param kv      LIVE namespace
 * @param now     epoch ms
 * @param opts    {focusId?, extras?: {weekly?, acwr?, sleep?, readiness?}}
 * @returns {ctx, json, tokens}
 */
export async function buildContext(kv, now, { focusId = null, extras = {} } = {}) {
  const idx = await getIndex(kv);
  const recs = (await Promise.all(idx.map((e) => getWorkout(kv, e.id)))).filter(Boolean);
  recs.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));

  const allSessions = recs.map(sessionOf);
  let sessions = allSessions.slice(0, 5);
  if (focusId && !sessions.some((s) => s.id === focusId)) {
    const f = allSessions.find((s) => s.id === focusId);
    if (f) sessions = [f, ...sessions.slice(0, 4)];
  }
  const weekly = Array.isArray(extras.weekly) ? extras.weekly : weeklyOf(recs, now);
  const load = extras.acwr ? extras.acwr : acwrOf(weekly);
  const newestHr = recs.find((r) => r.hrMatch) || null;

  const ctx = {
    asOf: zgDate(now),
    focusWorkoutId: focusId,
    sessions,
    weekly,
    acwr: load.acwr,
    acuteTonnage: load.acute,
    chronicWeeklyTonnage: load.chronicWeekly,
    muscles7d: muscles7d(recs, now),
    topSets: topSetChanges(allSessions),
    lifts20d: [...new Set(allSessions.flatMap((s) => s.top.map((t) => t.ex)))],
    hrMatch: newestHr ? hrMatchOf(newestHr) : null,
    sleep: extras.sleep || null,
    readiness: extras.readiness || null,
  };

  // keep within budget: drop per-exercise top sets from the oldest sessions first, then sessions
  let json = JSON.stringify(ctx);
  for (let i = ctx.sessions.length - 1; i >= 1 && approxTokens(json) > CONTEXT_MAX_TOKENS; i--) {
    ctx.sessions[i] = { ...ctx.sessions[i], top: [] };
    json = JSON.stringify(ctx);
  }
  while (ctx.sessions.length > 1 && approxTokens(json) > CONTEXT_MAX_TOKENS) {
    ctx.sessions.pop();
    json = JSON.stringify(ctx);
  }
  if (approxTokens(json) > CONTEXT_MAX_TOKENS) {
    ctx.topSets = ctx.topSets.slice(0, 6);
    json = JSON.stringify(ctx);
  }
  return { ctx, json, tokens: approxTokens(json) };
}
