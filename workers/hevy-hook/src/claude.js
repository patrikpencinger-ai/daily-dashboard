// Claude Messages API over raw fetch (no SDK in the Worker). Contract: .foreman/api-contract.md
//
// - anthropic-version 2023-06-01; `thinking` omitted (adaptive by default on the 5.5 models),
//   depth set with output_config.effort; no budget_tokens / temperature / tool_choice.
// - Opus 5.5 / Sonnet 5.5: server-side refusal fallback (`fallbacks: "default"` + beta
//   server-side-fallback-2026-07-01). Haiku 5.5 has no server-side fallback, so neither is sent.
// - The static coach rules are ONE system block with cache_control ephemeral; the volatile
//   context + task go in the user message after it, so the prefix stays byte-identical.
// - Retries 429 / 5xx / network errors at most twice (Retry-After honoured, else 2 s, 4 s);
//   60 s timeout per attempt (a timeout is not retried). Callers may lower both: the webhook
//   narrative uses 25 s and no retry (waitUntil budget ~30 s; the cron queue retries it).
// - Every call (and every call skipped by the daily cap) is logged by usage.js.

import { retryAfterSeconds } from "./http.js";
import { checkCap, costOf, logUsage } from "./usage.js";

export const ANTHROPIC_API = "https://api.anthropic.com/v1";
export const ANTHROPIC_VERSION = "2023-06-01";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);
export const TIMEOUT_MS = 60 * 1000;
export const MAX_RETRIES = 2;
export const MAX_RETRY_WAIT_S = 20;

const ZERO = { in: 0, cacheRead: 0, cacheWrite: 0, out: 0 };

/** Request body + headers (without the API key) for one Messages call. */
export function buildRequest({ model, maxTokens, effort, system, user, schema }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
    output_config: { effort },
  };
  if (schema) body.output_config.format = { type: "json_schema", schema };
  const headers = { "content-type": "application/json", "anthropic-version": ANTHROPIC_VERSION };
  if (FALLBACK_MODELS.has(model)) {
    body.fallbacks = "default";
    headers["anthropic-beta"] = FALLBACK_BETA;
  }
  return { body, headers };
}

class CallError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/** One fetch with a timeout; the body is read inside the timeout. */
async function fetchOnce(rt, url, init, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await rt.fetch(url, { ...init, signal: ac.signal });
    const text = await resp.text();
    return { status: resp.status, headers: resp.headers, text };
  } catch (e) {
    if (ac.signal.aborted || (e && e.name === "AbortError")) throw new CallError("timeout", `no response in ${timeoutMs} ms`);
    throw new CallError("network", String((e && e.message) || e).slice(0, 120));
  } finally {
    clearTimeout(timer);
  }
}

/** POST with retry on 429 / 5xx / network errors (max `maxRetries` retries). Returns {status, headers, text, attempts}. */
export async function postWithRetry(rt, url, init, { timeoutMs = TIMEOUT_MS, maxRetries = MAX_RETRIES } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res = null;
    let err = null;
    try {
      res = await fetchOnce(rt, url, init, timeoutMs);
    } catch (e) {
      if (e.code === "timeout") throw e;
      err = e;
    }
    const retryable = err || res.status === 429 || res.status >= 500;
    if (!retryable) return { ...res, attempts: attempt + 1 };
    if (attempt >= maxRetries) {
      if (err) throw err;
      return { ...res, attempts: attempt + 1 };
    }
    const ra = res ? retryAfterSeconds(res) : 0;
    if (ra > MAX_RETRY_WAIT_S) return { ...res, attempts: attempt + 1 }; // server asks for a long pause: stop here
    await rt.sleep(Math.max(ra, 2 * (attempt + 1)) * 1000);
  }
}

