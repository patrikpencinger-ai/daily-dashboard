// Strava activity <-> Hevy workout matching (port of tools/strava_sync.py
// match_activities; tolerance widened to ±90 min per the live contract because
// the watch activity starts ~20 min before the Hevy workout) and the 5 s HR
// downsample of a Strava time/heartrate stream.

export const STRENGTH_SPORTS = new Set(["WeightTraining", "Workout"]);
export const MATCH_TOLERANCE_MS = 90 * 60 * 1000;

export function parseTs(value) {
  const ms = Date.parse(String(value));
  if (Number.isNaN(ms)) throw new Error(`bad timestamp: ${value}`);
  return ms;
}

export function workoutSpan(w) {
  const start = parseTs(w.start_time);
  const end = w.end_time ? parseTs(w.end_time) : start;
  return [start, Math.max(start, end)];
}

export function isStrengthActivity(a) {
  return STRENGTH_SPORTS.has(a.sport_type || a.type);
}

/** Pair each Strava activity with at most one Hevy workout (closest start
 *  wins) whose tolerance-widened span overlaps the activity's span.
 *  Returns [[activity, workout|null], ...] in activity order. */
export function matchActivities(activities, workouts, tolMs = MATCH_TOLERANCE_MS) {
  const pairs = [];
  activities.forEach((a, ai) => {
    const a0 = parseTs(a.start_date);
    const a1 = a0 + 1000 * Math.trunc(Number(a.elapsed_time || a.moving_time || 0));
    workouts.forEach((w, wi) => {
      const [w0, w1] = workoutSpan(w);
      if (a0 <= w1 + tolMs && w0 - tolMs <= a1) pairs.push([Math.abs(a0 - w0) / 1000, ai, wi]);
    });
  });
  pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  const usedA = new Set();
  const usedW = new Set();
  const result = new Map();
  for (const [, ai, wi] of pairs) {
    if (usedA.has(ai) || usedW.has(wi)) continue;
    usedA.add(ai);
    usedW.add(wi);
    result.set(ai, workouts[wi]);
  }
  return activities.map((a, i) => [a, result.get(i) || null]);
}

/** The activity matched to workout `id` (or null). */
export function activityFor(id, activities, workouts, tolMs = MATCH_TOLERANCE_MS) {
  for (const [a, w] of matchActivities(activities, workouts, tolMs)) {
    if (w && w.id === id) return a;
  }
  return null;
}

/**
 * Strava streams (key_by_type=true) -> {startTime, t:[s], v:[bpm]} averaged
 * into `step`-second bins (bin start time, mean bpm rounded to an integer).
 * null when there is no usable heart-rate stream (same rule as hr_cache_doc).
 */
export function downsampleHr(streams, startDate, step = 5) {
  const hr = streams && streams.heartrate && streams.heartrate.data;
  const tm = streams && streams.time && streams.time.data;
  if (!hr || !tm || !hr.length || hr.length !== tm.length) return null;
  const bins = new Map();
  for (let i = 0; i < tm.length; i++) {
    const t = Number(tm[i]);
    const v = Number(hr[i]);
    if (!Number.isFinite(t) || !Number.isFinite(v) || v <= 0) continue;
    const b = Math.floor(t / step) * step;
    const cur = bins.get(b);
    if (cur) {
      cur[0] += v;
      cur[1] += 1;
    } else bins.set(b, [v, 1]);
  }
  if (!bins.size) return null;
  const keys = [...bins.keys()].sort((a, b) => a - b);
  return {
    startTime: new Date(parseTs(startDate)).toISOString(),
    t: keys,
    v: keys.map((k) => Math.round(bins.get(k)[0] / bins.get(k)[1])),
  };
}

/**
 * Strava activity + streams (key_by_type=true) -> the full-resolution raw HR
 * doc that tools/build_strength.py reads from raw/strava_hr — a 1:1 port of
 * tools/strava_sync.py hr_cache_doc (same keys, same order, startTime with
 * ".000Z"). null when there is no usable heart-rate stream.
 */
export function hrDoc(act, streams) {
  const hr = streams && streams.heartrate && streams.heartrate.data;
  const tm = streams && streams.time && streams.time.data;
  if (!hr || !tm || !hr.length || hr.length !== tm.length) return null;
  const start = new Date(Math.floor(parseTs(act.start_date) / 1000) * 1000).toISOString();
  return {
    startTime: start.replace(/\.\d{3}Z$/, ".000Z"),
    sampleCount: hr.length,
    streams: { heart_rate: { unit: "bpm", values: hr } },
    timestamps: tm,
    source: "strava",
    stravaId: act.id,
    name: act.name || "",
  };
}
