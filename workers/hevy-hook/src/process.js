// Processing pipeline: Hevy workout -> live record -> Strava rename + HR.

import templates from "../templates.json" with { type: "json" };
import { buildDescription, buildName, FOOTER } from "./format.js";
import { getWorkoutById, getTemplate, getEvents } from "./hevy.js";
import { HttpError } from "./http.js";
import { matchWorkoutHr } from "./hrmatch.js";
import { activityFor, downsampleHr, hrDoc, isStrengthActivity, MATCH_TOLERANCE_MS } from "./match.js";
import {
  computeStrength, compactTemplate, unknownTemplateIds,
} from "./strength.js";
import {
  deletePending, deleteWorkout, getHr, getIndex, getJSON, getPending, getWorkout, indexRebuild,
  KEEP_DAYS, listPending, nextDelayMs, putHr, putHrNone, putJSON, putPending, putWorkout, recordError,
} from "./store.js";
import { Strava, StravaThrottled, stravaConfigured } from "./strava.js";

export const PENDING_MAX_AGE_MS = 24 * 3600 * 1000;
export const PENDING_PER_RUN = 3;
const DAY_MS = 86400 * 1000;

const iso = (ms) => new Date(ms).toISOString();

// ---- templates ---------------------------------------------------------------

/** Bundled map + KV cache + Hevy lookup for ids missing from both. */
export async function resolveTemplates(rt, workout) {
  const missing = unknownTemplateIds(workout, templates);
  if (!missing.length) return templates;
  const map = { ...templates };
  for (const id of missing) {
    let t = await getJSON(rt.env.LIVE, `t:${id}`);
    if (!t && rt.env.HEVY_API_KEY) {
      try {
        t = compactTemplate(await getTemplate(rt, id));
        await putJSON(rt.env.LIVE, `t:${id}`, t);
      } catch (e) {
        t = null; // unknown exercise -> muscle "other" (same fallback as build_strength.py)
      }
    }
    if (t) map[id] = t;
  }
  return map;
}

// ---- record ------------------------------------------------------------------

export function buildRecord(workout, tmpl, prev) {
  const { exercises, totals, muscles } = computeStrength(workout, tmpl);
  const sameStart = prev && prev.start === workout.start_time;
  const rec = {
    id: workout.id,
    title: workout.title || "",
    start: workout.start_time,
    end: workout.end_time || workout.start_time,
    updatedAt: workout.updated_at || null,
    exercises,
    totals,
    muscles,
    strava: sameStart ? prev.strava || null : null,
    hr: sameStart ? prev.hr || null : null,
    status: sameStart && prev.status ? prev.status : "received",
  };
  // an unedited re-ingest keeps its HR match; an edit drops it until syncStrava recomputes it
  if (sameStart && rec.hr && prev.hrMatch && prev.updatedAt === rec.updatedAt) rec.hrMatch = prev.hrMatch;
  return rec;
}

/** The parts of a raw Hevy workout the HR matcher reads (kept in the pending item's `sync`). */
export function hrSkeleton(workout) {
  return {
    exercises: (workout.exercises || []).map((e) => ({
      index: e.index,
      title: e.title,
      superset_id: e.superset_id ?? null,
      sets: (e.sets || []).map((s) => ({
        index: s.index, type: s.type, weight_kg: s.weight_kg ?? null, reps: s.reps ?? null, rpe: s.rpe ?? null,
      })),
    })),
  };
}

/**
 * HR-peak <-> set match (src/hrmatch.js, port of build_strength.py) on the
 * full-resolution stream -> rec.hrMatch.  `doc` = the raw HR doc just built from
 * Strava, else the cached KV hr:<stravaId>.  Omitted when no set matches; a
 * matcher failure is logged and never blocks the pipeline.
 *
 * The run time goes to KV meta:hrMatchLast {ms, at, workoutId, samples, sets} for
 * /admin/status (hrMatchMsLast): the matcher is the Worker's heaviest CPU step and the
 * free plan allows 10 ms CPU per invocation.  Caveat: the Workers runtime advances
 * performance.now() / Date.now() only at I/O, so a pure-CPU run can read ~0 ms there;
 * Observability's per-invocation CPU time is the authoritative number.
 */
const clockMs = () => (globalThis.performance && typeof performance.now === "function" ? performance.now() : Date.now());

async function attachHrMatch(rt, rec, skel, stravaId, doc) {
  const kv = rt.env.LIVE;
  try {
    const d = doc || (await getHr(kv, stravaId));
    if (!d || d.none) return;
    const t0 = clockMs();
    const hm = matchWorkoutHr(skel, d);
    const ms = Math.round((clockMs() - t0) * 100) / 100;
    try {
      await putJSON(kv, "meta:hrMatchLast", {
        ms, at: new Date(rt.now()).toISOString(), workoutId: rec.id,
        samples: Array.isArray(d.timestamps) ? d.timestamps.length : null, sets: hm ? hm.expected : null,
      });
    } catch { /* diagnostics only */ }
    if (hm && hm.matched > 0) rec.hrMatch = hm;
    else delete rec.hrMatch;
  } catch (e) {
    delete rec.hrMatch;
    await recordError(kv, "hrmatch", e, rt.now());
  }
}

