// HR-peak <-> set matcher — 1:1 port of the anchor matcher in
// tools/build_strength.py (st-1.1): build_hr_series (artifact filter, 1 Hz
// interpolation over gaps <= 12 s, 5 s median + 5 s mean smoothing),
// detect_candidates, ordered_sets (effort prior), _prep_candidates,
// anchor_split, find_anchor, match_pre_anchor, match_dp, _emit, match_session.
//
// The Python is the reference: same constants, same loop orders, same tie
// breaks.  Two numeric details are reproduced on purpose:
//   * sum() of floats is math.fsum (correctly rounded), see pySum: build_strength.py
//     shadows sum() with math.fsum so Python 3.9 (Mac) and 3.12+ (PC) agree;
//   * round() is Python's half-even on the exact binary value (pyfmt.js).
// Only the default "anchor" method is ported (dp_legacy / topn are not).

import strengthConfig from "../../../tools/strength-config.json" with { type: "json" };
import { r1, r2 } from "./pyfmt.js";

export const VERSION = "st-1.1";

const GAP_MAX_S = 12;
const MIN_SEP_S = 35;
const PROM_MIN = 4.0;
const PROM_WIN_S = 150;
const MAX_SET_SKIP = 8;

const W_BASE = 1.0;
const W_PROM = 0.8;
const W_SIZE = 1.3;
const EXP_WARM = 0.5;
const EXP_MAIN = 1.15;
const EXP_ACC = 0.65;
const W_WEAK_WORK = 0.5;
const SKIP_SET = 1.6;
const SKIP_PEAK = 0.9;
const PRE_SKIP_W = 0.3;
const START_EARLY = 0.8;
const START_LATE = 0.5;
const START_SLACK_S = 120;

const MAIN_OFFSET_MIN = 20;
const MAIN_TOL_MIN = 5;
const ANCHOR_SEARCH_MIN = 15;
const END_SLACK_MIN = 5;
const ANCHOR_REST_S = [90, 300];
const SHORT_REST_S = 30;
const SHORT_REST_CONF = 0.25;
const ANCHOR_KG_FRAC = 0.85;
const ANCHOR_MAX_K = 5;
const ANCHOR_RISE_S = [30, 75];
const ANCHOR_GAP_S = [60, 480];
const PRE_ANCHOR_S = 600;
const PRE_ANCHOR_MIN_S = 45;
const A_BASE = 1.0;
const A_SIZE = 1.5;
const ANCHOR_SIZE_W = [0.67, 0.33];
const A_PROM = 0.8;
const A_SIM = 1.0;
const A_GAP = 0.6;
const A_INT = 0.3;
const A_BIG = 1.0;
const A_BIG_AFTER = 0.3;
const BIG_MARGIN = 3;
const A_WU = 0.8;
const A_DOM = 1.0;
const A_POS = 0.1;
const END_W = 0.4;
const FIRST_SET_WIN_S = 75;
const ALT_SEP_S = 60;

const SPIKE_RATE = 15.0;
const SPIKE_MAX_S = 8;
const DROPOUT_MIN_S = 30;
const DROPOUT_TOL = 1;
const DROPOUT_MODE_FRAC = 0.9;
export const ARTIFACT_NEAR_S = 10;
export const ARTIFACT_CONF = 0.25;
const DROPOUT_MERGE_S = 90;
const DROPOUT_NEAR_S = 30;

const NEG = -1e18;

/** load_config(): the defaults of build_strength.py overlaid with tools/strength-config.json. */
export const CONFIG = {
  warmupMin: 18, warmupWindowMin: [15, 22],
  mainBlockOffsetMin: MAIN_OFFSET_MIN, mainBlockTolMin: MAIN_TOL_MIN,
  anchorSearchMin: ANCHOR_SEARCH_MIN, endSlackMin: END_SLACK_MIN,
  anchorRestS: [...ANCHOR_REST_S], shortRestS: SHORT_REST_S,
  ...strengthConfig,
};

const cfgGet = (cfg, k, dflt) => (cfg && cfg[k] !== undefined ? cfg[k] : dflt);
const isNone = (v) => v === null || v === undefined;

// ---- Python numerics ------------------------------------------------------------

/**
 * Python math.fsum (CPython msum: Shewchuk partials + half-even correction) —
 * the float sum() of build_strength.py.  Identical to CPython >= 3.12's builtin
 * Neumaier sum() on every session of the local caches; differs in rare cases
 * such as [1e16, 1.0, 1e-16].
 */
export function pySum(xs) {
  const partials = [];
  for (let x of xs) {
    let i = 0;
    for (let k = 0; k < partials.length; k++) {
      let y = partials[k];
      if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
      const hi = x + y;
      const lo = y - (hi - x);
      if (lo !== 0) partials[i++] = lo;
      x = hi;
    }
    partials.length = i;
    partials.push(x);
  }
  let n = partials.length;
  let hi = 0.0;
  if (n > 0) {
    n -= 1;
    hi = partials[n];
    let lo = 0.0;
    while (n > 0) {
      const x = hi;
      n -= 1;
      const y = partials[n];
      hi = x + y;
      const yr = hi - x;
      lo = y - yr;
      if (lo !== 0.0) break;
    }
    if (n > 0 && ((lo < 0 && partials[n - 1] < 0) || (lo > 0 && partials[n - 1] > 0))) {
      const y = lo * 2;
      const x = hi + y;
      const yr = x - hi;
      if (y === yr) hi = x;
    }
  }
  return hi;
}

