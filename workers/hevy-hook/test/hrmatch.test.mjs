// src/hrmatch.js — ports of the synthetic tests in tools/test_build_strength.py.
// The synthetic sessions use a Python-compatible Mersenne Twister (random.Random),
// so seed N here is the same HR trace as seed N in the Python tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARTIFACT_CONF, anchorSplit, buildHrSeries, CONFIG, detectCandidates, filterArtifacts, matchSession,
  matchWorkoutHr, nearArtifact, orderedSets, pySum, steepStep,
} from "../src/hrmatch.js";

// ---- Python random.Random (MT19937, init_by_array seeding) ---------------------------

class PyRandom {
  constructor(seed) {
    this.mt = new Uint32Array(624);
    this.mti = 625;
    let n = BigInt(Math.abs(seed));
    const key = [];
    do {
      key.push(Number(n & 0xffffffffn));
      n >>= 32n;
    } while (n > 0n);
    this.initByArray(key);
  }
  initGenrand(s) {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) {
      const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1812433253, p) + i) >>> 0;
    }
    this.mti = 624;
  }
  initByArray(key) {
    this.initGenrand(19650218);
    const mt = this.mt;
    let i = 1;
    let j = 0;
    for (let k = Math.max(624, key.length); k; k--) {
      const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(p, 1664525)) + key[j] + j) >>> 0;
      i += 1;
      j += 1;
      if (i >= 624) {
        mt[0] = mt[623];
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = 623; k; k--) {
      const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(p, 1566083941)) - i) >>> 0;
      i += 1;
      if (i >= 624) {
        mt[0] = mt[623];
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }
  uint32() {
    const mt = this.mt;
    if (this.mti >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.mti = 0;
    }
    let y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
  random() {
    const a = this.uint32() >>> 5;
    const b = this.uint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }
  randbelow(n) {
    const k = n.toString(2).length;
    let r = this.uint32() >>> (32 - k);
    while (r >= n) r = this.uint32() >>> (32 - k);
    return r;
  }
  randint(a, b) {
    return a + this.randbelow(b - a + 1);
  }
  choice(seq) {
    return seq[this.randbelow(seq.length)];
  }
  uniform(a, b) {
    return a + (b - a) * this.random();
  }
}

