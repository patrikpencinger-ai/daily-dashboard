#!/usr/bin/env node
// Parity check: src/hrmatch.js (JS port) vs tools/build_strength.py (reference).
//
// Loads every session from the local strength caches exactly as build_strength.py
// pairs them (load_hr_sessions: raw/strava_hr preferred over a raw/garmin_hr twin
// within 120 s; load_hevy: duplicate ids -> newest updated_at, times from an
// HR-overlapping copy when the newest overlaps none; join by date, best overlap),
// runs the JS matcher and compares each set with strength-data.json setRows.
//
//   node scripts/parity-hrmatch.mjs [--raw-dir DIR] [--ref strength-data.json] [--json OUT.json]
//
// A set is "identical" when tPeak is within ±1 s, peakHR is equal and conf is
// within ±0.02 (null-ness must agree).  Also reported: exact equality of every
// per-set field, anchor equality (tPeaks) and per-session runtime.
// Exit 0 when identical % >= 99, else 1.  Node >= 20, no dependencies.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { CONFIG, matchWorkoutHr } from "../src/hrmatch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const HR_SAME_ACTIVITY_S = 120;
const FIELDS = ["tPeak", "peakHR", "tStart", "hrStart", "riseS", "hrDelta", "restBeforeS", "hrr30", "hrr60",
  "conf", "nearArtifact", "steepRise", "shortRest"];

function args() {
  const a = process.argv.slice(2);
  const get = (k, d) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : d;
  };
  const cache = process.env.ZG_CACHE || join(homedir(), ".claude", "cache", "daily-dashboard");
  return {
    rawDir: get("--raw-dir", join(cache, "strength", "raw")),
    ref: get("--ref", join(REPO, "strength-data.json")),
    json: get("--json", null),
  };
}

const loadJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const listJson = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []);
const ms = (s) => Date.parse(s);

function loadHrDir(rawDir, sub, source) {
  const dir = join(rawDir, sub);
  return listJson(dir).map((f) => {
    const d = loadJson(join(dir, f));
    const name = basename(f, ".json");
    const us = name.indexOf("_");
    const date = us >= 0 ? name.slice(0, us) : name;
    const act = us >= 0 ? name.slice(us + 1) : "";
    const st = ms(d.startTime);
    const ts = d.timestamps || [];
    return { date, activityId: act, start: st, end: st + 1000 * (ts.length ? ts[ts.length - 1] : 0), doc: d, file: name, source };
  });
}

function loadHrSessions(rawDir) {
  const strava = loadHrDir(rawDir, "strava_hr", "strava");
  const garmin = loadHrDir(rawDir, "garmin_hr", "garmin")
    .filter((g) => !strava.some((s) => Math.abs(g.start - s.start) / 1000 <= HR_SAME_ACTIVITY_S));
  // sorted by (date, start); Python compares datetimes, ms epoch is equivalent
  return [...strava, ...garmin].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start));
}

function overlapFrac(w, sessions) {
  const s = ms(w.start_time);
  const e = ms(w.end_time);
  const dur = Math.max((e - s) / 1000, 1);
  let best = 0.0;
  for (const h of sessions) {
    const ov = (Math.min(e, h.end) - Math.max(s, h.start)) / 1000;
    best = Math.max(best, ov / dur);
  }
  return best;
}

function loadHevy(rawDir, hrSessions) {
  const dir = join(rawDir, "hevy");
  const byId = new Map();
  for (const f of listJson(dir)) {
    const d = loadJson(join(dir, f));
    d._file = f;
    if (!byId.has(d.id)) byId.set(d.id, []);
    byId.get(d.id).push(d);
  }
  const chosen = [];
  for (const copies of byId.values()) {
    if (copies.length === 1) {
      chosen.push(copies[0]);
      continue;
    }
    copies.sort((a, b) => {   // newest updated_at first (stable, like sorted(reverse=True))
      const ua = a.updated_at || "";
      const ub = b.updated_at || "";
      return ua < ub ? 1 : ua > ub ? -1 : 0;
    });
    let win = copies[0];
    if (overlapFrac(win, hrSessions) <= 0) {
      let alt = copies[1];
      for (const c of copies.slice(2)) if (overlapFrac(c, hrSessions) > overlapFrac(alt, hrSessions)) alt = c;
      if (overlapFrac(alt, hrSessions) > 0) win = { ...win, start_time: alt.start_time, end_time: alt.end_time };
    }
    chosen.push(win);
  }
  chosen.sort((a, b) => (a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : 0));
  return chosen;
}

function pair(rawDir) {
  const hr = loadHrSessions(rawDir);
  const workouts = loadHevy(rawDir, hr);
  const byDate = new Map();
  for (const w of workouts) {
    const d = w.start_time.slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(w);
  }
  const hrFor = new Map();
  for (const h of hr) {
    const cands = (byDate.get(h.date) || []).filter((w) => !hrFor.has(w.id));
    if (!cands.length) continue;
    const scored = cands.map((w, i) => [overlapFrac(w, [h]), i, w]);
    scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    hrFor.set(scored[0][2].id, h);
  }
  return { workouts, hrFor, hrCount: hr.length };
}

const fmt = (v) => (v === undefined ? "-" : JSON.stringify(v));

