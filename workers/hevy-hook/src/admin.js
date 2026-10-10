// /admin/* — behind Cloudflare Access (Cf-Access-Jwt-Assertion verified in access.js).
// Contract: .foreman/api-contract.md
//
//   GET  /admin/config            mode, functions, allowed values, PRICES, cap
//   PUT  /admin/config            {mode?, functions?:{<fn>:{model?,effort?,maxTokens?,enabled?}}}
//   GET  /admin/usage             ?from=YYYY-MM-DD&to=YYYY-MM-DD&group=day|week|month|function|model
//   GET  /admin/usage/recent      last 50 logged calls
//   POST /admin/narrative/run     {workoutId: "<id>"|"latest"|"daily"}   (needs mode "api")
//   POST /admin/coach             {question, lang:"en"|"hr"}            (needs mode "api")
//   GET  /admin/status            mode, cron, pending, last errors, pipeline heartbeat, KV counts
//   GET  /admin/ping              free key check (GET /v1/models; no tokens)
//
// ACCESS_AUD empty -> every /admin/* answers 503 "admin not configured" (never open).
// CORS: the public allow-list; Access-Control-Allow-Credentials only for https://dash.er45.com.

import { checkAccess } from "./access.js";
import { pingClaude } from "./claude.js";
import { ALLOWED_ORIGINS, json } from "./http.js";
import {
  ALLOWED_MODELS, CRON_EVERY_10, DAILY_CRON, EFFORTS, FUNCTION_IDS, getFunctions, getMode,
  MAX_TOKENS_RANGE, MODES, runCoach, runDailyNarrative, runNarrative, validateConfig,
} from "./narrative.js";
import { getIndex, getJSON, hrSampleCounts, listPending, putJSON } from "./store.js";
import {
  addDays, aggregate, GROUPS, MAX_RANGE_DAYS, maxUsdPerDay, PRICES, PRICES_NOTE, recentEntries,
  spendToday, usageRange, validDate, zgDate,
} from "./usage.js";

export const CREDENTIALS_ORIGIN = "https://dash.er45.com";
const BODY_MAX = 8 * 1024;
const QUESTION_MAX = 1000;
const ID_RE = /^[A-Za-z0-9-]{6,64}$/;

export function adminCors(request) {
  const origin = request.headers.get("Origin");
  const h = { Vary: "Origin" };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, PUT, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type";
    h["Access-Control-Max-Age"] = "600";
    if (origin === CREDENTIALS_ORIGIN) h["Access-Control-Allow-Credentials"] = "true";
  }
  return h;
}

class BadRequest extends Error {}

async function readBody(request) {
  const text = await request.text();
  if (text.length > BODY_MAX) throw new BadRequest("body too large");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest("body must be JSON");
  }
}

/** HTTP status for a failed run (body always carries {ok:false, err}). */
function runStatus(err) {
  const e = String(err || "");
  if (e === "mode-current" || e === "disabled") return 409;
  if (e === "unknown-workout") return 404;
  if (e === "cap") return 429;
  if (e === "not-configured") return 503;
  return 502;
}

// ---- handlers ------------------------------------------------------------------------

async function configView(rt) {
  const kv = rt.env.LIVE;
  const [mode, functions] = await Promise.all([getMode(kv), getFunctions(kv)]);
  return {
    ok: true,
    mode,
    functions,
    allowed: { modes: MODES, functionIds: FUNCTION_IDS, models: ALLOWED_MODELS, efforts: EFFORTS, maxTokens: MAX_TOKENS_RANGE },
    prices: PRICES,
    pricesNote: PRICES_NOTE,
    maxUsdPerDay: maxUsdPerDay(rt.env),
    crons: { every10: CRON_EVERY_10, daily: DAILY_CRON, dailyNote: "UTC; 07:40 Europe/Zagreb in summer time, 06:40 in winter time" },
  };
}

async function putConfig(request, rt) {
  const kv = rt.env.LIVE;
  const body = await readBody(request);
  const v = validateConfig(body, await getFunctions(kv));
  if (v.errors.length) return { status: 400, body: { ok: false, error: "invalid config", errors: v.errors } };
  if (v.mode) await putJSON(kv, "cfg:mode", v.mode);
  if (v.functions) await putJSON(kv, "cfg:functions", v.functions);
  return { status: 200, body: await configView(rt) };
}

async function usage(url, rt) {
  const today = zgDate(rt.now());
  const to = url.searchParams.get("to") || today;
  const from = url.searchParams.get("from") || addDays(to, -29);
  const group = url.searchParams.get("group") || "day";
  const errors = [];
  if (!validDate(from)) errors.push("from must be YYYY-MM-DD");
  if (!validDate(to)) errors.push("to must be YYYY-MM-DD");
  if (!GROUPS.includes(group)) errors.push(`group must be one of ${GROUPS.join("|")}`);
  if (!errors.length && from > to) errors.push("from must not be after to");
  if (!errors.length && addDays(from, MAX_RANGE_DAYS - 1) < to) errors.push(`range is limited to ${MAX_RANGE_DAYS} days`);
  if (errors.length) return { status: 400, body: { ok: false, error: "invalid query", errors } };
  const { rows, totals } = aggregate(await usageRange(rt.env.LIVE, from, to), group);
  return { status: 200, body: { ok: true, from, to, group, timeZone: "Europe/Zagreb", rows, totals } };
}

