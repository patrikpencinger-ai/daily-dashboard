// hevy-hook — Cloudflare Worker that receives Hevy webhooks and serves a live
// preview of recent workouts to the dashboard. Contract: .foreman/live-contract.md
//
//   POST /hook/hevy     Hevy webhook (Authorization == WEBHOOK_AUTH), 200 fast, work in waitUntil
//   GET  /live/recent   ?days=1..14, public JSON, CORS for the dashboard origins
//   GET  /live/health   {ok, status, lastWebhookAt, lastCronAt, pending, ...} (no secrets)
//   GET  /live/hr?since=YYYY-MM-DD, GET /live/hr/<stravaId>, POST /live/strava/sync?days=N
//                       Authorization == WEBHOOK_AUTH; the local pipeline's only way to Strava
//                       (the Worker is the single owner of the Strava refresh token), see api.js
//   cron */10           pending retries (<= 24 h) + hourly /v1/workouts/events safety net
//                       + (mode "api") one queued webhook narrative
//   cron 40 5 * * *     (mode "api") daily coach narrative — 07:40 Zagreb in summer time (CEST), 06:40 in winter
//   GET  /live/narrative ?days=1..30, public JSON {mode, items}, CORS like /live/recent
//   POST /live/pipeline Authorization == WEBHOOK_AUTH; Mac strength-cron heartbeat -> KV pipeline:last
//   /admin/*            Cloudflare Access JWT (src/access.js); config, usage, coach, status (src/admin.js)
//   API mode contract: .foreman/api-contract.md

import { handleAdmin } from "./admin.js";
import { errorResponse, hrList, hrOne, stravaSync } from "./api.js";
import { checkWebhookAuth, corsHeaders, json, sleepMs } from "./http.js";
import { processWebhook, runCron } from "./process.js";
import { getIndex, getJSON, getWorkout, KEEP_DAYS, putJSON } from "./store.js";
import {
  afterWebhook, DAILY_CRON, getMode, listNarratives, processNarrativeQueue, runDailyNarrative,
} from "./narrative.js";
import { maxUsdPerDay, spendToday } from "./usage.js";

const ID_RE = /^[A-Za-z0-9-]{6,64}$/;
const SECRET_NAMES = ["HEVY_API_KEY", "STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET", "STRAVA_REFRESH_TOKEN", "WEBHOOK_AUTH"];

export function makeRuntime(env, overrides = {}) {
  return {
    env,
    fetch: overrides.fetch || ((...a) => fetch(...a)),
    sleep: overrides.sleep || sleepMs,
    now: overrides.now || (() => Date.now()),
  };
}

