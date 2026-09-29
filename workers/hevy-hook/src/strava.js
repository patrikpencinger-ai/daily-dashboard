// Strava client for the Worker: refresh-token flow with the rotating refresh
// token persisted in KV (strava:tokens, seeded from the STRAVA_REFRESH_TOKEN
// secret), short retry on 5xx / network errors, and rate-limit awareness:
// a 429 or a (nearly) spent 15-min / daily window stores strava:throttle and
// the work stays pending for the cron to retry (a Worker cannot sleep 15 min).

import { fetchRetry, HttpError } from "./http.js";
import { getJSON, putJSON } from "./store.js";

export const STRAVA_API = "https://www.strava.com/api/v3";
export const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";

export class StravaThrottled extends Error {
  constructor(until, reason) {
    super(`Strava rate limit (${reason}); paused until ${new Date(until).toISOString()}`);
    this.until = until;
  }
}

export class StravaAuthError extends Error {}

export function stravaConfigured(env) {
  return Boolean(env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET && env.STRAVA_REFRESH_TOKEN);
}

function parsePair(h) {
  if (!h) return null;
  const p = String(h).split(",").map((x) => Number(x.trim()));
  return p.length === 2 && p.every(Number.isFinite) ? p : null;
}

function nextQuarterHour(now) {
  const q = 15 * 60 * 1000;
  return Math.floor(now / q) * q + q + 5000;
}

function nextUtcMidnight(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 30);
}

/** Decide from X-RateLimit-* / X-ReadRateLimit-* headers whether to pause. */
export function throttleFromHeaders(headers, now) {
  for (const prefix of ["X-RateLimit", "X-ReadRateLimit"]) {
    const limit = parsePair(headers.get(`${prefix}-Limit`));
    const usage = parsePair(headers.get(`${prefix}-Usage`));
    if (!limit || !usage) continue;
    if (usage[1] >= limit[1] - 5) return { until: nextUtcMidnight(now), reason: `${prefix} daily ${usage[1]}/${limit[1]}` };
    if (usage[0] >= limit[0] - 3) return { until: nextQuarterHour(now), reason: `${prefix} 15-min ${usage[0]}/${limit[0]}` };
  }
  return null;
}

export class Strava {
  constructor(rt) {
    this.rt = rt;
    this.kv = rt.env.LIVE;
    this.tokens = null;
    this.throttle = undefined;
  }

  now() {
    return this.rt.now();
  }

  async checkThrottle() {
    if (this.throttle === undefined) this.throttle = await getJSON(this.kv, "strava:throttle");
    if (this.throttle && this.throttle.until > this.now()) {
      throw new StravaThrottled(this.throttle.until, this.throttle.reason || "paused");
    }
  }

  async setThrottle(t) {
    this.throttle = t;
    const ttl = Math.max(60, Math.ceil((t.until - this.now()) / 1000) + 60);
    await putJSON(this.kv, "strava:throttle", t, { expirationTtl: ttl });
  }

