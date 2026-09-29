// Authenticated local-pipeline API. The Worker is the ONLY Strava API client
// (single owner of the rotating refresh token in KV strava:tokens); the local
// tools/strava_sync.py reaches Strava through these endpoints.
//
//   GET  /live/hr?since=YYYY-MM-DD   [{stravaId, name, startTime, startDateLocal, workoutId|null, sampleCount|null}]
//   GET  /live/hr/<stravaId>         raw/strava_hr doc (build_strength.py schema), cached in KV hr:<id>
//   POST /live/strava/sync?days=N    rename/description pass of `strava_sync.py sync` (dryRun=1, force=1)
//
// All three require Authorization == WEBHOOK_AUTH (constant-time, see http.js).
// Errors: 400 bad input, 404 unknown / no HR stream, 502 upstream error,
// 503 {code:"not-configured"|"strava-auth"|"rate-limited"} (+ Retry-After when rate-limited).

import { buildDescription, buildName, FOOTER } from "./format.js";
import { listWorkoutsSince } from "./hevy.js";
import { HttpError, json } from "./http.js";
import { hrDoc, isStrengthActivity, matchActivities, MATCH_TOLERANCE_MS } from "./match.js";
import { getHr, getIndex, hrSampleCounts, putHr, putHrNone } from "./store.js";
import { Strava, StravaAuthError, StravaThrottled, stravaConfigured } from "./strava.js";

const DAY_MS = 86400 * 1000;
export const SYNC_MAX_DAYS = 30;
export const SYNC_MAX_DETAILS = 25; // activity detail GETs per call (keeps one call inside subrequest limits)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STRAVA_ID_RE = /^\d{1,20}$/;

const utcIso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, ".000Z");

/** Map a thrown error to the JSON error response (no secrets in any message). */
export function errorResponse(e) {
  if (e instanceof StravaThrottled) {
    const retryS = Math.max(1, Math.ceil((e.until - Date.now()) / 1000));
    return json({ ok: false, code: "rate-limited", error: e.message, retryAt: new Date(e.until).toISOString() },
      503, { "Retry-After": String(retryS) });
  }
  if (e instanceof StravaAuthError) {
    const notConfigured = /not configured/.test(e.message);
    return json({ ok: false, code: notConfigured ? "not-configured" : "strava-auth", error: e.message }, 503);
  }
  if (e instanceof HttpError) {
    return json({ ok: false, code: "upstream", error: e.message.slice(0, 200) }, 502);
  }
  console.error("api failed", String(e && e.message ? e.message : e));
  return json({ ok: false, code: "internal", error: "internal error" }, 500);
}

function notConfigured(missing) {
  return json({ ok: false, code: "not-configured", error: `Worker secrets missing: ${missing.join(", ")}`, missing }, 503);
}

function missingStrava(env) {
  return ["STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET", "STRAVA_REFRESH_TOKEN"].filter((n) => !env[n]);
}

// ---- GET /live/hr?since= -------------------------------------------------------

export async function hrList(rt, url) {
  const since = url.searchParams.get("since") || "";
  if (!DATE_RE.test(since) || Number.isNaN(Date.parse(`${since}T00:00:00Z`))) {
    return json({ ok: false, code: "bad-request", error: "since must be YYYY-MM-DD" }, 400);
  }
  if (!stravaConfigured(rt.env)) return notConfigured(missingStrava(rt.env));
  const sinceMs = Date.parse(`${since}T00:00:00Z`);
  const strava = new Strava(rt);
  const acts = (await strava.listActivitiesSince(sinceMs)).filter(isStrengthActivity);
  acts.sort((a, b) => Date.parse(a.start_date) - Date.parse(b.start_date));

  // workoutId: same time-overlap matching as the webhook path, against the live index
  const idx = await getIndex(rt.env.LIVE);
  const workouts = idx.map((e) => ({ id: e.id, start_time: e.start, end_time: e.end }));
  const pairs = matchActivities(acts, workouts);
  const counts = await hrSampleCounts(rt.env.LIVE);

  return json(pairs.map(([a, w]) => ({
    stravaId: a.id,
    name: a.name || "",
    startTime: utcIso(Date.parse(a.start_date)),
    startDateLocal: a.start_date_local || null,
    workoutId: w ? w.id : null,
    sampleCount: counts.has(String(a.id)) ? counts.get(String(a.id)) : null,
  })), 200, { "Cache-Control": "no-store" });
}