/** statistics.median (non-empty list). */
function pyMedian(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const i = n >> 1;
  return n % 2 === 1 ? s[i] : (s[i - 1] + s[i]) / 2;
}

/** build_strength.median: None-filtered, None when empty. */
function medianNN(xs) {
  const v = xs.filter((x) => !isNone(x));
  return v.length ? pyMedian(v) : null;
}

/** Python round(x) -> int (half-even). */
function roundInt(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

const truncInt = (x) => Math.trunc(x);

// ---- HR series -------------------------------------------------------------------

function toPoints(timestamps, values) {
  const m = new Map();
  const n = Math.min(timestamps.length, values.length);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (isNone(v)) continue;
    m.set(roundInt(Number(timestamps[i])), Number(v));
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

export function findSpikes(pts, rate = SPIKE_RATE, maxS = SPIKE_MAX_S) {
  const out = [];
  const n = pts.length;
  let i = 1;
  while (i < n - 1) {
    const [ta, va] = pts[i - 1];
    const [tb, vb] = pts[i];
    const sIn = (vb - va) / Math.max(tb - ta, 1);
    let hit = null;
    if (Math.abs(sIn) > rate) {
      for (let k = i + 1; k < n; k++) {
        const [tp, vp] = pts[k - 1];
        const [tk, vk] = pts[k];
        if (tk - tb > maxS) break;
        const sOut = (vk - vp) / Math.max(tk - tp, 1);
        if (Math.abs(sOut) > rate && sOut * sIn < 0) {
          hit = k;
          break;
        }
      }
    }
    if (hit !== null) {
      out.push([i, hit - 1]);
      i = hit;
    } else {
      i += 1;
    }
  }
  return out;
}

export function findDropouts(pts, tFrom = 0, minS = DROPOUT_MIN_S, tol = DROPOUT_TOL, modeFrac = DROPOUT_MODE_FRAC) {
  const out = [];
  const n = pts.length;
  let i = 0;
  while (i < n) {
    let j = i;
    let lo = pts[i][1];
    let hi = pts[i][1];
    while (j + 1 < n && Math.max(hi, pts[j + 1][1]) - Math.min(lo, pts[j + 1][1]) <= tol) {
      j += 1;
      lo = Math.min(lo, pts[j][1]);
      hi = Math.max(hi, pts[j][1]);
    }
    let a = i;
    while (a <= j && pts[a][0] < tFrom) a += 1;
    if (a <= j && pts[j][0] - pts[a][0] >= minS) {
      const counts = new Map();
      let top = 0;
      for (let k = a; k <= j; k++) {
        const c = (counts.get(pts[k][1]) || 0) + 1;
        counts.set(pts[k][1], c);
        if (c > top) top = c;
      }
      if (top >= modeFrac * (j - a + 1)) out.push([a, j]);
    }
    i = j + 1;
  }
  return out;
}

/** filter_artifacts: {ts, vals, info:{spikes, dropoutS, spikeT, dropouts}}. */
export function filterArtifacts(timestamps, values, dropoutFrom = 0) {
  const pts = toPoints(timestamps, values);
  const drop = new Set();
  const sp = findSpikes(pts);
  const spikeT = [];
  for (const [a, b] of sp) {
    for (let k = a; k <= b; k++) {
      drop.add(k);
      spikeT.push(pts[k][0]);
    }
  }
  const dos = findDropouts(pts, dropoutFrom);
  const merged = [];
  for (const [a, b] of dos) {
    if (merged.length && pts[a][0] - pts[merged[merged.length - 1][1]][0] < DROPOUT_MERGE_S) {
      merged[merged.length - 1][1] = b;
    } else {
      merged.push([a, b]);
    }
  }
  const dropouts = [];
  for (const [a, b] of merged) {
    for (let k = a; k <= b; k++) drop.add(k);
    dropouts.push([pts[a][0], pts[b][0]]);
  }
  const ts = [];
  const vals = [];
  pts.forEach((p, k) => {
    if (!drop.has(k)) {
      ts.push(p[0]);
      vals.push(p[1]);
    }
  });
  let dropoutS = 0;
  for (const [a, b] of dropouts) dropoutS += b - a;
  return { ts, vals, info: { spikes: sp.length, dropoutS, spikeT, dropouts } };
}

export function nearArtifact(t, info, w = ARTIFACT_NEAR_S, wDropout = DROPOUT_NEAR_S) {
  if (!info || isNone(t)) return false;
  for (const s of info.spikeT || []) if (Math.abs(t - s) <= w) return true;
  for (const [a, b] of info.dropouts || []) if (a - wDropout <= t && t <= b + wDropout) return true;
  return false;
}

export function steepStep(raw, a, b, rate = SPIKE_RATE) {
  if (isNone(a) || isNone(b)) return false;
  const hi = Math.min(raw.length, truncInt(b) + 1);
  for (let u = Math.max(1, truncInt(a) + 1); u < hi; u++) {
    const p = raw[u - 1];
    const v = raw[u];
    if (p !== null && v !== null && Math.abs(v - p) > rate) return true;
  }
  return false;
}

export function smoothSeries(raw, medW = 5, meanW = 5) {
  const n = raw.length;
  const hm = medW >> 1;
  const hn = meanW >> 1;
  const med = new Array(n).fill(null);
  for (let t = 0; t < n; t++) {
    if (raw[t] === null) continue;
    const w = [];
    for (let u = Math.max(0, t - hm); u < Math.min(n, t + hm + 1); u++) if (raw[u] !== null) w.push(raw[u]);
    med[t] = pyMedian(w);
  }
  const out = new Array(n).fill(null);
  for (let t = 0; t < n; t++) {
    if (med[t] === null) continue;
    const w = [];
    for (let u = Math.max(0, t - hn); u < Math.min(n, t + hn + 1); u++) if (med[u] !== null) w.push(med[u]);
    out[t] = pySum(w) / w.length;
  }
  return out;
}

/**
 * build_hr_series -> {raw, smooth} indexed by second since stream start (null = gap).
 * dropoutFrom given: spikes and (from that second on) strap dropouts are removed first;
 * `artifacts` (object) receives the filter info.
 */
export function buildHrSeries(timestamps, values, { gapMax = GAP_MAX_S, dropoutFrom = null, artifacts = null } = {}) {
  if (dropoutFrom !== null && dropoutFrom !== undefined) {
    const f = filterArtifacts(timestamps, values, dropoutFrom);
    timestamps = f.ts;
    values = f.vals;
    if (artifacts) Object.assign(artifacts, f.info);
  }
  const pts = toPoints(timestamps, values);
  if (!pts.length) return { raw: [], smooth: [] };
  const T = pts[pts.length - 1][0];
  const raw = new Array(T + 1).fill(null);
  for (let k = 0; k + 1 < pts.length; k++) {
    const [a, va] = pts[k];
    const [b, vb] = pts[k + 1];
    if (a >= 0) raw[a] = va;
    if (b - a <= gapMax) {
      for (let t = a + 1; t < b; t++) if (t >= 0) raw[t] = va + (vb - va) * (t - a) / (b - a);
    }
  }
  raw[T] = pts[pts.length - 1][1];
  return { raw, smooth: smoothSeries(raw) };
}

export function detectCandidates(smooth, lo, hi, promMin = PROM_MIN, minSep = MIN_SEP_S, win = PROM_WIN_S) {
  const n = smooth.length;
  hi = Math.min(hi, n - 1);
  const cands = [];
  for (let t = Math.max(lo, 1); t <= hi; t++) {
    const v = smooth[t];
    if (v === null) continue;
    let mx = -Infinity;
    for (let u = Math.max(0, t - 5); u < Math.min(n, t + 6); u++) if (smooth[u] !== null && smooth[u] > mx) mx = smooth[u];
    if (v < mx) continue;
    const p = smooth[t - 1];
    if (p !== null && p >= v) continue;
    let lb = v;
    for (let u = t - 1; u > Math.max(-1, t - win - 1); u--) {
      const x = smooth[u];
      if (x === null) continue;
      if (x > v) break;
      lb = Math.min(lb, x);
    }
    let rb = v;
    for (let u = t + 1; u < Math.min(n, t + win + 1); u++) {
      const x = smooth[u];
      if (x === null) continue;
      if (x > v) break;
      rb = Math.min(rb, x);
    }
    const prom = v - Math.max(lb, rb);
    if (prom >= promMin) cands.push({ t, s: v, prom });
  }
  const kept = [];
  const order = [...cands].sort((a, b) => (b.prom - a.prom) || (a.t - b.t));
  for (const c of order) {
    if (kept.every((k) => Math.abs(c.t - k.t) >= minSep)) kept.push(c);
  }
  kept.sort((a, b) => a.t - b.t);
  return kept;
}

export function setStart(smooth, tPeak, bound, win = PROM_WIN_S) {
  const a = Math.max(truncInt(bound), tPeak - win, 0);
  let m = Infinity;
  let any = false;
  for (let u = a; u <= tPeak; u++) {
    if (smooth[u] !== null && smooth[u] !== undefined) {
      any = true;
      if (smooth[u] < m) m = smooth[u];
    }
  }
  if (!any) return tPeak;
  let last = tPeak;
  for (let u = a; u <= tPeak; u++) {
    const v = smooth[u];
    if (v !== null && v !== undefined && v <= m + 1.0) last = u;
  }
  return last;
}

export function rawPeak(raw, t, w = 8) {
  let best = null;
  for (let u = Math.max(0, t - w); u < Math.min(raw.length, t + w + 1); u++) {
    if (raw[u] !== null && (best === null || raw[u] > best)) best = raw[u];
  }
  return best;
}

// ---- Hevy set order / effort prior ---------------------------------------------------

const idxOf = (o, dflt = 0) => (isNone(o.index) ? dflt : o.index);
const kgOf = (s) => s.weight_kg || 0;

function isInferredWarmup(st, exSets) {
  if (st.type !== "normal") return false;
  const kg = kgOf(st);
  const ws = exSets.map(kgOf);
  const mx = ws.length ? Math.max(...ws) : 0;
  if (mx <= 0 || kg >= mx) return false;
  const idx = idxOf(st);
  const tops = exSets.filter((x) => kgOf(x) >= mx);
  if (!tops.length || Math.min(...tops.map((x) => idxOf(x))) < idx) return false;
  const rpe = st.rpe;
  if (!isNone(rpe) && rpe > 6.5) return false;
  const topReps = pyMedian(tops.map((x) => x.reps || 0));
  const reps = st.reps || 0;
  return (reps <= 6 && reps < topReps) || kg <= 0.6 * mx;
}

/** ordered_sets: chronological sets (exercise order x set order, supersets interleaved) + effort prior. */
export function orderedSets(workout) {
  const exs = [...(workout.exercises || [])].sort((a, b) => idxOf(a) - idxOf(b));
  const groups = [];
  for (const ex of exs) {
    const sid = isNone(ex.superset_id) ? null : ex.superset_id;
    if (sid !== null && groups.length && groups[groups.length - 1][0] === sid) groups[groups.length - 1][1].push(ex);
    else groups.push([sid, [ex]]);
  }
  const out = [];
  groups.forEach(([sid, members], gi) => {
    const seqs = members.map((m) => [...(m.sets || [])].sort((a, b) => idxOf(a) - idxOf(b)));
    let k = 0;
    while (seqs.some((s) => k < s.length)) {
      members.forEach((m, mi) => {
        const s = seqs[mi];
        if (k < s.length) {
          out.push({
            ex: m, exIdx: idxOf(m), set: s[k], setIdx: idxOf(s[k], k), group: gi,
            superset: sid !== null && members.length > 1,
          });
        }
      });
      k += 1;
    }
  });
  const firstEx = out.length ? out[0].exIdx : null;
  for (const o of out) {
    const st = o.set;
    const exSets = o.ex.sets || [];
    o.inferredWarmup = isInferredWarmup(st, exSets);
    const exTop = exSets.length ? Math.max(0, ...exSets.map(kgOf)) : 0;
    const heavyWarm = st.type === "warmup" && exTop > 0 && kgOf(st) >= 0.9 * exTop && (st.reps || 0) >= 8;
    o.heavyWarmup = heavyWarm;
    const warm = (st.type === "warmup" && !heavyWarm) || o.inferredWarmup;
    const rpe = st.rpe;
    const e = isNone(rpe) ? 0.6 : Math.min(1.0, Math.max(0.3, (rpe - 4) / 6.0));
    o.warm = warm;
    o.effort = warm ? 0.15 : e;
    if (warm) o.expSize = EXP_WARM;
    else if (o.exIdx === firstEx) o.expSize = EXP_MAIN + 0.2 * e;
    else o.expSize = EXP_ACC + 0.35 * e;
  }
  return out;
}

// ---- matching -------------------------------------------------------------------------

function prepCandidates(cands, raw, smooth, nSets, base) {
  if (!cands.length) return;
  const k = Math.max(1, Math.min(nSets, cands.length));
  const desc = (xs) => [...xs].sort((a, b) => b - a).slice(0, k);
  const topP = desc(cands.map((c) => c.prom));
  const P0 = Math.max(pyMedian(topP), 1.0);
  let prev = -(10 ** 9);
  let prevSig = -(10 ** 9);
  for (const c of cands) {
    c.tStart = setStart(smooth, c.t, prev + 5);
    const tLow = setStart(smooth, c.t, prevSig + 5);
    c.delta = c.s - (smooth[tLow] !== null && smooth[tLow] !== undefined ? smooth[tLow] : c.s);
    prev = c.t;
    if (c.prom >= 0.5 * P0) prevSig = c.t;
  }
  const topD = desc(cands.map((c) => c.delta));
  const topH = desc(cands.map((c) => c.s));
  const P = Math.max(pyMedian(topP), 1.0);
  const D = Math.max(pyMedian(topD), 1.0);
  const H = Math.max(pyMedian(topH) - base, 5.0);
  for (const c of cands) {
    c.promN = Math.min(c.prom / P, 1.5);
    c.sizeN = Math.min(0.5 * Math.max(c.delta, 0) / D + 0.5 * Math.max(c.s - base, 0) / H, 1.5);
    c.hN = Math.min(Math.max(c.s - base, 0) / H, 1.5);
    c.dN = Math.min(Math.max(c.delta, 0) / D, 1.5);
  }
}

function matchScore(s, c) {
  let sc = W_BASE + W_PROM * c.promN - W_SIZE * Math.abs(c.sizeN - s.expSize);
  if (!s.warm && c.promN < 0.25) sc -= W_WEAK_WORK;
  return sc;
}

function restPen(sets, i0, c0, i1, c1, strict = false) {
  const gap = c1.tStart - c0.t;
  const nskip = i1 - i0 - 1;
  if (gap < 15) return 3.0;
  if (strict && gap < SHORT_REST_S) return 1.5;
  const sameEx = nskip === 0 && sets[i0].exIdx === sets[i1].exIdx;
  const sameSs = sets[i0].superset && sets[i0].group === sets[i1].group;
  const lower = sameSs ? 15 : 45;
  const upper = (sameEx || sameSs ? 240 : 420) * (nskip + 1);
  if (gap < lower) return 0.03 * (lower - gap);
  if (gap > upper) return 0.6 * (gap - upper) / 120.0;
  return 0.0;
}

/** match_dp: order-preserving alignment -> {assign, conf}. */
export function matchDp(sets, cands, priorStart, endT = null, strict = false, altSep = 0) {
  const N = sets.length;
  const M = cands.length;
  if (N === 0) return { assign: [], conf: [] };
  if (M === 0) return { assign: new Array(N).fill(null), conf: new Array(N).fill(0.0) };
  const skip = cands.map((c) => SKIP_PEAK * c.promN);
  const preSkip = cands.map((c) => SKIP_PEAK * c.promN * (c.t < priorStart - 60 ? PRE_SKIP_W : 1.0));
  const cs = [0.0];
  for (const x of skip) cs.push(cs[cs.length - 1] + x);
  const cpre = [0.0];
  for (const x of preSkip) cpre.push(cpre[cpre.length - 1] + x);
  const ms = sets.map((s) => cands.map((c) => matchScore(s, c)));

  const startCost = (i, j) => {
    const dev = cands[j].tStart - (priorStart + 150 * i);
    const pen = dev < 0 ? START_EARLY * (-dev) / 60.0 : START_LATE * Math.max(0.0, dev - START_SLACK_S) / 60.0;
    return SKIP_SET * i + cpre[j] + pen;
  };
  const endCost = (i, j) => {
    let c = SKIP_SET * (N - 1 - i) + (cs[M] - cs[j + 1]);
    if (endT !== null && endT !== undefined) c += END_W * Math.max(0.0, endT - cands[j].t) / 60.0;
    return c;
  };
  const trans = (i0, j0, i1, j1) => (-SKIP_SET * (i1 - i0 - 1) - (cs[j1] - cs[j0 + 1])
    - restPen(sets, i0, cands[j0], i1, cands[j1], strict));

  const F = Array.from({ length: N }, () => new Array(M).fill(NEG));
  const BP = Array.from({ length: N }, () => new Array(M).fill(null));
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < M; j++) {
      let best = -startCost(i, j);
      let arg = null;
      for (let i0 = Math.max(0, i - MAX_SET_SKIP - 1); i0 < i; i0++) {
        const row = F[i0];
        for (let j0 = 0; j0 < j; j0++) {
          if (row[j0] > NEG) {
            const v = row[j0] + trans(i0, j0, i, j);
            if (v > best) {
              best = v;
              arg = [i0, j0];
            }
          }
        }
      }
      F[i][j] = best + ms[i][j];
      BP[i][j] = arg;
    }
  }
  const B = Array.from({ length: N }, () => new Array(M).fill(NEG));
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      let best = -endCost(i, j);
      for (let i1 = i + 1; i1 < Math.min(N, i + MAX_SET_SKIP + 2); i1++) {
        for (let j1 = j + 1; j1 < M; j1++) {
          if (B[i1][j1] > NEG) {
            const v = trans(i, j, i1, j1) + ms[i1][j1] + B[i1][j1];
            if (v > best) best = v;
          }
        }
      }
      B[i][j] = best;
    }
  }
  const empty = -(SKIP_SET * N + cpre[M]);
  let bestTotal = empty;
  let bi = null;
  let bj = null;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < M; j++) {
      const v = F[i][j] - endCost(i, j);
      if (v > bestTotal + 1e-12) {
        bestTotal = v;
        bi = i;
        bj = j;
      }
    }
  }
  const assign = new Array(N).fill(null);
  if (bi !== null) {
    let cur = [bi, bj];
    while (cur !== null) {
      assign[cur[0]] = cur[1];
      cur = BP[cur[0]][cur[1]];
    }
  }
  const conf = [];
  for (let i = 0; i < N; i++) {
    const j = assign[i];
    if (j === null) {
      conf.push(0.0);
      continue;
    }
    const mm = F[i][j] + B[i][j];
    let alt = NEG;
    let anyAlt = false;
    for (let k = 0; k < M; k++) {
      if (k !== j && Math.abs(cands[k].t - cands[j].t) > altSep) {
        const v = F[i][k] + B[i][k];
        if (!anyAlt || v > alt) alt = v;
        anyAlt = true;
      }
    }
    const margin = alt > NEG ? mm - alt : 10.0;
    const q = Math.min(1.0, 0.4 + 0.6 * cands[j].promN);
    conf.push(Math.max(0.0, (1 - Math.exp(-Math.max(margin, 0.0) / 0.8)) * q));
  }
  return { assign, conf };
}