  async refresh(refreshToken) {
    const env = this.rt.env;
    const body = new URLSearchParams({
      client_id: String(env.STRAVA_CLIENT_ID),
      client_secret: String(env.STRAVA_CLIENT_SECRET),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const resp = await fetchRetry(
      STRAVA_TOKEN_URL,
      { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      { attempts: 3, retryOn: (s) => s >= 500, maxWaitS: 4, fetchImpl: this.rt.fetch, sleep: this.rt.sleep },
    );
    if (!resp.ok) {
      await resp.body?.cancel?.().catch?.(() => {});
      return { ok: false, status: resp.status };
    }
    const tok = await resp.json();
    if (!tok || !tok.access_token || !tok.refresh_token) return { ok: false, status: 502 };
    return { ok: true, tok };
  }

  async accessToken(force = false) {
    const env = this.rt.env;
    if (!stravaConfigured(env)) throw new StravaAuthError("Strava secrets not configured");
    if (!this.tokens) this.tokens = await getJSON(this.kv, "strava:tokens");
    const t = this.tokens;
    if (!force && t && t.access_token && Number(t.expires_at || 0) * 1000 > this.now() + 120000) {
      return t.access_token;
    }
    // KV (rotated) token first, then the seed secret (lets the user re-seed by
    // re-running tools/set_live_secrets.ps1 after a local `strava_sync.py auth`).
    const candidates = [];
    if (t && t.refresh_token) candidates.push(t.refresh_token);
    if (!candidates.includes(env.STRAVA_REFRESH_TOKEN)) candidates.push(env.STRAVA_REFRESH_TOKEN);
    let lastStatus = 0;
    for (const rtok of candidates) {
      const r = await this.refresh(rtok);
      if (r.ok) {
        this.tokens = {
          access_token: r.tok.access_token,
          refresh_token: r.tok.refresh_token,
          expires_at: Number(r.tok.expires_at),
        };
        await putJSON(this.kv, "strava:tokens", this.tokens);
        return this.tokens.access_token;
      }
      lastStatus = r.status;
      if (r.status === 429) {
        await this.setThrottle({ until: nextQuarterHour(this.now()), reason: "HTTP 429 on token refresh" });
        throw new StravaThrottled(this.throttle.until, "HTTP 429");
      }
    }
    throw new StravaAuthError(`Strava token refresh failed (HTTP ${lastStatus})`);
  }

  async request(method, path, { params, payload } = {}) {
    await this.checkThrottle();
    const url = new URL(STRAVA_API + path);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(attempt > 0);
      const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
      let body;
      if (payload !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(payload);
      }
      const resp = await fetchRetry(url.toString(), { method, headers, body }, {
        attempts: 3, retryOn: (s) => s >= 500, maxWaitS: 4, fetchImpl: this.rt.fetch, sleep: this.rt.sleep,
      });
      const th = throttleFromHeaders(resp.headers, this.now());
      if (resp.status === 429) {
        await this.setThrottle(th || { until: nextQuarterHour(this.now()), reason: "HTTP 429" });
        throw new StravaThrottled(this.throttle.until, "HTTP 429");
      }
      if (resp.status === 401 && attempt === 0) {
        await resp.body?.cancel?.().catch?.(() => {});
        continue; // force a token refresh once
      }
      if (!resp.ok) {
        const text = (await resp.text().catch(() => "")).slice(0, 160).replace(/\s+/g, " ");
        throw new HttpError(resp.status, `Strava ${method} ${path.replace(/\d{5,}/g, ":id")}: ${text}`);
      }
      const data = resp.status === 204 ? null : await resp.json();
      if (th) await this.setThrottle(th);
      return data;
    }
    throw new StravaAuthError("Strava rejected the token after refresh");
  }

  listActivities(afterMs, beforeMs) {
    return this.request("GET", "/athlete/activities", {
      params: { after: Math.floor(afterMs / 1000), before: Math.ceil(beforeMs / 1000), per_page: 50, page: 1 },
    });
  }

  /** All activities that start after `afterMs` (paged like strava_sync.py list_activities). */
  async listActivitiesSince(afterMs, { perPage = 100, maxPages = 10 } = {}) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.request("GET", "/athlete/activities", {
        params: { after: Math.floor(afterMs / 1000), per_page: perPage, page },
      });
      if (!Array.isArray(batch) || !batch.length) break;
      out.push(...batch);
      if (batch.length < perPage) break;
    }
    return out;
  }

  getActivity(id) {
    return this.request("GET", `/activities/${id}`);
  }

  updateActivity(id, name, description) {
    return this.request("PUT", `/activities/${id}`, { payload: { name, description } });
  }

  /** time+heartrate streams, or null when the activity has none (404). */
  async getStreams(id) {
    try {
      return await this.request("GET", `/activities/${id}/streams`, {
        params: { keys: "time,heartrate", key_by_type: "true" },
      });
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }
}