// ---- GET /live/hr/<stravaId> ---------------------------------------------------

export async function hrOne(rt, id) {
  if (!STRAVA_ID_RE.test(id)) return json({ ok: false, code: "bad-request", error: "bad Strava id" }, 400);
  const kv = rt.env.LIVE;
  const cached = await getHr(kv, id);
  if (cached && cached.none) {
    return json({ ok: false, code: "no-hr", error: "activity has no heart-rate stream", stravaId: Number(id) }, 404);
  }
  if (cached) return json(cached, 200, { "Cache-Control": "no-store" });
  if (!stravaConfigured(rt.env)) return notConfigured(missingStrava(rt.env));

  const strava = new Strava(rt);
  let act;
  try {
    act = await strava.getActivity(id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      return json({ ok: false, code: "not-found", error: "no such Strava activity" }, 404);
    }
    throw e;
  }
  if (!act || !isStrengthActivity(act)) {
    return json({ ok: false, code: "not-found", error: "not a WeightTraining/Workout activity" }, 404);
  }
  const streams = await strava.getStreams(act.id);
  const doc = streams ? hrDoc(act, streams) : null;
  if (!doc) {
    await putHrNone(kv, act.id);
    return json({ ok: false, code: "no-hr", error: "activity has no heart-rate stream", stravaId: act.id }, 404);
  }
  await putHr(kv, doc);
  return json(doc, 200, { "Cache-Control": "no-store" });
}

// ---- POST /live/strava/sync?days=N ----------------------------------------------

const flag = (url, name) => ["1", "true", "yes"].includes(String(url.searchParams.get(name) || "").toLowerCase());

/** The `strava_sync.py sync` pass: Strava strength activities in the window <-> Hevy workouts,
 *  rename + description unless the description already carries our footer (or force). */
export async function stravaSync(rt, url) {
  let days = Number.parseInt(url.searchParams.get("days") || "3", 10);
  if (!Number.isFinite(days)) days = 3;
  days = Math.min(SYNC_MAX_DAYS, Math.max(1, days));
  const dryRun = flag(url, "dryRun");
  const force = flag(url, "force");

  const missing = missingStrava(rt.env);
  if (!rt.env.HEVY_API_KEY) missing.unshift("HEVY_API_KEY");
  if (missing.length) return notConfigured(missing);

  const now = rt.now();
  const sinceMs = now - days * DAY_MS;
  const strava = new Strava(rt);
  const acts = (await strava.listActivitiesSince(sinceMs)).filter(isStrengthActivity);
  const out = {
    ok: true, dryRun, force, days, since: utcIso(sinceMs),
    activities: acts.length, workouts: 0,
    updated: 0, skipped: 0, unchanged: 0, unmatched: 0, deferred: 0, items: [],
  };
  if (!acts.length) return json(out);

  const workouts = await listWorkoutsSince(rt, sinceMs, MATCH_TOLERANCE_MS);
  out.workouts = workouts.length;
  let details = 0;
  for (const [act, w] of matchActivities(acts, workouts)) {
    const item = { stravaId: act.id, start: act.start_date, name: act.name || "" };
    if (!w) {
      out.unmatched += 1;
      out.items.push({ ...item, action: "no-match" });
      continue;
    }
    if (details >= SYNC_MAX_DETAILS) {
      out.deferred += 1;
      out.items.push({ ...item, action: "deferred", workoutId: w.id });
      continue;
    }
    details += 1;
    const newName = buildName(w);
    const newDesc = buildDescription(w);
    const detail = await strava.getActivity(act.id);
    const curName = (detail && detail.name) || "";
    const curDesc = (detail && detail.description) || "";
    if (curDesc.includes(FOOTER) && !force) {
      out.skipped += 1;
      out.items.push({ ...item, action: "skip-synced", workoutId: w.id });
      continue;
    }
    if (curName === newName && curDesc.trim() === newDesc.trim()) {
      out.unchanged += 1;
      out.items.push({ ...item, action: "unchanged", workoutId: w.id });
      continue;
    }
    out.updated += 1;
    out.items.push({ ...item, action: dryRun ? "would-update" : "updated", workoutId: w.id, newName });
    if (!dryRun) await strava.updateActivity(act.id, newName, newDesc);
  }
  return json(out);
}