const NULL_ROW = ["tPeak", "peakHR", "tStart", "hrStart", "riseS", "hrDelta", "restBeforeS", "hrr30", "hrr60"];

function emit(sets, assign, conf, cands, raw, smooth, cfg, firstWin = null) {
  const T = raw.length - 1;
  const short = cfgGet(cfg, "shortRestS", SHORT_REST_S);
  const out = [];
  let prevPeak = null;
  const matchedTs = assign.map((j) => (j !== null ? cands[j].t : null));
  assign.forEach((j, i) => {
    if (j === null) {
      const row = {};
      for (const k of NULL_ROW) row[k] = null;
      row.conf = 0.0;
      out.push(row);
      return;
    }
    const c = cands[j];
    const tp = c.t;
    let bound;
    if (prevPeak !== null) bound = prevPeak + 5;
    else bound = firstWin ? tp - firstWin : -(10 ** 9);
    const ts = setStart(smooth, tp, bound);
    const pk = rawPeak(raw, tp);
    const hs = raw[ts];
    let nxt = null;
    for (let k = i + 1; k < assign.length; k++) {
      if (matchedTs[k] !== null) {
        nxt = matchedTs[k];
        break;
      }
    }
    const nxtStart = nxt !== null ? setStart(smooth, nxt, tp + 5) : null;
    const hrr = (dt) => {
      const u = tp + dt;
      if (u > T || raw[u] === null || pk === null) return null;
      if (nxtStart !== null && nxtStart < u) return null;
      return pk - raw[u];
    };
    const rest = prevPeak !== null ? ts - prevPeak : null;
    let cf = conf[i];
    const row = {
      tPeak: tp, peakHR: r1(pk), tStart: ts, hrStart: r1(hs),
      riseS: tp - ts,
      hrDelta: pk !== null && hs !== null ? r1(pk - hs) : null,
      restBeforeS: rest, hrr30: r1(hrr(30)), hrr60: r1(hrr(60)),
    };
    if (rest !== null && rest < short) {
      cf = Math.min(cf, SHORT_REST_CONF);
      row.shortRest = true;
    }
    row.conf = r2(cf);
    out.push(row);
    prevPeak = tp;
  });
  return out;
}

