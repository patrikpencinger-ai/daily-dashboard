// Hevy API client (GET only). Retries 429 / 5xx / network errors with backoff
// like tools/strava_sync.py _hevy_get (Retry-After honoured, else 2, 4, 6 s),
// capped so a Worker invocation never waits more than ~20 s in total.

import { fetchRetry, HttpError } from "./http.js";

export const HEVY_API = "https://api.hevyapp.com/v1";
export const HEVY_ATTEMPTS = 4;

export async function hevyGet(rt, path, params) {
  const key = rt.env.HEVY_API_KEY;
  if (!key) throw new HttpError(0, "HEVY_API_KEY not configured");
  const url = new URL(HEVY_API + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
  const resp = await fetchRetry(
    url.toString(),
    { headers: { "api-key": key, Accept: "application/json", "User-Agent": "hevy-hook/1.0" } },
    { attempts: HEVY_ATTEMPTS, maxWaitS: 8, fetchImpl: rt.fetch, sleep: rt.sleep },
  );
  if (!resp.ok) {
    const text = (await resp.text().catch(() => "")).slice(0, 160).replace(/\s+/g, " ");
    throw new HttpError(resp.status, `Hevy ${path.split("/").slice(0, 3).join("/")}: ${text}`);
  }
  return resp.json();
}

export const getWorkoutById = (rt, id) => hevyGet(rt, `/workouts/${encodeURIComponent(id)}`);

export const getTemplate = (rt, id) => hevyGet(rt, `/exercise_templates/${encodeURIComponent(id)}`);

/** GET /v1/workouts/events?since=… (all pages, capped) -> {updated:[workout], deleted:[id]}. */
export async function getEvents(rt, sinceIso, maxPages = 10) {
  const updated = new Map();
  const deleted = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const d = await hevyGet(rt, "/workouts/events", { page, pageSize: 10, since: sinceIso });
    const evs = (d && d.events) || [];
    for (const ev of evs) {
      if (ev.type === "deleted") {
        const id = ev.id || (ev.workout && ev.workout.id);
        if (id) deleted.add(id);
      } else if (ev.type === "updated" && ev.workout && ev.workout.id) {
        const w = ev.workout;
        const prev = updated.get(w.id);
        if (!prev || Date.parse(w.updated_at) > Date.parse(prev.updated_at)) updated.set(w.id, w);
      }
    }
    if (!evs.length || page >= Number((d && d.page_count) || page)) break;
  }
  for (const id of deleted) updated.delete(id);
  return { updated: [...updated.values()], deleted: [...deleted] };
}

/**
 * Workouts newest-first until a page is entirely older than sinceMs - tolMs
 * (port of tools/strava_sync.py hevy_from_api).
 */
export async function listWorkoutsSince(rt, sinceMs, tolMs, maxPages = 10) {
  const out = [];
  const cutoff = sinceMs - tolMs;
  for (let page = 1; page <= maxPages; page++) {
    const d = await hevyGet(rt, "/workouts", { page, pageSize: 10 });
    const ws = (d && d.workouts) || [];
    out.push(...ws);
    if (!ws.length || page >= Number((d && d.page_count) || page)) break;
    if (ws.every((w) => Date.parse(w.start_time) < cutoff)) break;
  }
  return out;
}