async function narrativeRun(request, rt) {
  const body = await readBody(request);
  let id = body && (body.workoutId ?? body.kind);
  if (id === "daily") {
    const r = await runDailyNarrative(rt, { manual: true });
    return { status: r.ok ? 200 : runStatus(r.err), body: r };
  }
  if (id === "latest" || id === undefined || id === null) {
    const idx = await getIndex(rt.env.LIVE);
    if (!idx.length) return { status: 404, body: { ok: false, err: "unknown-workout", error: "no live workouts" } };
    id = idx[0].id;
  }
  if (typeof id !== "string" || !ID_RE.test(id)) {
    return { status: 400, body: { ok: false, error: "workoutId must be a workout id, \"latest\" or \"daily\"" } };
  }
  const r = await runNarrative(rt, { kind: "workout", workoutId: id, manual: true });
  return { status: r.ok ? 200 : runStatus(r.err), body: r };
}

async function coach(request, rt) {
  const body = await readBody(request);
  const question = typeof body.question === "string" ? body.question.trim() : "";
  const lang = body.lang === undefined ? "en" : body.lang;
  const errors = [];
  if (!question) errors.push("question is required");
  if (question.length > QUESTION_MAX) errors.push(`question is limited to ${QUESTION_MAX} characters`);
  if (!["en", "hr"].includes(lang)) errors.push("lang must be en or hr");
  if (errors.length) return { status: 400, body: { ok: false, error: "invalid request", errors } };
  const r = await runCoach(rt, { question, lang });
  if (!r.ok) return { status: runStatus(r.err), body: r };
  return {
    status: 200,
    body: { ok: true, answer: r.answer, truncated: r.truncated, model: r.model, usage: r.usage, usd: r.usd },
  };
}

export async function adminStatus(rt) {
  const kv = rt.env.LIVE;
  const now = rt.now();
  const [mode, functions, cron, lastWebhookAt, lastError, pipeline, narrDaily, queue, narrIdx, idx, recent, spent, pending, hr] = await Promise.all([
    getMode(kv), getFunctions(kv), getJSON(kv, "meta:cron"), getJSON(kv, "meta:lastWebhookAt"),
    getJSON(kv, "meta:lastError"), getJSON(kv, "pipeline:last"), getJSON(kv, "meta:narrDaily"),
    getJSON(kv, "narr:queue"), getJSON(kv, "narr:index"), getIndex(kv), recentEntries(kv),
    spendToday(kv, now), listPending(kv), hrSampleCounts(kv),
  ]);
  return {
    ok: true,
    now: new Date(now).toISOString(),
    mode,
    functions,
    apiKeyConfigured: !!rt.env.ANTHROPIC_API_KEY,
    spendTodayUsd: spent,
    maxUsdPerDay: maxUsdPerDay(rt.env),
    capReached: spent >= maxUsdPerDay(rt.env),
    cron: {
      every10: CRON_EVERY_10, daily: DAILY_CRON,
      lastAt: (cron && cron.at) || null, pending: (cron && cron.pending) || 0,
    },
    lastWebhookAt: lastWebhookAt || null,
    lastError: lastError || null,
    dailyNarrative: narrDaily || null,
    narrativeQueue: Array.isArray(queue) ? queue : [],
    pipeline: pipeline || null,
    lastErrors: recent.filter((e) => !e.ok).slice(0, 5),
    kv: {
      workouts: idx.length,
      pending: pending.length,
      hr: hr.size,
      narratives: Array.isArray(narrIdx) ? narrIdx.length : 0,
    },
  };
}

// ---- router ----------------------------------------------------------------------------

const ROUTES = {
  "/admin/config": ["GET", "PUT"],
  "/admin/usage": ["GET"],
  "/admin/usage/recent": ["GET"],
  "/admin/narrative/run": ["POST"],
  "/admin/coach": ["POST"],
  "/admin/status": ["GET"],
  "/admin/ping": ["GET"],
};

export async function handleAdmin(request, rt, path, url) {
  const cors = adminCors(request);
  const reply = (body, status = 200, extra = {}) => json(body, status, { ...cors, "Cache-Control": "no-store", ...extra });
  const aud = typeof rt.env.ACCESS_AUD === "string" ? rt.env.ACCESS_AUD.trim() : "";
  if (!aud) return reply({ ok: false, error: "admin not configured" }, 503);

  const methods = ROUTES[path];
  if (!methods) return reply({ ok: false, error: "not found" }, 404);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!methods.includes(request.method)) {
    return reply({ ok: false, error: "method not allowed" }, 405, { Allow: [...methods, "OPTIONS"].join(", ") });
  }

  const auth = await checkAccess(request, rt.env, rt);
  if (!auth.ok) return reply({ ok: false, error: auth.error }, auth.status);

  try {
    let r;
    if (path === "/admin/config") r = request.method === "PUT" ? await putConfig(request, rt) : { status: 200, body: await configView(rt) };
    else if (path === "/admin/usage") r = await usage(url, rt);
    else if (path === "/admin/usage/recent") r = { status: 200, body: { ok: true, items: await recentEntries(rt.env.LIVE) } };
    else if (path === "/admin/narrative/run") r = await narrativeRun(request, rt);
    else if (path === "/admin/coach") r = await coach(request, rt);
    else if (path === "/admin/status") r = { status: 200, body: await adminStatus(rt) };
    else r = { status: 200, body: await pingClaude(rt) };
    return reply(r.body, r.status);
  } catch (e) {
    if (e instanceof BadRequest) return reply({ ok: false, error: e.message }, 400);
    console.error("admin failed", String(e && e.message ? e.message : e));
    return reply({ ok: false, error: "internal error" }, 500);
  }
}