function dnsBase(smooth, lo) {
  return medianNN(smooth.slice(Math.max(0, lo - 300), Math.max(0, lo))) || medianNN(smooth.slice(0, Math.max(0, lo))) || 0.0;
}

/** anchor_split -> {pre, run} (ordered-list indices). */
export function anchorSplit(sets) {
  const none = { pre: [], run: [] };
  if (!sets.length) return none;
  const e0 = sets[0].exIdx;
  const ex1 = [];
  sets.forEach((o, i) => {
    if (o.exIdx === e0) ex1.push(i);
  });
  if (ex1.some((i) => sets[i].superset)) return none;
  const work = ex1.filter((i) => !sets[i].warm);
  if (!work.length) return none;
  const ref = pyMedian(work.map((i) => kgOf(sets[i].set)));
  const qual = new Set(work.filter((i) => ref <= 0 || kgOf(sets[i].set) >= ANCHOR_KG_FRAC * ref));
  const first = Math.min(...qual);
  let run = [];
  for (const i of ex1.slice(ex1.indexOf(first))) {
    if (!qual.has(i)) break;
    run.push(i);
  }
  run = run.slice(0, ANCHOR_MAX_K);
  const pre = ex1.filter((i) => i < run[0]);
  const contiguous = run.every((v, k) => v === run[0] + k);
  const preOk = pre.length === run[0] && pre.every((v, k) => v === k);
  if (!contiguous || !preOk) return none;
  return { pre, run };
}