/** Python round(x) -> int (half-even). */
function pyRoundInt(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

// ---- synthetic sessions (tools/test_build_strength.py) -------------------------------

const CFG = { warmupMin: 18, warmupWindowMin: [15, 22], hrMax: 173, gyms: {}, defaultGym: "unknown" };

function makeWorkout(spec) {
  return {
    id: "w", title: "t",
    exercises: spec.map((sets, i) => ({
      index: i, title: `Ex${i}`, notes: "", exercise_template_id: `T${i}`, superset_id: null,
      sets: sets.map(([type, kg, reps, rpe], k) => ({ index: k, type, weight_kg: kg, reps, rpe })),
    })),
  };
}

function synthHr(plan, { mainStart = 1140, seed = 1, totalPad = 240, noise = 1.5 } = {}) {
  const rng = new PyRandom(seed);
  const peaks = [];
  const starts = [];
  let t = mainStart;
  for (const [amp, dur, rest] of plan) {
    starts.push([t, amp, dur]);
    peaks.push(t + dur);
    t += dur + rest;
  }
  const T = t + totalPad;
  const hr = (u) => {
    let v;
    if (u < 600) v = 100 + 3 * Math.sin(u / 23.0);
    else if (u < mainStart) v = 88 + 11 * Math.max(0.0, Math.sin(((u - 600) / 45.0) * Math.PI)) ** 4;
    else v = 95.0;
    for (const [s0, amp, dur] of starts) {
      const tau = u - s0;
      if (tau >= 0 && tau <= dur) v += (amp * tau) / dur;
      else if (tau > dur) v += amp * Math.exp(-(tau - dur) / 35.0);
    }
    return v + rng.uniform(-noise, noise);
  };
  const ts = [];
  const vals = [];
  let u = 0;
  while (u <= T) {
    ts.push(u);
    vals.push(rng.random() < 0.01 ? null : pyRoundInt(hr(u)));
    u += rng.random() > 0.01 ? rng.choice([1, 2, 2, 3]) : 9;
  }
  return { ts, vals, peaks };
}

function anchorSession(seed) {
  const rng = new PyRandom(1000 + seed);
  const plan = [];
  for (let i = 0; i < 2; i++) plan.push([rng.uniform(12, 17), rng.randint(20, 30), rng.randint(60, 180)]);
  for (let i = 0; i < 3; i++) plan.push([rng.uniform(46, 54), rng.randint(40, 50), rng.randint(90, 180)]);
  for (let i = 0; i < 12; i++) plan.push([rng.uniform(22, 32), rng.randint(30, 45), rng.randint(60, 180)]);
  const spec = [[["warmup", 60, 6, 6], ["warmup", 80, 4, 6], ["normal", 120, 8, 8], ["normal", 120, 8, 8.5], ["normal", 120, 8, 9]]];
  for (let i = 0; i < 4; i++) spec.push([["normal", 50, 12, 7], ["normal", 50, 12, 8], ["normal", 50, 12, 9]]);
  const mainStart = 1080 + rng.randint(0, 120);
  const { ts, vals, peaks } = synthHr(plan, { mainStart, seed, noise: 2.5 });
  return { ts, vals, peaks, spec, mainStart };
}

function run(ts, vals, spec, { filt = false } = {}) {
  const arts = {};
  const { raw, smooth } = filt
    ? buildHrSeries(ts, vals, { dropoutFrom: 900, artifacts: arts })
    : buildHrSeries(ts, vals);
  const { out, quality } = matchSession(orderedSets(makeWorkout(spec)), raw, smooth, CFG, filt ? arts : null);
  return { out, q: quality, arts, raw, smooth };
}

const near = (ts, t) => {
  let best = 0;
  for (let k = 1; k < ts.length; k++) if (Math.abs(ts[k] - t) < Math.abs(ts[best] - t)) best = k;
  return best;
};

// ---- harness fidelity ----------------------------------------------------------------

test("PyRandom reproduces CPython random.Random", () => {
  const r = new PyRandom(1000);
  assert.deepEqual([r.random(), r.random(), r.random()], [0.7773566427005639, 0.6698255595592497, 0.09913960392481702]);
  assert.equal(r.randint(20, 30), 25);
  assert.equal(r.choice([1, 2, 2, 3]), 1);
  assert.equal(r.uniform(-2.5, 2.5), -0.1604612854957903);
  assert.equal(new PyRandom(2 ** 40 + 7).random(), 0.6137037779936511);
  const s = anchorSession(0);
  assert.equal(s.ts.length, 1922);
  assert.equal(s.vals.filter((v) => v === null).length, 25);
  assert.equal(s.vals.reduce((a, v) => a + (v ?? 0), 0), 193576);
  assert.deepEqual(s.peaks.slice(0, 5), [1226, 1408, 1524, 1719, 1886]);
  assert.equal(s.mainStart, 1196);
});

test("golden: anchor_session(0) gives the Python result exactly", () => {
  const s = anchorSession(0);
  const { out, q } = run(s.ts, s.vals, s.spec);
  assert.deepEqual(q.anchor, { exercise: "Ex0", tPeaks: [1520, 1719, 1885], score: 13.25, sets: 3, peakHR: [140.5, 143.0, 145.0] });
  assert.deepEqual(out.map((o) => o.tPeak), [1227, 1410, 1520, 1719, 1885, 2042, 2166, 2273, 2397, 2572, 2775, 2963, 3125, 3248, 3339, 3520, 3677]);
  assert.deepEqual(out.map((o) => o.conf), [0.46, 0.38, 1.0, 1.0, 1.0, 1.0, 0.91, 0.87, 0.87, 0.99, 0.99, 0.99, 0.85, 0.8, 0.93, 0.99, 1.0]);
});

test("pySum is Python math.fsum (build_strength.py float sum)", () => {
  assert.equal(pySum([0.1, 0.2, 0.3]), 0.6);           // naive left-to-right gives 0.6000000000000001
  assert.equal(pySum([1e16, 1.0, -1e16]), 1.0);
  assert.equal(pySum(Array(10).fill(0.1)), 1.0);
  assert.equal(pySum([1e16, 1.0, 1e-16]), 1.0000000000000002e16);   // fsum; CPython 3.12+ builtin sum gives 1e16
  assert.equal(pySum([2 ** 53, 1.0, 2 ** -30]), 9007199254740994);
  assert.equal(pySum([]), 0);
});

// ---- set order -----------------------------------------------------------------------

test("superset interleave and inferred warm-ups", () => {
  const w = makeWorkout([[["normal", 50, 10, 7], ["normal", 50, 10, 7]], [["normal", 20, 12, 7], ["normal", 20, 12, 7]], [["normal", 10, 12, 7]]]);
  w.exercises[0].superset_id = 0;
  w.exercises[1].superset_id = 0;
  assert.deepEqual(orderedSets(w).map((o) => [o.exIdx, o.setIdx]), [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0]]);
  const w2 = makeWorkout([[["normal", 70, 6, null], ["normal", 110, 3, null], ["normal", 120, 8, null], ["normal", 120, 8, null]]]);
  assert.deepEqual(orderedSets(w2).map((o) => o.inferredWarmup), [true, true, false, false]);
});

