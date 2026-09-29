// KV layout (binding LIVE)
//   w:<id>            live workout record (the /live/recent item), TTL 20 d, metadata {start,end}
//   index             [{id,start,end}] newest first — lets /live/recent avoid KV list()
//   p:<id>            pending item {id,stage,firstAt,attempts,nextAt,lastError,sync?}, TTL 26 h
//   t:<templateId>    compact template for ids missing from templates.json
//   strava:tokens     {access_token, refresh_token, expires_at} (rotating; seeded from the secret)
//   strava:throttle   {until, reason} while Strava's rate limit is (nearly) spent
//   hr:<stravaId>     full-resolution raw HR doc (build_strength.py raw/strava_hr schema),
//                     TTL 20 d, metadata {sampleCount}; {stravaId, none:true} (TTL 6 h) when
//                     the activity has no heart-rate stream
//   meta:lastWebhookAt, meta:cron {at, pending}, meta:eventsSince, meta:eventsPollAt, meta:lastError

export const WORKOUT_TTL_S = 20 * 86400;
export const PENDING_TTL_S = 26 * 3600;
export const KEEP_DAYS = 14;
export const HR_TTL_S = 20 * 86400;
export const HR_NONE_TTL_S = 6 * 3600;

export async function getJSON(kv, key) {
  const v = await kv.get(key, "json");
  return v ?? null;
}

export async function putJSON(kv, key, value, opts) {
  await kv.put(key, JSON.stringify(value), opts);
}

// ---- workouts ---------------------------------------------------------------

export async function getWorkout(kv, id) {
  return getJSON(kv, `w:${id}`);
}

export async function putWorkout(kv, rec, now = Date.now()) {
  await putJSON(kv, `w:${rec.id}`, rec, {
    expirationTtl: WORKOUT_TTL_S,
    metadata: { start: rec.start, end: rec.end },
  });
  await indexUpsert(kv, { id: rec.id, start: rec.start, end: rec.end }, now);
}

export async function deleteWorkout(kv, id, now = Date.now()) {
  await kv.delete(`w:${id}`);
  await kv.delete(`p:${id}`);
  await indexRemove(kv, id, now);
}

// ---- full-resolution HR (hr:<stravaId>) ----------------------------------------

export async function getHr(kv, stravaId) {
  return getJSON(kv, `hr:${stravaId}`);
}

export async function putHr(kv, doc) {
  await putJSON(kv, `hr:${doc.stravaId}`, doc, {
    expirationTtl: HR_TTL_S,
    metadata: { sampleCount: doc.sampleCount },
  });
}

/** Remember "no heart-rate stream" for a while so a list/fetch does not re-ask Strava. */
export async function putHrNone(kv, stravaId) {
  await putJSON(kv, `hr:${stravaId}`, { stravaId, none: true }, {
    expirationTtl: HR_NONE_TTL_S,
    metadata: { sampleCount: 0 },
  });
}

/** {stravaId(string): sampleCount} for every cached hr:<id> (one list() instead of N gets). */
export async function hrSampleCounts(kv) {
  const out = new Map();
  let cursor;
  do {
    const page = await kv.list({ prefix: "hr:", cursor });
    for (const k of page.keys) {
      const md = k.metadata || {};
      if (Number.isFinite(Number(md.sampleCount))) out.set(k.name.slice(3), Number(md.sampleCount));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

// ---- index -----------------------------------------------------------------

function pruneSort(entries, now) {
  const cutoff = now - WORKOUT_TTL_S * 1000;
  const seen = new Set();
  return entries
    .filter((e) => e && e.id && Date.parse(e.start) >= cutoff && !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
}

export async function getIndex(kv) {
  const v = await getJSON(kv, "index");
  return Array.isArray(v) ? v : [];
}

export async function indexUpsert(kv, entry, now = Date.now()) {
  const idx = (await getIndex(kv)).filter((e) => e.id !== entry.id);
  idx.push(entry);
  await putJSON(kv, "index", pruneSort(idx, now));
}

export async function indexRemove(kv, id, now = Date.now()) {
  const idx = await getIndex(kv);
  if (!idx.some((e) => e.id === id)) return;
  await putJSON(kv, "index", pruneSort(idx.filter((e) => e.id !== id), now));
}

/** Rebuild the index from list("w:") (hourly reconcile; list() is the costly op). */
export async function indexRebuild(kv, now = Date.now()) {
  const entries = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: "w:", cursor });
    for (const k of page.keys) {
      const md = k.metadata || {};
      if (md.start) entries.push({ id: k.name.slice(2), start: md.start, end: md.end || md.start });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const next = pruneSort(entries, now);
  const cur = await getIndex(kv);
  if (JSON.stringify(cur) !== JSON.stringify(next)) await putJSON(kv, "index", next);
  return next;
}

// ---- pending ---------------------------------------------------------------

export async function listPending(kv) {
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: "p:", cursor });
    for (const k of page.keys) out.push(k.name.slice(2));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

export async function getPending(kv, id) {
  return getJSON(kv, `p:${id}`);
}

export async function putPending(kv, item) {
  await putJSON(kv, `p:${item.id}`, item, { expirationTtl: PENDING_TTL_S });
}

export async function deletePending(kv, id) {
  await kv.delete(`p:${id}`);
}

/** Next retry delay: every 10 min for the first hour, then every 30 min. */
export function nextDelayMs(attempts) {
  return (attempts < 6 ? 10 : 30) * 60 * 1000 - 60 * 1000;
}

// ---- meta ------------------------------------------------------------------

export async function recordError(kv, stage, err, now = Date.now()) {
  const message = String((err && err.message) || err).slice(0, 200);
  await putJSON(kv, "meta:lastError", { at: new Date(now).toISOString(), stage, message });
}