/** find_anchor -> {tup, score, conf} or null. */
export function findAnchor(cands, k, nPre, t1Lo, t1Hi, tFloor, expT1, cfg) {
  const [rlo, rhi] = cfgGet(cfg, "anchorRestS", ANCHOR_REST_S);
  const gLo = rlo + ANCHOR_RISE_S[0];
  const gHi = rhi + ANCHOR_RISE_S[1];
  const M = cands.length;
  const ts = cands.map((c) => c.t);
  const size = (c) => ANCHOR_SIZE_W[0] * c.hN + ANCHOR_SIZE_W[1] * c.dN;

  const score = (tup) => {
    const hs = tup.map((j) => cands[j].s);
    const hMin = Math.min(...hs);
    const hMax = Math.max(...hs);
    const floor = hMin - BIG_MARGIN;
    const peaks = pySum(tup.map((j) => A_BASE + A_SIZE * size(cands[j]) + A_PROM * cands[j].promN));
    const sim = -A_SIM * (hMax - hMin) / 10.0;
    let gap = 0.0;
    let int = 0.0;
    let big = 0.0;
    for (let m = 0; m + 1 < tup.length; m++) {
      const g = ts[tup[m + 1]] - ts[tup[m]];
      if (g < gLo) gap -= A_GAP * (gLo - g) / 60.0;
      else if (g > gHi) gap -= A_GAP * (g - gHi) / 60.0;
    }
    const inside = new Set(tup);
    const last = tup[tup.length - 1];
    const tEnd = ts[last] + gHi;
    for (let j = tup[0] + 1; j < M; j++) {
      if (ts[j] > tEnd) break;
      if (inside.has(j)) continue;
      const over = Math.max(0.0, cands[j].s - floor) / 5.0;
      if (j < last) {
        int -= A_INT * cands[j].promN;
        big -= A_BIG * over;
      } else {
        big -= A_BIG_AFTER * over;
      }
    }
    const t1 = ts[tup[0]];
    const pre = cands.filter((c) => Math.max(tFloor, t1 - PRE_ANCHOR_S) <= c.t && c.t <= t1 - PRE_ANCHOR_MIN_S);
    const wu = -A_WU * Math.max(0, nPre - pre.length);
    const dom = pre.length ? -A_DOM * Math.max(0.0, Math.max(...pre.map((c) => c.s)) - floor) / 5.0 : 0.0;
    const pos = -A_POS * Math.max(0.0, Math.abs(t1 - expT1) - 300) / 60.0;
    return pySum([peaks, sim, gap, int, big, wu, dom, pos]);
  };

  let best = -1e18;
  let bestTup = null;
  const byPos = Array.from({ length: k }, () => new Map());
  const tup = [];
  const rec = () => {
    if (tup.length === k) {
      const sc = score(tup);
      if (sc > best) {
        best = sc;
        bestTup = [...tup];
      }
      tup.forEach((j, m) => {
        const cur = byPos[m].has(j) ? byPos[m].get(j) : -1e18;
        if (sc > cur) byPos[m].set(j, sc);
      });
      return;
    }
    const lastT = ts[tup[tup.length - 1]];
    for (let j = tup[tup.length - 1] + 1; j < M; j++) {
      const g = ts[j] - lastT;
      if (g < ANCHOR_GAP_S[0]) continue;
      if (g > ANCHOR_GAP_S[1]) break;
      tup.push(j);
      rec();
      tup.pop();
    }
  };
  for (let j1 = 0; j1 < M; j1++) {
    if (t1Lo <= ts[j1] && ts[j1] <= t1Hi) {
      tup.push(j1);
      rec();
      tup.pop();
    }
  }
  if (bestTup === null) return null;
  const conf = bestTup.map((j, m) => {
    let alt = -1e18;
    let anyAlt = false;
    for (const [jj, v] of byPos[m]) {
      if (Math.abs(ts[jj] - ts[j]) > ALT_SEP_S) {
        if (!anyAlt || v > alt) alt = v;
        anyAlt = true;
      }
    }
    const margin = alt > -1e17 ? best - alt : 10.0;
    const q = Math.min(1.0, 0.4 + 0.6 * cands[j].promN);
    return Math.max(0.0, (1 - Math.exp(-Math.max(margin, 0.0) / 0.8)) * q);
  });
  return { tup: bestTup, score: best, conf };
}