// ---- matching ------------------------------------------------------------------------

const PLAN = [[14, 25, 110], [16, 25, 120], [18, 20, 130],
  [48, 45, 170], [50, 45, 180], [52, 45, 175], [53, 45, 185],
  ...Array(3).fill([[28, 40, 100], [26, 40, 95], [30, 40, 110]]).flat()];
const SPEC = [[["warmup", 60, 6, 6], ["warmup", 80, 4, 6], ["warmup", 100, 2, 6],
  ["normal", 120, 8, 8], ["normal", 120, 8, 8.5], ["normal", 120, 8, 9], ["normal", 120, 8, 9.5]],
[["normal", 60, 12, 7], ["normal", 60, 12, 8], ["normal", 60, 12, 9]],
[["normal", 40, 12, 7], ["normal", 40, 12, 8], ["normal", 40, 12, 9]],
[["normal", 20, 12, 7], ["normal", 20, 12, 8], ["normal", 20, 12, 9]]];

test("interpolation over gaps <= 12 s only", () => {
  const { raw } = buildHrSeries([0, 5, 30, 31], [100, 110, 120, null]);
  assert.ok(Math.abs(raw[2] - 104.0) < 1e-9);
  assert.equal(raw[10], null);
  assert.equal(raw[30], 120.0);
});

test("all 16 sets recovered in order (seeds 1-3)", () => {
  const s1 = synthHr(PLAN);
  const { smooth } = buildHrSeries(s1.ts, s1.vals);
  assert.ok(detectCandidates(smooth, 900, 1130).length >= 2);
  for (const seed of [1, 2, 3]) {
    const { ts, vals, peaks } = synthHr(PLAN, { seed });
    const { out, q } = run(ts, vals, SPEC);
    assert.equal(q.expected, 16);
    assert.equal(q.matched, 16, `seed ${seed}`);
    const got = out.map((o) => o.tPeak);
    assert.deepEqual(got, [...got].sort((a, b) => a - b));
    got.forEach((g, k) => assert.ok(Math.abs(g - peaks[k]) <= 20, `seed ${seed}: ${g} vs ${peaks[k]}`));
    assert.ok(Math.abs(q.warmupEndS - 1140) <= 90, `seed ${seed}: ${q.warmupEndS}`);
    for (const o of out) {
      assert.ok(o.conf > 0);
      assert.notEqual(o.peakHR, null);
    }
  }
});