function main() {
  const a = args();
  const ref = loadJson(a.ref);
  const refById = new Map(ref.workouts.map((w) => [w.id, w]));
  const { workouts, hrFor, hrCount } = pair(a.rawDir);

  let sessions = 0;
  let setsCompared = 0;
  let identical = 0;
  let allFieldsExact = 0;
  let anchorsCompared = 0;
  let anchorsEqual = 0;
  let skippedNoRef = 0;
  const mismatches = [];
  const fieldDiffs = {};
  const anchorDiffs = [];
  const times = [];

  for (const w of workouts) {
    const h = hrFor.get(w.id);
    if (!h) continue;
    const rw = refById.get(w.id);
    if (!rw || !rw.match) {
      skippedNoRef += 1;
      continue;
    }
    const t0 = performance.now();
    const hm = matchWorkoutHr(w, h.doc, CONFIG);
    const dt = performance.now() - t0;
    times.push([dt, rw.date, w.title]);
    sessions += 1;
    const exTitle = new Map((w.exercises || []).map((e) => [e.index, e.title]));
    const rows = rw.setRows;
    const js = hm ? hm.sets : [];
    if (js.length !== rows.length) {
      mismatches.push({ date: rw.date, title: w.title, issue: `set count js=${js.length} py=${rows.length}` });
    }
    for (let k = 0; k < Math.min(js.length, rows.length); k++) {
      const p = rows[k];
      const j = js[k];
      setsCompared += 1;
      const tOk = (p.tPeak ?? null) === null ? j.tPeak === null : j.tPeak !== null && Math.abs(j.tPeak - p.tPeak) <= 1;
      const hrOk = (p.peakHR ?? null) === (j.peakHR ?? null);
      const cOk = Math.abs((j.conf ?? 0) - (p.conf ?? 0)) <= 0.02 + 1e-9;
      const keyOk = j.ex === p.ex && j.set === p.set;
      if (tOk && hrOk && cOk && keyOk) identical += 1;
      else {
        mismatches.push({
          date: rw.date, title: w.title, exercise: exTitle.get(p.ex), ex: p.ex, set: p.set,
          js: { tPeak: j.tPeak, peakHR: j.peakHR, conf: j.conf }, py: { tPeak: p.tPeak ?? null, peakHR: p.peakHR ?? null, conf: p.conf ?? null },
        });
      }
      let exact = keyOk;
      for (const f of FIELDS) {
        const pv = p[f] === undefined ? (["nearArtifact", "steepRise", "shortRest"].includes(f) ? undefined : null) : p[f];
        const jv = j[f];
        if (JSON.stringify(pv) !== JSON.stringify(jv)) {
          exact = false;
          fieldDiffs[f] = (fieldDiffs[f] || 0) + 1;
        }
      }
      if (exact) allFieldsExact += 1;
    }
    const pa = rw.match.anchor;
    const ja = hm && hm.anchor;
    anchorsCompared += 1;
    if (JSON.stringify(pa ? pa.tPeaks : null) === JSON.stringify(ja ? ja.tPeaks : null)
      && JSON.stringify(pa ? pa.peakHR : null) === JSON.stringify(ja ? ja.peakHR : null)) anchorsEqual += 1;
    else anchorDiffs.push({ date: rw.date, title: w.title, js: ja && ja.tPeaks, py: pa && pa.tPeaks });
  }

  times.sort((x, y) => y[0] - x[0]);
  const tot = times.reduce((s, x) => s + x[0], 0);
  const pct = setsCompared ? (100 * identical) / setsCompared : 0;
  const summary = {
    rawDir: a.rawDir, ref: a.ref, hrSessionsInCache: hrCount, sessions, skippedNoRef,
    setsCompared, identical, identicalPct: Number(pct.toFixed(2)),
    allFieldsExact, allFieldsExactPct: Number(((100 * allFieldsExact) / Math.max(1, setsCompared)).toFixed(2)),
    fieldDiffs, anchorsCompared, anchorsEqual,
    msPerSession: { mean: Number((tot / Math.max(1, times.length)).toFixed(1)), max: Number((times[0] ? times[0][0] : 0).toFixed(1)), maxSession: times[0] ? times[0][1] : null },
  };
  console.log("parity hrmatch.js vs build_strength.py");
  console.log(`  sessions ${sessions} (hr files ${hrCount}, skipped without ref match ${skippedNoRef})`);
  console.log(`  sets compared ${setsCompared}, identical ${identical} (${summary.identicalPct} %)  [tPeak ±1 s, peakHR ==, conf ±0.02]`);
  console.log(`  all per-set fields exact ${allFieldsExact} (${summary.allFieldsExactPct} %)  field diffs ${JSON.stringify(fieldDiffs)}`);
  console.log(`  anchors equal ${anchorsEqual}/${anchorsCompared}`);
  console.log(`  runtime per session: mean ${summary.msPerSession.mean} ms, max ${summary.msPerSession.max} ms (${summary.msPerSession.maxSession})`);
  console.log(`  mismatches: ${mismatches.length}`);
  for (const m of mismatches) {
    if (m.issue) console.log(`    ${m.date} ${m.title}: ${m.issue}`);
    else console.log(`    ${m.date} ${m.exercise} [ex ${m.ex} set ${m.set}]  js tPeak=${fmt(m.js.tPeak)} peakHR=${fmt(m.js.peakHR)} conf=${fmt(m.js.conf)} | py tPeak=${fmt(m.py.tPeak)} peakHR=${fmt(m.py.peakHR)} conf=${fmt(m.py.conf)}`);
  }
  for (const d of anchorDiffs) console.log(`    anchor ${d.date} ${d.title}: js ${fmt(d.js)} | py ${fmt(d.py)}`);
  if (a.json) writeFileSync(a.json, JSON.stringify({ summary, mismatches, anchorDiffs, times }, null, 1));
  process.exitCode = pct >= 99 ? 0 : 1;
}

main();