/** itertools.combinations(pool, r) in lexicographic order. */
function* combinations(pool, r) {
  const n = pool.length;
  if (r > n) return;
  const idx = Array.from({ length: r }, (_, i) => i);
  yield idx.map((i) => pool[i]);
  for (;;) {
    let i = r - 1;
    while (i >= 0 && idx[i] === i + n - r) i -= 1;
    if (i < 0) return;
    idx[i] += 1;
    for (let j = i + 1; j < r; j++) idx[j] = idx[j - 1] + 1;
    yield idx.map((x) => pool[x]);
  }
}

export function matchPreAnchor(sets, pre, cands, win, anchorI, anchorJ, strict = true) {
  const n = pre.length;
  if (n === 0) return { assign: [], conf: [] };
  const best = new Map();
  let top = [NEG, null];
  const range = Array.from({ length: n }, (_, i) => i);
  for (let r = 0; r <= Math.min(n, win.length); r++) {
    for (const S of combinations(range, r)) {
      for (const C of combinations(win, r)) {
        let sc = -SKIP_SET * (n - r);
        for (let m = 0; m < r; m++) {
          sc += matchScore(sets[pre[S[m]]], cands[C[m]]);
          if (m) sc -= restPen(sets, pre[S[m - 1]], cands[C[m - 1]], pre[S[m]], cands[C[m]], strict);
        }
        if (r) {
          sc -= restPen(sets, pre[S[r - 1]], cands[C[r - 1]], anchorI, cands[anchorJ], strict);
          const used = new Set(C);
          sc -= pySum(win.filter((j) => j > C[0] && !used.has(j)).map((j) => SKIP_PEAK * cands[j].promN));
        }
        for (let m = 0; m < r; m++) {
          const key = `${S[m]},${C[m]}`;
          if (sc > (best.has(key) ? best.get(key) : NEG)) best.set(key, sc);
        }
        if (sc > top[0]) top = [sc, [S, C]];
      }
    }
  }
  const assign = new Array(n).fill(null);
  const conf = new Array(n).fill(0.0);
  if (top[1] === null) return { assign, conf };
  const [S, C] = top[1];
  for (let m = 0; m < S.length; m++) {
    const i = S[m];
    const j = C[m];
    assign[i] = j;
    let alt = NEG;
    for (const [key, v] of best) {
      const [ii, jj] = key.split(",").map(Number);
      if (ii === i && Math.abs(cands[jj].t - cands[j].t) > ALT_SEP_S && v > alt) alt = v;
    }
    const margin = alt > NEG ? top[0] - alt : 10.0;
    const q = Math.min(1.0, 0.4 + 0.6 * cands[j].promN);
    conf[i] = Math.max(0.0, (1 - Math.exp(-Math.max(margin, 0.0) / 0.8)) * q);
  }
  return { assign, conf };
}