test("fewer peaks than sets: no invented peaks (22 seeds)", () => {
  const plan = PLAN.slice(0, 10);
  for (let seed = 1; seed < 23; seed++) {
    const { ts, vals, peaks } = synthHr(plan, { seed });
    const { out, q } = run(ts, vals, SPEC);
    assert.ok(q.matched <= 10 && q.matched >= 9, `seed ${seed}: matched ${q.matched}`);
    const matched = out.filter((o) => o.tPeak !== null).map((o) => o.tPeak);
    assert.equal(new Set(matched).size, matched.length);
    assert.deepEqual(matched, [...matched].sort((a, b) => a - b));
    for (const g of matched) assert.ok(Math.min(...peaks.map((p) => Math.abs(g - p))) <= 20, `seed ${seed}: ${g}`);
    assert.ok(Math.min(...matched) >= peaks[0] - 20, `seed ${seed}`);
    for (const o of out) {
      if (o.tPeak === null) {
        assert.equal(o.conf, 0.0);
        assert.equal(o.peakHR, null);
      }
    }
    assert.ok(q.conf < 0.9);
  }
});

test("anchor recovery across 20 seeds", () => {
  for (let seed = 0; seed < 20; seed++) {
    const { ts, vals, peaks, spec, mainStart } = anchorSession(seed);
    const sets = orderedSets(makeWorkout(spec));
    assert.deepEqual(anchorSplit(sets), { pre: [0, 1], run: [2, 3, 4] });
    const { out, q } = run(ts, vals, spec);
    assert.equal(q.method, "anchor");
    const an = q.anchor.tPeaks;
    assert.equal(an.length, 3);
    an.forEach((g, k) => assert.ok(Math.abs(g - peaks[2 + k]) <= 20, `seed ${seed}: anchor ${an} vs ${peaks.slice(2, 5)}`));
    const ok = out.filter((o, k) => o.tPeak !== null && Math.abs(o.tPeak - peaks[k]) <= 20).length;
    assert.ok(ok / peaks.length >= 0.9, `seed ${seed}: ${ok}/${peaks.length}`);
    assert.ok(Math.abs(q.warmupEndS - mainStart) <= 90, `seed ${seed}: ${q.warmupEndS} vs ${mainStart}`);
    for (const o of out) {
      if (o.restBeforeS !== null && o.restBeforeS < 30) {
        assert.equal(o.shortRest, true);
        assert.ok(o.conf <= 0.25);
      }
    }
  }
});

// ---- artifacts -----------------------------------------------------------------------

test("clean sessions: no artifacts, no steepRise", () => {
  for (let seed = 0; seed < 10; seed++) {
    const { ts, vals, spec } = anchorSession(seed);
    const { info } = filterArtifacts(ts, vals, 900);
    assert.deepEqual([info.spikes, info.dropoutS], [0, 0], `seed ${seed}`);
    const { out } = run(ts, vals, spec, { filt: true });
    assert.equal(out.filter((o) => o.steepRise || o.nearArtifact).length, 0, `seed ${seed}`);
  }
});

test("a spike is never taken as a peak", () => {
  for (const seed of [0, 1, 2]) {
    const s = anchorSession(seed);
    const vals = [...s.vals];
    const p = s.peaks[3];
    const k = near(s.ts, p + 4);
    const spike = Math.max(...vals.slice(k - 3, k + 4).filter((v) => v !== null)) + 60;
    vals[k] = spike;
    vals[k + 1] = spike - 2;
    const unf = run(s.ts, vals, s.spec);
    assert.ok(Math.max(...unf.out.map((o) => o.peakHR || 0)) >= spike - 2, "spike must bite unfiltered");
    const { out, q, arts } = run(s.ts, vals, s.spec, { filt: true });
    assert.equal(arts.spikes, 1, `seed ${seed}`);
    assert.ok(Math.max(...out.map((o) => o.peakHR || 0)) < spike - 2, `seed ${seed}`);
    assert.ok(Math.abs(q.anchor.tPeaks[1] - p) <= 20, `seed ${seed}`);
    const nearOnes = out.filter((o) => o.nearArtifact);
    assert.ok(nearOnes.length, `seed ${seed}`);
    for (const o of nearOnes) assert.ok(o.conf <= ARTIFACT_CONF);
  }
});

