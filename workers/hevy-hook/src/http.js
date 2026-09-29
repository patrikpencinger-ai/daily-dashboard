// HTTP helpers: constant-time auth check, CORS, JSON responses, retry/backoff.

export const ALLOWED_ORIGINS = new Set([
  "https://dash.er45.com",
  "http://127.0.0.1:8100",
  "http://localhost:8100",
]);

const enc = new TextEncoder();

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(s))));
}

/** Constant-time string equality (compares fixed-length SHA-256 digests). */
export async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

/**
 * Authorization header must equal WEBHOOK_AUTH (a "Bearer <value>" form is
 * accepted too). Both comparisons always run; an unset secret never matches.
 */
export async function checkWebhookAuth(request, secret) {
  const header = request.headers.get("Authorization") || "";
  const configured = typeof secret === "string" && secret.length > 0;
  const expected = configured ? secret : "\u0000unset\u0000" + crypto.randomUUID();
  const bare = header.startsWith("Bearer ") ? header.slice(7) : "\u0000";
  const [m1, m2] = await Promise.all([safeEqual(header, expected), safeEqual(bare, expected)]);
  return configured && (m1 || m2);
}

export function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const h = { Vary: "Origin" };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export function retryAfterSeconds(resp) {
  const v = resp && resp.headers && resp.headers.get("Retry-After");
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(v);
  return Number.isNaN(at) ? 0 : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

export class HttpError extends Error {
  constructor(status, message) {
    super(`HTTP ${status}: ${message}`);
    this.status = status;
  }
}

/**
 * fetch with retry on network errors and on `retryOn(status)`; waits
 * max(Retry-After, backoff(attempt)) seconds, capped at maxWaitS
 * (mirrors tools/strava_sync.py _hevy_get: 2, 4, 6 ... s).
 * Returns the last Response (the caller inspects .ok / .status).
 */
export async function fetchRetry(url, init = {}, opts = {}) {
  const {
    attempts = 4,
    retryOn = (s) => s === 429 || s >= 500,
    backoff = (attempt) => 2 * (attempt + 1),
    maxWaitS = 10,
    fetchImpl = fetch,
    sleep = sleepMs,
  } = opts;
  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let resp = null;
    try {
      resp = await fetchImpl(url, init);
    } catch (e) {
      lastErr = e;
    }
    if (resp && !retryOn(resp.status)) return resp;
    if (attempt === attempts - 1) {
      if (resp) return resp;
      break;
    }
    const wait = Math.min(maxWaitS, Math.max(retryAfterSeconds(resp), backoff(attempt)));
    if (resp && resp.body && typeof resp.body.cancel === "function") {
      try { await resp.body.cancel(); } catch { /* ignore */ }
    }
    await sleep(wait * 1000);
  }
  throw new HttpError(0, `network error: ${lastErr && lastErr.message ? lastErr.message : lastErr}`);
}
