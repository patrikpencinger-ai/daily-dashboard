// Cloudflare Access JWT verification against a locally generated RSA key pair (no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCESS_CERTS, ACCESS_TEAM, AccessError, checkAccess, JWKS_TTL_MS, resetJwksCache, verifyAccessJwt,
} from "../src/access.js";
import { jsonResponse } from "./helpers.mjs";

const NOW = Date.parse("2026-10-10T08:00:00Z");
const AUD = "test-aud-0123456789abcdef";

const b64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function keyPair(kid) {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return { kid, privateKey: kp.privateKey, jwk: { kty: "RSA", kid, alg: "RS256", use: "sig", n: pub.n, e: pub.e } };
}

async function sign(key, payload, header = {}) {
  const h = enc({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const p = enc(payload);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

const claims = (over = {}) => ({
  aud: [AUD], iss: ACCESS_TEAM, email: "athlete@example.com",
  iat: NOW / 1000 - 60, nbf: NOW / 1000 - 60, exp: NOW / 1000 + 3600, ...over,
});

function certsFetch(keys) {
  const f = async (url) => {
    f.calls.push(String(url));
    return jsonResponse({ keys: keys() });
  };
  f.calls = [];
  return f;
}

const K1 = await keyPair("k1");
const K2 = await keyPair("k2");
const OTHER = await keyPair("k1"); // same kid, different key -> bad signature

test("valid token: payload returned, JWKS fetched from the team certs URL", async () => {
  resetJwksCache();
  const f = certsFetch(() => [K1.jwk, K2.jwk]);
  const p = await verifyAccessJwt(await sign(K1, claims()), { aud: AUD, fetchImpl: f, now: NOW });
  assert.equal(p.email, "athlete@example.com");
  assert.deepEqual(f.calls, [ACCESS_CERTS]);
  assert.equal(ACCESS_CERTS, "https://summer-smoke-ba3e.cloudflareaccess.com/cdn-cgi/access/certs");
});

test("aud as a plain string is accepted", async () => {
  resetJwksCache();
  const f = certsFetch(() => [K1.jwk]);
  await verifyAccessJwt(await sign(K1, claims({ aud: AUD })), { aud: AUD, fetchImpl: f, now: NOW });
});

const rejects = async (token, msg, opts = {}) => {
  resetJwksCache();
  const f = certsFetch(() => [K1.jwk, K2.jwk]);
  await assert.rejects(verifyAccessJwt(await token, { aud: AUD, fetchImpl: f, now: NOW, ...opts }), (e) => {
    assert.ok(e instanceof AccessError, String(e));
    assert.match(e.message, msg);
    return true;
  });
};

test("rejects: wrong aud, wrong iss, expired, not yet valid", async () => {
  await rejects(sign(K1, claims({ aud: ["someone-else"] })), /audience/);
  await rejects(sign(K1, claims({ iss: "https://evil.cloudflareaccess.com" })), /issuer/);
  await rejects(sign(K1, claims({ exp: NOW / 1000 - 120 })), /expired/);
  await rejects(sign(K1, claims({ exp: undefined })), /expired/);
  await rejects(sign(K1, claims({ nbf: NOW / 1000 + 600 })), /not yet valid/);
});

test("rejects: bad signature, alg none / HS256, malformed, missing, unknown kid", async () => {
  await rejects(sign(OTHER, claims()), /bad signature/);
  const good = await sign(K1, claims());
  const [, p, s] = good.split(".");
  await rejects(`${enc({ alg: "none", kid: "k1" })}.${p}.`, /unsupported alg/);
  await rejects(`${enc({ alg: "HS256", kid: "k1" })}.${p}.${s}`, /unsupported alg/);
  await rejects("not-a-jwt", /malformed/);
  await rejects("a.b.c", /malformed/);
  await rejects(null, /missing token/);
  await rejects(sign(K1, claims(), { kid: "k9" }), /unknown signing key/);
  // tampered payload
  await rejects(`${good.split(".")[0]}.${enc(claims({ email: "x@y" }))}.${s}`, /bad signature/);
  // no aud configured -> never open
  await rejects(good, /ACCESS_AUD not configured/, { aud: "" });
});

test("JWKS cached for 1 h; unknown kid triggers one refetch (rotation)", async () => {
  resetJwksCache();
  let keys = [K1.jwk];
  const f = certsFetch(() => keys);
  const t1 = await sign(K1, claims());
  await verifyAccessJwt(t1, { aud: AUD, fetchImpl: f, now: NOW });
  await verifyAccessJwt(t1, { aud: AUD, fetchImpl: f, now: NOW + 10 * 60 * 1000 });
  assert.equal(f.calls.length, 1);
  await verifyAccessJwt(t1, { aud: AUD, fetchImpl: f, now: NOW + JWKS_TTL_MS + 1 });
  assert.equal(f.calls.length, 2);
  // rotation: new kid appears, cache (2 min old) is refreshed once
  keys = [K1.jwk, K2.jwk];
  const t2 = await sign(K2, claims({ exp: NOW / 1000 + 7200 }));
  await verifyAccessJwt(t2, { aud: AUD, fetchImpl: f, now: NOW + JWKS_TTL_MS + 2 * 60 * 1000 });
  assert.equal(f.calls.length, 3);
});

test("checkAccess: 503 when ACCESS_AUD is empty, 401 without / with a bad token, ok with a good one", async () => {
  resetJwksCache();
  const f = certsFetch(() => [K1.jwk]);
  const rt = { fetch: f, now: () => NOW };
  const req = (token) => new Request("https://hevy.er45.com/admin/status", token ? { headers: { "Cf-Access-Jwt-Assertion": token } } : {});
  assert.deepEqual(await checkAccess(req(await sign(K1, claims())), { ACCESS_AUD: "" }, rt), { ok: false, status: 503, error: "admin not configured" });
  assert.deepEqual(await checkAccess(req(await sign(K1, claims())), { ACCESS_AUD: "   " }, rt), { ok: false, status: 503, error: "admin not configured" });
  assert.equal((await checkAccess(req(null), { ACCESS_AUD: AUD }, rt)).status, 401);
  assert.equal((await checkAccess(req(await sign(OTHER, claims())), { ACCESS_AUD: AUD }, rt)).status, 401);
  assert.deepEqual(await checkAccess(req(await sign(K1, claims())), { ACCESS_AUD: AUD }, rt), { ok: true, email: "athlete@example.com" });
});

test("certs endpoint failure -> 401, not open", async () => {
  resetJwksCache();
  const rt = { fetch: async () => jsonResponse({ error: "down" }, 500), now: () => NOW };
  const r = await checkAccess(new Request("https://hevy.er45.com/admin/status", { headers: { "Cf-Access-Jwt-Assertion": await sign(K1, claims()) } }), { ACCESS_AUD: AUD }, rt);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  const rt2 = { fetch: async () => { throw new Error("network down"); }, now: () => NOW };
  resetJwksCache();
  const r2 = await checkAccess(new Request("https://hevy.er45.com/admin/status", { headers: { "Cf-Access-Jwt-Assertion": await sign(K1, claims()) } }), { ACCESS_AUD: AUD }, rt2);
  assert.equal(r2.status, 401);
});