function matchAnchor(sets, raw, smooth, cfg) {
  const T = raw.length - 1;
  const N = sets.length;
  const tFloor = truncInt(cfgGet(cfg, "warmupWindowMin", [15, 22])[0] * 60);
  const off = cfgGet(cfg, "mainBlockOffsetMin", MAIN_OFFSET_MIN) * 60;
  const L = Math.max(0, T - off);
  const msExp = T - L;
  const tol = cfgGet(cfg, "mainBlockTolMin", MAIN_TOL_MIN) * 60;
  const t1Hi = msExp + tol + cfgGet(cfg, "anchorSearchMin", ANCHOR_SEARCH_MIN) * 60;
  const endT = T - cfgGet(cfg, "endSlackMin", END_SLACK_MIN) * 60;
  const base = dnsBase(smooth, tFloor);
  const cands = detectCandidates(smooth, Math.max(0, tFloor - 150), T);
  prepCandidates(cands, raw, smooth, N, base);
  cands.forEach((c, gi) => {
    c.gi = gi;
  });
  const info = { expectedMainMin: r1(L / 60), expectedMainStartS: truncInt(msExp), dnsBaseHR: r1(base) };
  const { pre, run } = anchorSplit(sets);
  const assign = new Array(N).fill(null);
  const conf = new Array(N).fill(0.0);
  let anchor = null;
  let fwdSets = Array.from({ length: N }, (_, i) => i);
  let fwdC = cands.filter((c) => c.t >= tFloor);
  let prior = msExp;
  if (run.length) {
    const expT1 = msExp + 150 * pre.length;
    const fa = findAnchor(cands, run.length, pre.length, tFloor, t1Hi, tFloor, expT1, cfg);
    if (fa !== null) {
      const { tup, score, conf: aconf } = fa;
      run.forEach((i, m) => {
        assign[i] = tup[m];
        conf[i] = aconf[m];
      });
      anchor = {
        exercise: sets[run[0]].ex.title ?? null, tPeaks: tup.map((j) => cands[j].t),
        score: r2(score), sets: run.length,
      };
      const t1 = cands[tup[0]].t;
      const win = [];
      cands.forEach((c, j) => {
        if (Math.max(tFloor, t1 - PRE_ANCHOR_S) <= c.t && c.t <= t1 - PRE_ANCHOR_MIN_S) win.push(j);
      });
      const pa = matchPreAnchor(sets, pre, cands, win, run[0], tup[0]);
      pre.forEach((i, m) => {
        assign[i] = pa.assign[m];
        conf[i] = pa.conf[m];
      });
      const tLast = cands[tup[tup.length - 1]].t;
      fwdSets = [];
      for (let i = run[run.length - 1] + 1; i < N; i++) fwdSets.push(i);
      fwdC = cands.filter((c) => c.t > tLast);
      prior = tLast + 90;
    }
  }
  if (fwdSets.length) {
    const r = matchDp(fwdSets.map((i) => sets[i]), fwdC, prior, endT, true, ALT_SEP_S);
    fwdSets.forEach((i, m) => {
      assign[i] = r.assign[m] !== null ? fwdC[r.assign[m]].gi : null;
      conf[i] = r.conf[m];
    });
  }
  info.anchor = anchor;
  info.method = anchor ? "anchor" : "anchor-fallback";
  return { assign, conf, cands, info };
}