test("a flat dropout is never taken as a peak", () => {
  for (const seed of [0, 1, 2]) {
    const s = anchorSession(seed);
    const vals = [...s.vals];
    let j = 5;
    for (let i = 5; i < s.peaks.length - 1; i++) if (s.peaks[i + 1] - s.peaks[i] > s.peaks[j + 1] - s.peaks[j]) j = i;
    const a = s.peaks[j] + 30;
    const b = s.peaks[j + 1] - 45;
    assert.ok(b - a >= 40);
    const frozen = Math.max(...vals.filter((v) => v !== null)) + 5;
    s.ts.forEach((t, i) => {
      if (a <= t && t <= b) vals[i] = frozen;
    });
    const { out, arts } = run(s.ts, vals, s.spec, { filt: true });
    assert.ok(arts.dropoutS >= b - a - 3, `seed ${seed}`);
    assert.equal(arts.spikes, 0);
    for (const o of out) {
      if (o.tPeak !== null) {
        assert.ok(!(a <= o.tPeak && o.tPeak <= b), `seed ${seed}: peak ${o.tPeak} in dropout`);
        assert.ok(o.peakHR < frozen);
      }
    }
    const ok = out.filter((o, k) => o.tPeak !== null && Math.abs(o.tPeak - s.peaks[k]) <= 20).length;
    assert.ok(ok / s.peaks.length >= 0.85, `seed ${seed}`);
  }
});

test("multi-level freeze: merged span, no peak inside, nearby sets capped", () => {
  for (const seed of [0, 1, 2]) {
    const s = anchorSession(seed);
    const { raw: raw0 } = buildHrSeries(s.ts, s.vals);
    const ts = raw0.map((_, i) => i);
    const vals = raw0.map((v) => (v === null ? null : pyRoundInt(v)));
    const a = s.peaks[7] - 40;
    const levels = [[a, a + 45, 125], [a + 90, a + 140, 118], [a + 190, a + 260, 72]];
    const blip = [levels[0][1] + 1, levels[1][0] - 1];
    assert.ok(blip[1] - blip[0] < 90);
    for (const [lo, hi, v] of levels) for (let t = lo; t <= hi; t++) vals[t] = v;
    const loSpan = levels[0][0];
    const hiSpan = levels[2][1];
    const { out, arts } = run(ts, vals, s.spec, { filt: true });
    assert.equal(arts.dropouts.length, 1, `seed ${seed}: ${JSON.stringify(arts.dropouts)}`);
    const [d0, d1] = arts.dropouts[0];
    assert.ok(d0 <= loSpan + 1 && d1 >= hiSpan - 1);
    assert.ok(arts.dropoutS >= hiSpan - loSpan - 3);
    const kept = filterArtifacts(ts, vals, 900).ts;
    assert.equal(kept.filter((t) => d0 <= t && t <= d1).length, 0, "samples inside the merged span survive");
    for (const o of out) {
      if (o.tPeak === null) continue;
      assert.ok(!(d0 <= o.tPeak && o.tPeak <= d1), `seed ${seed}: peak ${o.tPeak} in span ${d0}-${d1}`);
      if (d0 - 30 <= o.tPeak && o.tPeak <= d1 + 30) {
        assert.equal(o.nearArtifact, true, `seed ${seed}`);
        assert.ok(o.conf <= ARTIFACT_CONF);
      }
    }
    assert.ok(nearArtifact(d0 - 25, arts));
    assert.ok(nearArtifact(d1 + 25, arts));
    assert.ok(!nearArtifact(d1 + 45, arts));
  }
});

test("dropouts far apart stay separate", () => {
  const ts = Array.from({ length: 400 }, (_, t) => t);
  const vals = ts.map((t) => 100 + (t % 7) * 4);
  for (let t = 50; t < 90; t++) vals[t] = 130;
  for (let t = 200; t < 240; t++) vals[t] = 118;
  assert.equal(filterArtifacts(ts, vals, 0).info.dropouts.length, 2);
});

test("steep step helper", () => {
  const raw = [100, 101, 103, 119, 120, null, 140, 141];
  assert.equal(steepStep(raw, 0, 4), true);
  assert.equal(steepStep(raw, 3, 7), false);
  assert.equal(steepStep(raw, 0, 2), false);
  assert.equal(steepStep(raw, null, 4), false);
});