function statusOf(rec) {
  if (rec.hr) return "hr-attached";
  if (rec.strava) return "strava-renamed";
  return rec.status === "strava-pending" ? "strava-pending" : "received";
}

// ---- Strava ------------------------------------------------------------------

/**
 * Match, rename + describe, attach HR.  Returns "done" | "pending".
 * Mutates rec (strava / hr / status); the caller persists it.
 */
export async function syncStrava(rt, rec, sync, strava) {
  const kv = rt.env.LIVE;
  const start = Date.parse(rec.start);
  const end = Date.parse(rec.end);
  let act = null;

  if (rec.strava && rec.strava.id) {
    try {
      act = await strava.getActivity(rec.strava.id);
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 404)) throw e;
      rec.strava = null;
      rec.hr = null;
      delete rec.hrMatch;
    }
  }
  if (!act) {
    const acts = ((await strava.listActivities(start - 6 * 3600 * 1000, end + MATCH_TOLERANCE_MS)) || [])
      .filter(isStrengthActivity);
    // other live workouts in the window compete for the same activities (1:1 like strava_sync.py)
    const idx = await getIndex(kv);
    const workouts = [{ id: rec.id, start_time: rec.start, end_time: rec.end }];
    for (const e of idx) {
      if (e.id !== rec.id) workouts.push({ id: e.id, start_time: e.start, end_time: e.end });
    }
    const match = activityFor(rec.id, acts, workouts);
    if (!match) {
      rec.status = "strava-pending";
      return "pending";
    }
    act = await strava.getActivity(match.id);
  }

  const curName = act.name || "";
  const curDesc = act.description || "";
  const identical = curDesc.includes(FOOTER) && curName === sync.name && curDesc.trim() === sync.description.trim();
  let renamedAt = rec.strava && rec.strava.id === act.id ? rec.strava.renamedAt : null;
  if (!identical) {
    await strava.updateActivity(act.id, sync.name, sync.description);
    renamedAt = iso(rt.now());
  } else if (!renamedAt) {
    renamedAt = iso(rt.now());
  }
  rec.strava = { id: act.id, name: sync.name, renamedAt };

  let doc = null;
  if (!rec.hr) {
    const streams = await strava.getStreams(act.id);
    rec.hr = streams ? downsampleHr(streams, act.start_date) : null;
    // full-resolution copy for the morning pipeline (GET /live/hr/<stravaId>)
    doc = streams ? hrDoc({ ...act, name: sync.name }, streams) : null;
    if (doc) await putHr(kv, doc);
    else await putHrNone(kv, act.id);
  }
  if (!rec.hr) delete rec.hrMatch;
  else if (sync.skel) await attachHrMatch(rt, rec, sync.skel, act.id, doc);
  rec.status = statusOf(rec);
  return "done";
}

async function enqueue(rt, rec, stage, sync, prevPending, err) {
  const now = rt.now();
  const p = prevPending || { id: rec.id, firstAt: now, attempts: 0 };
  p.stage = stage;
  p.attempts = (p.attempts || 0) + (prevPending ? 1 : 0);
  p.nextAt = now + nextDelayMs(p.attempts);
  p.lastError = err ? String(err.message || err).slice(0, 200) : null;
  if (sync) p.sync = sync;
  await putPending(rt.env.LIVE, p);
}

/**
 * Store the record for a raw Hevy workout and try Strava.
 * Used by the webhook (after the Hevy fetch), the events poll and the cron.
 */
export async function ingestWorkout(rt, workout, { prevPending = null, strava = null, tryStrava = true } = {}) {
  const kv = rt.env.LIVE;
  const prev = await getWorkout(kv, workout.id);
  const tmpl = await resolveTemplates(rt, workout);
  const rec = buildRecord(workout, tmpl, prev);
  const sync = { name: buildName(workout), description: buildDescription(workout), skel: hrSkeleton(workout) };
  await putWorkout(kv, rec, rt.now());
  if (!tryStrava) {
    await enqueue(rt, rec, "strava", sync, prevPending, null);
    return rec;
  }
  return stravaStep(rt, rec, sync, prevPending, strava);
}

async function stravaStep(rt, rec, sync, prevPending, strava) {
  const kv = rt.env.LIVE;
  if (!stravaConfigured(rt.env)) {
    rec.status = statusOf(rec);
    await putWorkout(kv, rec, rt.now());
    await enqueue(rt, rec, "strava", sync, prevPending, "Strava secrets not configured");
    return rec;
  }
  let outcome;
  let err = null;
  try {
    outcome = await syncStrava(rt, rec, sync, strava || new Strava(rt));
  } catch (e) {
    err = e;
    outcome = "pending";
    if (!(e instanceof StravaThrottled)) await recordError(kv, "strava", e, rt.now());
    if (!rec.strava) rec.status = "strava-pending";
  }
  await putWorkout(kv, rec, rt.now());
  if (outcome === "done") await deletePending(kv, rec.id);
  else await enqueue(rt, rec, "strava", sync, prevPending, err || "no matching Strava activity yet");
  return rec;
}

