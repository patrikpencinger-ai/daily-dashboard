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

import { errorResponse, hrList, hrOne, stravaSync } from "./api.js";
import { checkWebhookAuth, corsHeaders, json, sleepMs } from "./http.js";
import { processWebhook, runCron } from "./process.js";
import { getIndex, getJSON, getWorkout, KEEP_DAYS, putJSON } from "./store.js";

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
      await processWebhook(rt, id);
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

async function handleHealth(env) {
  const missing = SECRET_NAMES.filter((n) => !env[n]);
  const kv = env.LIVE;
  let lastWebhookAt = null;
  let cron = null;
  let lastError = null;
  let kvOk = true;
  try {
    [lastWebhookAt, cron, lastError] = await Promise.all([
      getJSON(kv, "meta:lastWebhookAt"), getJSON(kv, "meta:cron"), getJSON(kv, "meta:lastError"),
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
  };
}

export async function handle(request, env, ctx, rt = makeRuntime(env)) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/hook/hevy") {
    if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405, { Allow: "POST" });
    return handleHook(request, env, ctx, rt);
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

  if (path === "/live/recent" || path === "/live/health") {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ ok: false, error: "method not allowed" }, 405, { ...cors, Allow: "GET, OPTIONS" });
    }
    try {
      if (path === "/live/recent") {
        return json(await handleRecent(url, env, rt), 200, { ...cors, "Cache-Control": "public, max-age=30" });
      }
      return json(await handleHealth(env), 200, { ...cors, "Cache-Control": "no-store" });
    } catch (e) {
      console.error("live endpoint failed", String(e && e.message ? e.message : e));
      return json({ ok: false, error: "temporarily unavailable" }, 503, { ...cors, "Retry-After": "30" });
    }
  }

  return json({ ok: false, error: "not found" }, 404);
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
    const rt = makeRuntime(env);
    ctx.waitUntil(runCron(rt, controller.scheduledTime).catch((e) => {
      console.error("cron failed", String(e && e.message ? e.message : e));
    }));
  },
};