test("steep rise: samples kept, set flagged steepRise + nearArtifact, conf capped", () => {
  for (const seed of [0, 1, 2]) {
    const s = anchorSession(seed);
    const { raw: raw0 } = buildHrSeries(s.ts, s.vals);
    const ts = raw0.map((_, i) => i);
    const vals = raw0.map((v) => (v === null ? null : pyRoundInt(v)));
    const p = s.peaks[3];
    for (let t = p - 12; t < vals.length; t++) {
      if (vals[t] !== null) vals[t] += t <= p + 15 ? 20 : Math.max(0, 20 - 0.5 * (t - p - 15));
    }
    const { out, q, arts } = run(ts, vals, s.spec, { filt: true });
    assert.equal(arts.spikes, 0, `seed ${seed}: the step must not be removed as a spike`);
    const hit = out.filter((o) => o.steepRise);
    assert.ok(hit.length, `seed ${seed}`);
    let k = 0;
    for (let i = 1; i < out.length; i++) {
      if (Math.abs((out[i].tPeak ?? -1e6) - p) < Math.abs((out[k].tPeak ?? -1e6) - p)) k = i;
    }
    assert.equal(out[k].steepRise, true, `seed ${seed}`);
    for (const o of hit) {
      assert.equal(o.nearArtifact, true);
      assert.ok(o.conf <= ARTIFACT_CONF);
      assert.ok(o.tStart < p - 12);
      assert.ok(o.tPeak >= p - 12);
    }
    assert.equal(q.nearArtifact, out.filter((o) => o.nearArtifact).length);
  }
});

// ---- Worker entry point ----------------------------------------------------------------

test("matchWorkoutHr: record shape from a raw-HR doc", () => {
  const s = anchorSession(0);
  const doc = { startTime: "2026-10-08T08:02:22.000Z", timestamps: s.ts, streams: { heart_rate: { unit: "bpm", values: s.vals } } };
  const hm = matchWorkoutHr(makeWorkout(s.spec), doc, CONFIG);
  assert.equal(hm.method, "anchor-js");
  assert.equal(hm.hrStart, doc.startTime);
  assert.equal(hm.expected, 17);
  assert.equal(hm.matched, 17);
  assert.deepEqual(Object.keys(hm.anchor), ["exercise", "tPeaks", "peakHR", "score", "sets"]);
  assert.deepEqual(hm.anchor.tPeaks, [1520, 1719, 1885]);
  assert.deepEqual(hm.artifacts, { spikes: 0, dropoutS: 0 });
  assert.deepEqual(Object.keys(hm.sets[0]).slice(0, 4), ["ex", "set", "tPeak", "peakHR"]);
  for (const k of ["hrStart", "restBeforeS", "conf", "tStart", "riseS", "hrDelta", "hrr30", "hrr60"]) assert.ok(k in hm.sets[0], k);
  assert.deepEqual(hm.sets.map((o) => [o.ex, o.set]).slice(0, 6), [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [1, 0]]);
  assert.equal(matchWorkoutHr(makeWorkout(s.spec), { timestamps: [], streams: { heart_rate: { values: [] } } }), null);
  assert.equal(matchWorkoutHr({ exercises: [] }, doc), null);
});

// ---- Worker integration (process.js) ------------------------------------------------------

import { processWebhook, runCron } from "../src/process.js";
import { handle, makeRuntime } from "../src/index.js";
import { fakeCtx, jsonResponse, MemoryKV, noSleep, scriptedFetch } from "./helpers.mjs";

const NOW = Date.parse("2026-10-08T10:00:00Z");
const WID = "abcdef12-3456-7890-abcd-ef1234567890";

function liveFixture() {
  const s = anchorSession(0);
  const workout = {
    ...makeWorkout(s.spec), id: WID, title: "Synthetic", description: "",
    start_time: "2026-10-08T08:22:22+00:00", end_time: "2026-10-08T09:02:00+00:00", updated_at: "2026-10-08T09:05:00Z",
  };
  const keep = s.vals.map((v, i) => i).filter((i) => s.vals[i] !== null);
  const streams = { time: { data: keep.map((i) => s.ts[i]) }, heartrate: { data: keep.map((i) => s.vals[i]) } };
  const act = { id: 777, name: "Weight Training", description: "", start_date: "2026-10-08T08:02:22Z", sport_type: "WeightTraining", elapsed_time: 3700 };
  return { workout, streams, act };
}