/**
 * match_session (method "anchor").  sets = orderedSets(workout); artifacts = the
 * filter info from buildHrSeries (or null).  Returns {out, quality} like the Python.
 */
export function matchSession(sets, raw, smooth, cfg = CONFIG, artifacts = null) {
  const T = raw.length - 1;
  const { assign, conf, cands, info } = matchAnchor(sets, raw, smooth, cfg);
  const out = emit(sets, assign, conf, cands, raw, smooth, cfg, FIRST_SET_WIN_S);
  const arts = artifacts && Object.keys(artifacts).length ? artifacts : null;
  for (const o of out) {
    if (o.tPeak === null) continue;
    const steep = steepStep(raw, o.tStart, o.tPeak);
    if (steep || nearArtifact(o.tPeak, arts)) {
      o.conf = r2(Math.min(o.conf, ARTIFACT_CONF));
      o.nearArtifact = true;
    }
    if (steep) o.steepRise = true;
  }
  const matched = out.filter((o) => o.tPeak !== null).length;
  const firstIdx = out.findIndex((o) => o.tPeak !== null);
  const first = firstIdx >= 0 ? out[firstIdx] : null;
  const lo = truncInt(cfgGet(cfg, "warmupWindowMin", [15, 22])[0] * 60);
  let wuEnd;
  if (first !== null && firstIdx === 0) wuEnd = first.tStart;
  else if (first !== null) wuEnd = Math.max(lo, first.tStart - 150 * firstIdx);
  else wuEnd = truncInt(info.expectedMainStartS ?? lo);
  const confs = out.map((o) => o.conf);
  const rests = out.filter((o) => o.restBeforeS !== null).map((o) => o.restBeforeS);
  const peaks = out.filter((o) => o.tPeak !== null).map((o) => o.tPeak);
  const quality = {
    method: info.method, expected: sets.length, candidates: cands.length, matched,
    conf: r2(medianNN(confs) || 0.0), warmupEndS: truncInt(wuEnd), mainStartS: truncInt(wuEnd),
    dnsBaseHR: info.dnsBaseHR, mainEndS: T, anchor: info.anchor,
    confSetsPct: confs.length ? r1(100.0 * confs.filter((c) => c >= 0.5).length / confs.length) : null,
    shortRests: out.filter((o) => o.shortRest).length,
    nearArtifact: out.filter((o) => o.nearArtifact).length,
    minRestS: rests.length ? Math.min(...rests) : null,
    lastPeakS: peaks.length ? Math.max(...peaks) : null, streamEndS: T,
    expectedMainMin: info.expectedMainMin,
  };
  if (quality.anchor) quality.anchor.peakHR = quality.anchor.tPeaks.map((t) => r1(rawPeak(raw, t)));
  return { out, quality };
}

/**
 * Worker entry point: raw Hevy workout (exercises[].{index,title,superset_id,
 * sets[].{index,type,weight_kg,reps,rpe}}) + the full-resolution HR doc
 * (raw/strava_hr schema: {startTime, timestamps, streams.heart_rate.values})
 * -> the `hrMatch` record field, or null when there is nothing to match.
 * Sets are matched exactly as build_strength.py does (dropout filter from the
 * warm-up window floor on, anchor method).
 */
export function matchWorkoutHr(workout, doc, cfg = CONFIG) {
  const ts = doc && doc.timestamps;
  const vals = doc && doc.streams && doc.streams.heart_rate && doc.streams.heart_rate.values;
  if (!Array.isArray(ts) || !Array.isArray(vals) || !ts.length) return null;
  const sets = orderedSets(workout || {});
  if (!sets.length) return null;
  const artFrom = truncInt(cfgGet(cfg, "warmupWindowMin", [15, 22])[0] * 60);
  const arts = {};
  const { raw, smooth } = buildHrSeries(ts, vals, { dropoutFrom: artFrom, artifacts: arts });
  if (raw.length < 2) return null;
  const { out, quality: q } = matchSession(sets, raw, smooth, cfg, arts);
  return {
    method: "anchor-js",
    version: VERSION,
    hrStart: doc.startTime || null,
    expected: q.expected,
    matched: q.matched,
    conf: q.conf,
    confSetsPct: q.confSetsPct,
    anchor: q.anchor
      ? { exercise: q.anchor.exercise, tPeaks: q.anchor.tPeaks, peakHR: q.anchor.peakHR, score: q.anchor.score, sets: q.anchor.sets }
      : null,
    warmupEndS: q.warmupEndS,
    streamEndS: q.streamEndS,
    shortRests: q.shortRests,
    nearArtifact: q.nearArtifact,
    artifacts: { spikes: arts.spikes || 0, dropoutS: arts.dropoutS || 0 },
    sets: out.map((o, k) => ({ ex: sets[k].exIdx, set: sets[k].setIdx, ...o })),
  };
}
