// Compact coach context (contract: .foreman/api-contract.md).
// Only precomputed numbers go to the model, never raw series. Target <= ~3K tokens (chars / 4).
//
// {asOf, focusWorkoutId, sessions[<=5], weeklySource, weeklyAsOf, weekly[4], muscleWeekly[4]|null,
//  acwr, acwrSRPE, acuteTonnage, chronicWeeklyTonnage, muscles7d, topSets[], lifts20d[],
//  hrMatch|null, sleep|null, readiness|null}
//
// Weekly load comes from the dashboard's own https://dash.er45.com/strength-data.json
// (`weekly[]` + `muscleWeekly[]`: calendar weeks from Monday, written by tools/build_strength.py),
// compacted to the last 4 weeks and cached in KV `cache:strength-weekly` for 10 min. Only when
// that fetch fails does the context fall back to rolling 7-day windows from the live KV log,
// which keeps workouts for WORKOUT_TTL_S (20 d) only, so ACWR (needs 28 d) is "n/a" there.
// Sessions, top sets, muscles7d and hrMatch always come from KV: they include a workout logged
// minutes ago, which strength-data.json only picks up on the next pipeline run.
// Sleep / readiness are hooks (`extras.sleep`, `extras.readiness`); the Worker has no sleep data.

import { getIndex, getWorkout, WORKOUT_TTL_S } from "./store.js";
import { zgDate } from "./usage.js";

const DAY_MS = 86400 * 1000;
export const CONTEXT_MAX_TOKENS = 3000;
export const STRENGTH_URL = "https://dash.er45.com/strength-data.json";
export const STRENGTH_CACHE_KEY = "cache:strength-weekly";
export const STRENGTH_CACHE_TTL_S = 600;
export const STRENGTH_FETCH_TIMEOUT_MS = 8000;
const WEEKS = 4;
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

// ---- weekly load from strength-data.json ------------------------------------------------

const rnd = (v) => (num(v) === null ? null : Math.round(Number(v)));

/** {refreshedAt, weekly, muscleWeekly} from the strength-data.json text. The file is ~1 MB and
 *  the two arrays are its last keys, so only that tail is parsed (far less CPU than the whole
 *  document); if the layout changes, one full JSON.parse is the fallback. */
export function extractWeekly(text) {
  const m = /"refreshedAt"\s*:\s*"([^"]{1,40})"/.exec(text.slice(0, 4000));
  const refreshedAt = m ? m[1] : null;
  const i = text.lastIndexOf('"weekly"');
  if (i > 0) {
    try {
      const tail = JSON.parse(`{${text.slice(i)}`);
      if (Array.isArray(tail.weekly)) return { refreshedAt, weekly: tail.weekly, muscleWeekly: tail.muscleWeekly };
    } catch { /* not the last keys: full parse below */ }
  }
  const d = JSON.parse(text);
  return {
    refreshedAt: (d && d.meta && d.meta.refreshedAt) || refreshedAt,
    weekly: d && d.weekly,
    muscleWeekly: d && d.muscleWeekly,
  };
}

/** Last WEEKS calendar weeks, newest first, only the fields the coach needs. */
export function compactWeekly(src) {
  const weekly = (Array.isArray(src.weekly) ? src.weekly : []).filter((w) => w && typeof w.week === "string")
    .slice(-WEEKS).reverse().map((w) => ({
      week: w.week,
      sessions: num(w.sessions),
      tonnageWork: rnd(w.tonnageWork),
      hardSets: num(w.hardSets),
      failureSets: num(w.failureSets),
      sRPE: rnd(w.sRPE),
      hrLoad: rnd(w.hrLoad),
      acwrTonnage: num(w.acwrTonnage) === null ? null : r2(Number(w.acwrTonnage)),
      acwrSRPE: num(w.acwrSRPE) === null ? null : r2(Number(w.acwrSRPE)),
    }));
  const weeks = new Set(weekly.map((w) => w.week));
  const muscleWeekly = (Array.isArray(src.muscleWeekly) ? src.muscleWeekly : [])
    .filter((w) => w && weeks.has(w.week) && w.m && typeof w.m === "object")
    .reverse().map((w) => ({
      week: w.week,
      hardSets: Object.fromEntries(Object.entries(w.m)
        .map(([g, v]) => [g, r1(Number((v && v.hardSets) || 0))])
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])),
    }));
  return { refreshedAt: src.refreshedAt || null, weekly, muscleWeekly };
}

/**
 * Compact weekly load from strength-data.json: KV cache (10 min) -> fetch -> null on any failure.
 * @returns {fetchedAt, refreshedAt, weekly[], muscleWeekly[]} | null
 */