/** Webhook path: fetch the workout from Hevy, then ingest. */
export async function processWebhook(rt, workoutId) {
  const kv = rt.env.LIVE;
  let workout;
  try {
    workout = await getWorkoutById(rt, workoutId);
  } catch (e) {
    await recordError(kv, "hevy", e, rt.now());
    const prevPending = await getPending(kv, workoutId);
    const p = prevPending || { id: workoutId, firstAt: rt.now(), attempts: 0 };
    p.stage = "hevy";
    p.attempts = (p.attempts || 0) + (prevPending ? 1 : 0);
    p.nextAt = rt.now() + nextDelayMs(p.attempts);
    p.lastError = String(e.message || e).slice(0, 200);
    await putPending(kv, p);
    return null;
  }
  const prevPending = await getPending(kv, workoutId);
  return ingestWorkout(rt, workout, { prevPending });
}

// ---- cron ----------------------------------------------------------------------

async function givenUp(rt, p) {
  const kv = rt.env.LIVE;
  await deletePending(kv, p.id);
  const rec = await getWorkout(kv, p.id);
  if (rec && rec.status === "strava-pending") {
    rec.status = statusOf({ ...rec, status: "received" });
    await putWorkout(kv, rec, rt.now());
  }
}

export async function processPending(rt) {
  const kv = rt.env.LIVE;
  const now = rt.now();
  const ids = await listPending(kv);
  let done = 0;
  let strava = null;
  for (const id of ids) {
    const p = await getPending(kv, id);
    if (!p) continue;
    if (now - Number(p.firstAt || now) > PENDING_MAX_AGE_MS) {
      await givenUp(rt, p);
      continue;
    }
    if (Number(p.nextAt || 0) > now || done >= PENDING_PER_RUN) continue;
    if (p.stage === "hevy") {
      if (!rt.env.HEVY_API_KEY) continue;
      done += 1;
      await processWebhook(rt, id);
      continue;
    }
    // stage "strava"
    if (!stravaConfigured(rt.env)) continue;
    const rec = await getWorkout(kv, id);
    if (!rec || !p.sync) {
      await deletePending(kv, id);
      continue;
    }
    done += 1;
    strava = strava || new Strava(rt);
    try {
      await strava.checkThrottle();
    } catch (e) {
      break; // paused: leave everything pending
    }
    await stravaStep(rt, rec, p.sync, p, strava);
  }
  return (await listPending(kv)).length;
}

/** Hourly safety net: GET /v1/workouts/events?since=… (new/edited + deletions). */
export async function pollEvents(rt) {
  const kv = rt.env.LIVE;
  const now = rt.now();
  const cutoff = now - KEEP_DAYS * DAY_MS;
  const since = (await getJSON(kv, "meta:eventsSince")) || iso(cutoff).replace(/\.\d{3}Z$/, "Z");
  const { updated, deleted } = await getEvents(rt, since);
  let ingested = 0;
  for (const id of deleted) await deleteWorkout(kv, id, now);
  for (const w of updated) {
    if (!w.start_time || Date.parse(w.start_time) < cutoff) continue;
    const prev = await getWorkout(kv, w.id);
    if (prev && prev.updatedAt && w.updated_at && Date.parse(w.updated_at) <= Date.parse(prev.updatedAt)) continue;
    const prevPending = await getPending(kv, w.id);
    // store now; Strava work is queued so one cron run stays within subrequest limits
    await ingestWorkout(rt, w, { prevPending, tryStrava: false });
    ingested += 1;
  }
  await putJSON(kv, "meta:eventsSince", iso(now - 5 * 60 * 1000).replace(/\.\d{3}Z$/, "Z"));
  await putJSON(kv, "meta:eventsPollAt", now);
  await indexRebuild(kv, now);
  return { ingested, deleted: deleted.length };
}

export async function runCron(rt, scheduledTime) {
  const kv = rt.env.LIVE;
  const now = rt.now();
  let events = null;
  if (rt.env.HEVY_API_KEY) {
    const last = Number((await getJSON(kv, "meta:eventsPollAt")) || 0);
    const minute = new Date(scheduledTime || now).getUTCMinutes();
    // Hevy asks API users not to poll at xx:00 -> the :10 slot normally runs it
    if (now - last >= 55 * 60 * 1000 && minute !== 0) {
      try {
        events = await pollEvents(rt);
      } catch (e) {
        await recordError(kv, "events", e, now);
      }
    }
  }
  let pending = 0;
  try {
    pending = await processPending(rt);
  } catch (e) {
    await recordError(kv, "pending", e, now);
    pending = (await listPending(kv)).length;
  }
  await putJSON(kv, "meta:cron", { at: iso(now), pending });
  return { pending, events };
}
