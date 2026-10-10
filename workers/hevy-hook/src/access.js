// Cloudflare Access JWT verification for /admin/* (RS256 via WebCrypto, no dependencies).
//
// The token comes from the Cf-Access-Jwt-Assertion header that Access adds to every request it
// lets through. Checks: alg RS256, kid in the team's JWKS, signature, exp / nbf (60 s leeway),
// iss == ACCESS_TEAM, aud contains env.ACCESS_AUD. The JWKS is cached for 1 h per isolate and
// re-fetched at most once a minute when an unknown kid shows up (key rotation).

export const ACCESS_TEAM = "https://summer-smoke-ba3e.cloudflareaccess.com";
export const ACCESS_CERTS = `${ACCESS_TEAM}/cdn-cgi/access/certs`;
export const JWKS_TTL_MS = 3600 * 1000;
const REFETCH_MIN_MS = 60 * 1000;
const LEEWAY_S = 60;

let cache = { keys: null, at: 0 };
export function resetJwksCache() {
  cache = { keys: null, at: 0 };
}

export class AccessError extends Error {}

function b64urlBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

async function loadKeys(fetchImpl, now, force) {
  if (cache.keys && !force && now - cache.at < JWKS_TTL_MS) return cache.keys;
  if (cache.keys && force && now - cache.at < REFETCH_MIN_MS) return cache.keys;
  const resp = await fetchImpl(ACCESS_CERTS, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new AccessError(`certs fetch failed: HTTP ${resp.status}`);
  const body = await resp.json();
  const keys = Array.isArray(body && body.keys) ? body.keys : [];
  cache = { keys, at: now };
  return keys;
}

/**
 * Verify one Access JWT. Returns the payload; throws AccessError on any failure.
 * @param token  the Cf-Access-Jwt-Assertion value
 * @param opts   {aud, fetchImpl, now (epoch ms)}
 */
export async function verifyAccessJwt(token, { aud, fetchImpl = fetch, now = Date.now() } = {}) {
  if (!aud) throw new AccessError("ACCESS_AUD not configured");
  if (typeof token !== "string" || !token) throw new AccessError("missing token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessError("malformed token");
  let header;
  let payload;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch {
    throw new AccessError("malformed token");
  }
  if (!header || header.alg !== "RS256") throw new AccessError("unsupported alg");

  let keys = await loadKeys(fetchImpl, now, false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await loadKeys(fetchImpl, now, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk || jwk.kty !== "RSA") throw new AccessError("unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new AccessError("bad signature");

  const nowS = Math.floor(now / 1000);
  if (typeof payload.exp !== "number" || payload.exp + LEEWAY_S < nowS) throw new AccessError("token expired");
  if (typeof payload.nbf === "number" && payload.nbf - LEEWAY_S > nowS) throw new AccessError("token not yet valid");
  if (payload.iss !== ACCESS_TEAM) throw new AccessError("wrong issuer");
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new AccessError("wrong audience");
  return payload;
}

/** {ok:true, email} | {ok:false, status, error}. 503 when Access is not configured (never open). */
export async function checkAccess(request, env, rt) {
  const aud = typeof env.ACCESS_AUD === "string" ? env.ACCESS_AUD.trim() : "";
  if (!aud) return { ok: false, status: 503, error: "admin not configured" };
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  try {
    const p = await verifyAccessJwt(token, { aud, fetchImpl: rt.fetch, now: rt.now() });
    return { ok: true, email: p.email || null };
  } catch (e) {
    return { ok: false, status: 401, error: e instanceof AccessError ? e.message : "unauthorized" };
  }
}