export async function loadStrengthWeekly(kv, fetchImpl, now) {
  try {
    const c = await kv.get(STRENGTH_CACHE_KEY, "json");
    if (c && Array.isArray(c.weekly) && c.weekly.length && now - Date.parse(c.fetchedAt) < STRENGTH_CACHE_TTL_S * 1000) return c;
  } catch { /* cache miss */ }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), STRENGTH_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(STRENGTH_URL, { headers: { Accept: "application/json" }, signal: ac.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const out = { fetchedAt: new Date(now).toISOString(), ...compactWeekly(extractWeekly(await resp.text())) };
    if (!out.weekly.length) throw new Error("no weekly[]");
    try {
      await kv.put(STRENGTH_CACHE_KEY, JSON.stringify(out), { expirationTtl: STRENGTH_CACHE_TTL_S });
    } catch { /* the cache is best effort */ }
    return out;
  } catch (e) {
    console.error("strength-data fetch failed", String(e && e.message ? e.message : e));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Work tonnage of the KV workouts in the 7 days ending `now`. */
function acute7d(recs, now) {
  let ton = 0;
  for (const r of recs) {
    const t = Date.parse(r.start);
    if (t > now - 7 * DAY_MS && t <= now) ton += Number((r.totals && r.totals.tonnageWork) || 0);
  }
  return Math.round(ton);
}

/**
 * @param kv      LIVE namespace
 * @param now     epoch ms
 * @param opts    {focusId?, fetchImpl?, extras?: {weekly?, acwr?, sleep?, readiness?}}
 *                fetchImpl set -> weekly load from strength-data.json (KV-derived on failure)
 * @returns {ctx, json, tokens}
 */
export async function buildContext(kv, now, { focusId = null, extras = {}, fetchImpl = null } = {}) {
  const idx = await getIndex(kv);
  const recs = (await Promise.all(idx.map((e) => getWorkout(kv, e.id)))).filter(Boolean);
  recs.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));

  const allSessions = recs.map(sessionOf);
  let sessions = allSessions.slice(0, 5);
  if (focusId && !sessions.some((s) => s.id === focusId)) {
    const f = allSessions.find((s) => s.id === focusId);
    if (f) sessions = [f, ...sessions.slice(0, 4)];
  }
  const sw = !Array.isArray(extras.weekly) && fetchImpl ? await loadStrengthWeekly(kv, fetchImpl, now) : null;
  let weekly;
  let muscleWeekly = null;
  let load;
  let weeklySource;
  if (sw) {
    weeklySource = "strength-data";
    weekly = sw.weekly;
    muscleWeekly = sw.muscleWeekly;
    const w0 = weekly[0];
    load = {
      acwr: w0.acwrTonnage === null ? "n/a" : w0.acwrTonnage,
      acwrSRPE: w0.acwrSRPE === null ? "n/a" : w0.acwrSRPE,
      acute: acute7d(recs, now),
      chronicWeekly: null,
    };
  } else {
    weeklySource = Array.isArray(extras.weekly) ? "extras" : "live-20d";
    weekly = Array.isArray(extras.weekly) ? extras.weekly : weeklyOf(recs, now);
    load = extras.acwr ? extras.acwr : acwrOf(weekly);
  }
  const newestHr = recs.find((r) => r.hrMatch) || null;

  const ctx = {
    asOf: zgDate(now),
    focusWorkoutId: focusId,
    sessions,
    weeklySource,
    weeklyAsOf: sw ? sw.refreshedAt : null,
    weekly,
    muscleWeekly,
    acwr: load.acwr,
    acwrSRPE: load.acwrSRPE === undefined ? null : load.acwrSRPE,
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
  // then thin the per-week muscle table: top 6 muscles, then the two newest weeks, then none
  if (ctx.muscleWeekly && approxTokens(json) > CONTEXT_MAX_TOKENS) {
    ctx.muscleWeekly = ctx.muscleWeekly.map((w) => ({ ...w, hardSets: Object.fromEntries(Object.entries(w.hardSets).slice(0, 6)) }));
    json = JSON.stringify(ctx);
  }
  if (ctx.muscleWeekly && approxTokens(json) > CONTEXT_MAX_TOKENS) {
    ctx.muscleWeekly = ctx.muscleWeekly.slice(0, 2);
    json = JSON.stringify(ctx);
  }
  if (ctx.muscleWeekly && approxTokens(json) > CONTEXT_MAX_TOKENS) {
    ctx.muscleWeekly = null;
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