function liveApis({ workout, streams, act }, activities) {
  return scriptedFetch([
    ["GET", /api\.hevyapp\.com\/v1\/workouts\//, () => jsonResponse(workout)],
    ["POST", /strava\.com\/oauth\/token/, () => jsonResponse({ access_token: "acc", refresh_token: "r", expires_at: NOW / 1000 + 21600 })],
    ["GET", /\/athlete\/activities/, () => jsonResponse(activities(), 200, { "X-RateLimit-Limit": "200,2000", "X-RateLimit-Usage": "3,40" })],
    ["GET", /\/activities\/777\/streams/, () => jsonResponse(streams)],
    ["GET", /\/activities\/777$/, () => jsonResponse(act)],
    ["PUT", /\/activities\/777$/, () => jsonResponse({ id: 777 })],
  ]);
}

const liveEnv = () => ({
  LIVE: new MemoryKV(), HEVY_API_KEY: "h", STRAVA_CLIENT_ID: "1", STRAVA_CLIENT_SECRET: "s",
  STRAVA_REFRESH_TOKEN: "seed", WEBHOOK_AUTH: "hook",
});

test("process: webhook with HR -> hrMatch on the record and in /live/recent", async () => {
  const fx = liveFixture();
  const e = liveEnv();
  const rt = makeRuntime(e, { fetch: liveApis(fx, () => [fx.act]), sleep: noSleep, now: () => NOW });
  const rec = await processWebhook(rt, WID);
  assert.equal(rec.status, "hr-attached");
  const doc = JSON.parse(await e.LIVE.get("hr:777"));
  const direct = matchWorkoutHr(fx.workout, doc);
  assert.ok(direct.matched > 0);
  assert.deepEqual(rec.hrMatch, direct);
  assert.equal(rec.hrMatch.method, "anchor-js");
  const res = await handle(new Request("https://x/live/recent?days=14"), e, fakeCtx(), rt);
  const w = (await res.json()).workouts[0];
  assert.deepEqual(Object.keys(w), ["id", "title", "start", "end", "updatedAt", "exercises", "totals", "muscles", "strava", "hr", "status", "hrMatch"]);
  assert.deepEqual(w.hrMatch.anchor.tPeaks, direct.anchor.tPeaks);
});

test("process: pending path (no activity yet) attaches hrMatch on the cron retry", async () => {
  const fx = liveFixture();
  const e = liveEnv();
  let acts = [];
  let now = NOW;
  const rt = makeRuntime(e, { fetch: liveApis(fx, () => acts), sleep: noSleep, now: () => now });
  const rec = await processWebhook(rt, WID);
  assert.equal(rec.status, "strava-pending");
  assert.equal(rec.hrMatch, undefined);
  const p = JSON.parse(await e.LIVE.get(`p:${WID}`));
  assert.equal(p.sync.skel.exercises.length, 5);
  acts = [fx.act];
  now = NOW + 11 * 60 * 1000;
  await runCron(rt, now);
  const stored = JSON.parse(await e.LIVE.get(`w:${WID}`));
  assert.equal(stored.status, "hr-attached");
  assert.equal(stored.hrMatch.matched, matchWorkoutHr(fx.workout, JSON.parse(await e.LIVE.get("hr:777"))).matched);
});

test("process: unedited re-ingest keeps hrMatch, an edit recomputes it from the KV stream", async () => {
  const fx = liveFixture();
  const e = liveEnv();
  const rt = makeRuntime(e, { fetch: liveApis(fx, () => [fx.act]), sleep: noSleep, now: () => NOW });
  const first = await processWebhook(rt, WID);
  const again = await processWebhook(rt, WID);
  assert.deepEqual(again.hrMatch, first.hrMatch);
  // edit: drop the last exercise -> 3 fewer sets, recomputed (HR comes from KV, no second stream fetch)
  fx.workout.exercises = fx.workout.exercises.slice(0, 4);
  fx.workout.updated_at = "2026-10-08T09:30:00Z";
  const edited = await processWebhook(rt, WID);
  assert.equal(edited.hrMatch.expected, first.hrMatch.expected - 3);
});