function textOf(content) {
  return (Array.isArray(content) ? content : [])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function apiErrorType(text) {
  try {
    const j = JSON.parse(text);
    return (j && j.error && typeof j.error.type === "string") ? j.error.type.slice(0, 40) : "";
  } catch {
    return "";
  }
}

/**
 * Call Claude once (with retries) and log usage.
 * @param opts {fn, model, effort, maxTokens, system, user, schema?, timeoutMs?, maxRetries?}
 *   schema set  -> structured JSON output, result.data = parsed object
 *   schema null -> plain text, result.text
 * @returns {ok, err, skipped?, text, data, usage:{in,cacheRead,cacheWrite,out}, usd, model, stopReason, truncated, ms}
 */
export async function callClaude(rt, opts) {
  const { fn, model, effort, maxTokens, system, user, schema = null } = opts;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : TIMEOUT_MS;
  const maxRetries = Number.isInteger(opts.maxRetries) && opts.maxRetries >= 0 ? opts.maxRetries : MAX_RETRIES;
  const kv = rt.env.LIVE;
  const t0 = rt.now();
  const base = { fn, model, effort };
  const out = (o) => ({ text: null, data: null, usage: { ...ZERO }, usd: 0, model, stopReason: null, truncated: false, ms: 0, ...o });

  if (!rt.env.ANTHROPIC_API_KEY) {
    await logUsage(kv, { ...base, ...ZERO, usd: 0, ms: 0, ok: false, err: "not-configured", skipped: true, reason: "no-key" }, t0);
    return out({ ok: false, err: "not-configured", skipped: true });
  }
  const cap = await checkCap(rt.env, kv, t0);
  if (!cap.ok) {
    await logUsage(kv, { ...base, ...ZERO, usd: 0, ms: 0, ok: false, err: "cap", skipped: true, reason: "cap", spent: cap.spent, cap: cap.cap }, t0);
    return out({ ok: false, err: "cap", skipped: true, reason: "cap", spent: cap.spent, cap: cap.cap });
  }

  const { body, headers } = buildRequest({ model, maxTokens, effort, system, user, schema });
  let res;
  try {
    res = await postWithRetry(rt, `${ANTHROPIC_API}/messages`, {
      method: "POST",
      headers: { ...headers, "x-api-key": rt.env.ANTHROPIC_API_KEY },
      body: JSON.stringify(body),
    }, { timeoutMs, maxRetries });
  } catch (e) {
    const ms = rt.now() - t0;
    const err = e.code || "network";
    await logUsage(kv, { ...base, ...ZERO, usd: 0, ms, ok: false, err }, rt.now());
    return out({ ok: false, err, ms });
  }
  const ms = rt.now() - t0;

  if (res.status !== 200) {
    const type = apiErrorType(res.text);
    const err = `http ${res.status}${type ? ` ${type}` : ""}`;
    await logUsage(kv, { ...base, ...ZERO, usd: 0, ms, ok: false, err }, rt.now());
    return out({ ok: false, err, ms, status: res.status });
  }

  let msg;
  try {
    msg = JSON.parse(res.text);
  } catch {
    await logUsage(kv, { ...base, ...ZERO, usd: 0, ms, ok: false, err: "bad-response" }, rt.now());
    return out({ ok: false, err: "bad-response", ms });
  }

  const servedBy = typeof msg.model === "string" ? msg.model : model;
  const cost = costOf(servedBy, msg.usage);
  const usage = { in: cost.in, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite, out: cost.out };
  const stopReason = msg.stop_reason || null;
  const text = textOf(msg.content);
  let ok = true;
  let err = null;
  let data = null;
  let truncated = false;

  if (stopReason === "refusal") {
    const cat = msg.stop_details && msg.stop_details.category ? String(msg.stop_details.category) : "unknown";
    ok = false;
    err = `refusal:${cat}`.slice(0, 60);
  } else if (stopReason === "max_tokens") {
    truncated = true;
    err = "max_tokens";
    ok = !schema && text.length > 0; // a cut-off JSON object is unusable; cut-off prose is still shown
  } else if (schema) {
    try {
      data = JSON.parse(text);
    } catch {
      ok = false;
      err = "bad-json";
    }
  }
  if (!ok) data = null;

  const entry = {
    ...base, ...usage, usd: cost.usd, ms, ok, err, stop: stopReason,
  };
  if (servedBy !== model) entry.servedBy = servedBy;
  await logUsage(kv, entry, rt.now());
  return {
    ok, err, skipped: false, text: ok || truncated ? text : null, data, usage, usd: cost.usd,
    model: servedBy, stopReason, truncated, ms,
  };
}

/** Free connectivity / key check: GET /v1/models (no tokens are spent). */
export async function pingClaude(rt) {
  if (!rt.env.ANTHROPIC_API_KEY) return { ok: false, status: 0, error: "ANTHROPIC_API_KEY not configured" };
  const t0 = rt.now();
  try {
    const res = await fetchOnce(rt, `${ANTHROPIC_API}/models?limit=1`, {
      method: "GET",
      headers: { "x-api-key": rt.env.ANTHROPIC_API_KEY, "anthropic-version": ANTHROPIC_VERSION },
    }, 10 * 1000);
    const ms = rt.now() - t0;
    if (res.status === 200) return { ok: true, status: 200, ms };
    const type = apiErrorType(res.text);
    const error = res.status === 401 ? "invalid API key" : `http ${res.status}${type ? ` ${type}` : ""}`;
    return { ok: false, status: res.status, ms, error };
  } catch (e) {
    return { ok: false, status: 0, ms: rt.now() - t0, error: e.code || "network" };
  }
}