async function handleHook(request, env, ctx, rt) {
  if (!(await checkWebhookAuth(request, env.WEBHOOK_AUTH))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  let body = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const id = body && (body.workoutId || body.workout_id || body.id);
  if (typeof id !== "string" || !ID_RE.test(id)) {
    return json({ ok: false, error: "body must be {\"workoutId\": \"...\"}" }, 400);
  }
  const kv = env.LIVE;
  ctx.waitUntil((async () => {
    try {
      await putJSON(kv, "meta:lastWebhookAt", new Date(rt.now()).toISOString());
      const rec = await processWebhook(rt, id);
      // API mode (A1): coach narrative for this workout; no-op in mode "current"
      try { await afterWebhook(rt, rec); } catch (e) { console.error("narrative failed", String(e && e.message ? e.message : e)); }
    } catch (e) {
      console.error("webhook processing failed", String(e && e.message ? e.message : e));
    }
  })());
  return json({ ok: true });
}

async function handleRecent(url, env, rt) {
  let days = Number.parseInt(url.searchParams.get("days") || String(KEEP_DAYS), 10);
  if (!Number.isFinite(days)) days = KEEP_DAYS;
  days = Math.min(KEEP_DAYS, Math.max(1, days));
  const cutoff = rt.now() - days * 86400 * 1000;
  const idx = (await getIndex(env.LIVE)).filter((e) => Date.parse(e.start) >= cutoff);
  const recs = (await Promise.all(idx.map((e) => getWorkout(env.LIVE, e.id)))).filter(Boolean);
  recs.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  return { generatedAt: new Date(rt.now()).toISOString(), workouts: recs };
}

async function handleHealth(env, rt) {
  const missing = SECRET_NAMES.filter((n) => !env[n]);
  const kv = env.LIVE;
  let lastWebhookAt = null;
  let cron = null;
  let lastError = null;
  let mode = "current";
  let spendTodayUsd = null;
  let kvOk = true;
  try {
    [lastWebhookAt, cron, lastError, mode, spendTodayUsd] = await Promise.all([
      getJSON(kv, "meta:lastWebhookAt"), getJSON(kv, "meta:cron"), getJSON(kv, "meta:lastError"),
      getMode(kv), spendToday(kv, rt.now()),
    ]);
  } catch {
    kvOk = false;
  }
  const degraded = missing.length > 0 || !kvOk;
  return {
    ok: !degraded,
    status: degraded ? "degraded" : "ok",
    lastWebhookAt: lastWebhookAt || null,
    lastCronAt: (cron && cron.at) || null,
    pending: (cron && cron.pending) || 0,
    missingSecrets: missing,
    kv: kvOk ? "ok" : "error",
    lastError: lastError || null,
    mode,
    spendTodayUsd,
    maxUsdPerDay: maxUsdPerDay(env),
  };
}

async function handleNarrative(url, env, rt) {
  let days = Number.parseInt(url.searchParams.get("days") || "14", 10);
  if (!Number.isFinite(days)) days = 14;
  days = Math.min(30, Math.max(1, days));
  const [mode, items] = await Promise.all([getMode(env.LIVE), listNarratives(env.LIVE, days, rt.now())]);
  return { mode, items };
}

const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** POST /live/pipeline: Mac strength-cron heartbeat {host, ranAt, changed, commit, durationS, errors}. */
async function handlePipeline(request, env, rt) {
  let b;
  try {
    b = await request.json();
  } catch {
    return json({ ok: false, error: "body must be JSON" }, 400);
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) return json({ ok: false, error: "body must be a JSON object" }, 400);
  const ranRaw = str(b.ranAt, 40) || str(b.ran, 40);
  const errors = Array.isArray(b.errors)
    ? b.errors.filter((e) => typeof e === "string").slice(0, 10).map((e) => e.slice(0, 300))
    : (Number.isFinite(Number(b.errors)) ? Number(b.errors) : []);
  const doc = {
    host: str(b.host, 40),
    ranAt: ranRaw && !Number.isNaN(Date.parse(ranRaw)) ? ranRaw : null,
    changed: b.changed === true,
    commit: str(b.commit, 64),
    durationS: Number.isFinite(Number(b.durationS)) ? Number(b.durationS) : null,
    errors,
    receivedAt: new Date(rt.now()).toISOString(),
  };
  if (typeof b.skipped === "boolean") doc.skipped = b.skipped;
  if (str(b.status, 40)) doc.status = str(b.status, 40);
  await putJSON(env.LIVE, "pipeline:last", doc);
  return json({ ok: true });
}

export async function handle(request, env, ctx, rt = makeRuntime(env)) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/hook/hevy") {
    if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405, { Allow: "POST" });
    return handleHook(request, env, ctx, rt);
  }

  if (path === "/admin" || path.startsWith("/admin/")) return handleAdmin(request, rt, path, url);

  if (path === "/live/pipeline") {
    if (!(await checkWebhookAuth(request, env.WEBHOOK_AUTH))) {
      return json({ ok: false, code: "unauthorized", error: "unauthorized" }, 401);
    }
    if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405, { Allow: "POST" });
    return handlePipeline(request, env, rt);
  }

  const hrMatch = /^\/live\/hr\/([^/]+)$/.exec(path);
  if (path === "/live/hr" || hrMatch || path === "/live/strava/sync") {
    if (!(await checkWebhookAuth(request, env.WEBHOOK_AUTH))) {
      return json({ ok: false, code: "unauthorized", error: "unauthorized" }, 401);
    }
    const want = path === "/live/strava/sync" ? "POST" : "GET";
    if (request.method !== want) return json({ ok: false, error: "method not allowed" }, 405, { Allow: want });
    try {
      if (path === "/live/hr") return await hrList(rt, url);
      if (hrMatch) return await hrOne(rt, hrMatch[1]);
      return await stravaSync(rt, url);
    } catch (e) {
      return errorResponse(e);
    }
  }

  if (path === "/live/recent" || path === "/live/health" || path === "/live/narrative") {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ ok: false, error: "method not allowed" }, 405, { ...cors, Allow: "GET, OPTIONS" });
    }
    try {
      if (path === "/live/recent") {
        return json(await handleRecent(url, env, rt), 200, { ...cors, "Cache-Control": "public, max-age=30" });
      }
      if (path === "/live/narrative") {
        return json(await handleNarrative(url, env, rt), 200, { ...cors, "Cache-Control": "public, max-age=30" });
      }
      return json(await handleHealth(env, rt), 200, { ...cors, "Cache-Control": "no-store" });
    } catch (e) {
      console.error("live endpoint failed", String(e && e.message ? e.message : e));
      return json({ ok: false, error: "temporarily unavailable" }, 503, { ...cors, "Retry-After": "30" });
    }
  }

  return json({ ok: false, error: "not found" }, 404);
}

/** Cron dispatch: the daily trigger runs only the coach narrative; every other trigger runs
 *  the existing every-10-min work, then (mode "api") at most one queued webhook narrative. */
export async function runScheduled(controller, env, rt = makeRuntime(env)) {
  const msg = (e) => String(e && e.message ? e.message : e);
  if (controller && controller.cron === DAILY_CRON) {
    try { return { daily: await runDailyNarrative(rt) }; } catch (e) { console.error("daily narrative failed", msg(e)); return null; }
  }
  let cron = null;
  try { cron = await runCron(rt, controller && controller.scheduledTime); } catch (e) { console.error("cron failed", msg(e)); }
  let narrative = null;
  try { narrative = await processNarrativeQueue(rt); } catch (e) { console.error("narrative queue failed", msg(e)); }
  return { cron, narrative };
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      console.error("unhandled", String(e && e.message ? e.message : e));
      return json({ ok: false, error: "internal error" }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(controller, env));
  },
};
