// Usage / cost ledger: PRICES math, KV ledger, daily cap, aggregation.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, aggregate, checkCap, costOf, dayEntries, daysBetween, isoWeek, logUsage, maxUsdPerDay, PRICES,
  priceFor, recentEntries, spendToday, usageRange, USAGE_TTL_S, usdFor, validDate, zgDate,
} from "../src/usage.js";
import { MemoryKV } from "./helpers.mjs";

const NOW = Date.parse("2026-10-10T08:00:00Z"); // 10:00 in Zagreb

test("PRICES match the contract (USD per MTok)", () => {
  assert.deepEqual(PRICES["claude-opus-5-5"], { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  assert.deepEqual(PRICES["claude-sonnet-5-5"], { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
  assert.deepEqual(PRICES["claude-haiku-5-5"], { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 });
});

// Worked example 1 — Opus 5.5, first call of the day (cache write):
//   1,200 in x $4 + 2,600 cache-write x $5 + 450 out x $20 = 4,800 + 13,000 + 9,000 = 26,800 / 1e6 = $0.0268
test("worked example 1: Opus 5.5 with cache write = $0.0268", () => {
  const c = costOf("claude-opus-5-5", { input_tokens: 1200, cache_creation_input_tokens: 2600, cache_read_input_tokens: 0, output_tokens: 450 });
  assert.deepEqual(c, { in: 1200, cacheRead: 0, cacheWrite: 2600, out: 450, usd: 0.0268 });
});

// Worked example 2 — Opus 5.5, same rules again within 5 min (cache read):
//   1,200 x $4 + 2,600 cache-read x $0.20 + 450 x $20 = 4,800 + 520 + 9,000 = 14,320 / 1e6 = $0.01432
test("worked example 2: Opus 5.5 with cache read = $0.01432", () => {
  const c = costOf("claude-opus-5-5", { input_tokens: 1200, cache_creation_input_tokens: 0, cache_read_input_tokens: 2600, output_tokens: 450 });
  assert.equal(c.usd, 0.01432);
});

// Worked example 3 — Haiku 5.5 coach answer:
//   3,000 x $0.10 + 2,600 cache-read x $0.01 + 600 x $0.50 = 300 + 26 + 300 = 626 / 1e6 = $0.000626
test("worked example 3: Haiku 5.5 = $0.000626", () => {
  const c = costOf("claude-haiku-5-5", { input_tokens: 3000, cache_read_input_tokens: 2600, output_tokens: 600 });
  assert.equal(c.usd, 0.000626);
});

// Worked example 4 — Sonnet 5.5 with cache write:
//   1,000 x $2 + 2,600 x $2.50 + 500 x $10 = 2,000 + 6,500 + 5,000 = 13,500 / 1e6 = $0.0135
test("worked example 4: Sonnet 5.5 with cache write = $0.0135", () => {
  assert.equal(usdFor("claude-sonnet-5-5", { in: 1000, cacheRead: 0, cacheWrite: 2600, out: 500 }), 0.0135);
});

test("fallback: usage.iterations summed, each attempt at its own model's rate", () => {
  const c = costOf("claude-opus-5-5", {
    input_tokens: 1000, output_tokens: 100,
    iterations: [
      { type: "message", model: "claude-opus-5-5", input_tokens: 1000, output_tokens: 0 },
      { type: "fallback_message", model: "claude-sonnet-5-5", input_tokens: 1000, output_tokens: 100 },
    ],
  });
  // opus 1000 x 4 = 4,000; sonnet 1000 x 2 + 100 x 10 = 3,000 -> 7,000 / 1e6
  assert.deepEqual(c, { in: 2000, cacheRead: 0, cacheWrite: 0, out: 100, usd: 0.007 });
});

test("unknown model is priced at the Opus rate (safe side for the cap)", () => {
  const p = priceFor("claude-opus-4-8");
  assert.equal(p.known, false);
  assert.equal(p.input, 4);
  assert.equal(costOf(undefined, null).usd, 0);
});

test("zgDate uses Europe/Zagreb (CEST evening -> next day)", () => {
  assert.equal(zgDate(Date.parse("2026-10-09T22:30:00Z")), "2026-10-10");
  assert.equal(zgDate(Date.parse("2026-12-31T22:59:00Z")), "2026-12-31"); // CET, UTC+1
  assert.equal(zgDate(Date.parse("2026-12-31T23:00:00Z")), "2027-01-01");
});

test("logUsage writes one key per call usage:<day>:<ts>-<rand> (TTL 400 d, entry in metadata) and keeps the last 50 in usage:recent", async () => {
  const kv = new MemoryKV();
  for (let i = 0; i < 55; i++) await logUsage(kv, { fn: "coach_chat", usd: 0.001, ok: true }, NOW + i);
  const day = await dayEntries(kv, "2026-10-10");
  assert.equal(day.length, 55);
  assert.deepEqual(day.map((e) => e.ts), Array.from({ length: 55 }, (_, i) => new Date(NOW + i).toISOString())); // key order = time order
  const keys = [...kv.m.keys()].filter((k) => k.startsWith("usage:2026-10-10:"));
  assert.equal(keys.length, 55);
  assert.match(keys[0], new RegExp(`^usage:2026-10-10:${NOW}-[0-9a-f]{8}$`));
  assert.equal(kv.m.get(keys[0]).opts.expirationTtl, USAGE_TTL_S);
  assert.equal(kv.m.get(keys[0]).metadata.fn, "coach_chat");
  assert.equal(await kv.get("usage:2026-10-10"), null); // no shared per-day array any more
  assert.equal(USAGE_TTL_S, 400 * 86400);
  const recent = await recentEntries(kv);
  assert.equal(recent.length, 50);
  assert.equal(recent[0].ts, new Date(NOW + 54).toISOString()); // newest first
});

test("ledger: concurrent calls never overwrite each other (per-call keys); oversized entry read back via get()", async () => {
  const kv = new MemoryKV();
  // a read-then-write day array would lose entries here: every logUsage reads before any writes
  await Promise.all(Array.from({ length: 20 }, () => logUsage(kv, { fn: "coach_chat", usd: 0.01, ok: true }, NOW)));
  assert.equal((await dayEntries(kv, "2026-10-10")).length, 20);
  assert.equal(await spendToday(kv, NOW), 0.2);
  // an entry too big for KV metadata (1024 B) is stored without it and read with get()
  await logUsage(kv, { fn: "narrative_daily", usd: 0.05, ok: false, err: "x".repeat(1500) }, NOW + 1);
  const big = [...kv.m.entries()].find(([k, v]) => k.startsWith("usage:2026-10-10:") && v.metadata === null);
  assert.ok(big);
  assert.equal(await spendToday(kv, NOW), 0.25);
  // a range across a year boundary lists over the common prefix and keeps usage:recent out
  await logUsage(kv, { fn: "coach_chat", usd: 0.5, ok: true }, Date.parse("2026-12-31T12:00:00Z"));
  await logUsage(kv, { fn: "coach_chat", usd: 0.25, ok: true }, Date.parse("2027-01-01T12:00:00Z"));
  const r = await usageRange(kv, "2026-12-30", "2027-01-02");
  assert.deepEqual(r.map(([d, es]) => [d, es.length]), [["2026-12-30", 0], ["2026-12-31", 1], ["2027-01-01", 1], ["2027-01-02", 0]]);
});

test("daily cap: spend summed per Zagreb day; >= cap blocks; default $1.00", async () => {
  const kv = new MemoryKV();
  assert.equal(maxUsdPerDay({}), 1.0);
  assert.equal(maxUsdPerDay({ MAX_USD_PER_DAY: "0.25" }), 0.25);
  assert.equal(maxUsdPerDay({ MAX_USD_PER_DAY: "junk" }), 1.0);
  await logUsage(kv, { usd: 0.4 }, NOW);
  await logUsage(kv, { usd: 0.35 }, NOW);
  await logUsage(kv, { usd: 5 }, NOW - 86400 * 1000); // yesterday does not count
  assert.equal(await spendToday(kv, NOW), 0.75);
  assert.deepEqual(await checkCap({}, kv, NOW), { ok: true, spent: 0.75, cap: 1 });
  await logUsage(kv, { usd: 0.25 }, NOW);
  assert.deepEqual(await checkCap({}, kv, NOW), { ok: false, spent: 1, cap: 1 });
  assert.equal((await checkCap({ MAX_USD_PER_DAY: "2" }, kv, NOW)).ok, true);
});

test("dates: validDate, daysBetween, addDays, isoWeek", () => {
  assert.equal(validDate("2026-02-28"), true);
  assert.equal(validDate("2026-02-30"), false);
  assert.equal(validDate("2026-2-3"), false);
  assert.deepEqual(daysBetween("2026-09-29", "2026-10-02"), ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
  assert.equal(addDays("2026-10-10", -29), "2026-09-11");
  assert.equal(isoWeek("2026-10-10"), "2026-W41");
  assert.equal(isoWeek("2026-12-28"), "2026-W53"); // 2026 starts on a Thursday -> 53 weeks
  assert.equal(isoWeek("2027-01-01"), "2026-W53");
  assert.equal(isoWeek("2027-01-04"), "2027-W01");
  assert.equal(isoWeek("2025-12-29"), "2026-W01");
});

test("aggregate by day / week / month / function / model; skipped counted apart", async () => {
  const kv = new MemoryKV();
  const d1 = Date.parse("2026-10-05T08:00:00Z");
  const d2 = Date.parse("2026-10-10T08:00:00Z");
  await logUsage(kv, { fn: "narrative_workout", model: "claude-opus-5-5", in: 1200, cacheRead: 0, cacheWrite: 2600, out: 450, usd: 0.0268, ok: true }, d1);
  await logUsage(kv, { fn: "coach_chat", model: "claude-haiku-5-5", in: 3000, cacheRead: 2600, cacheWrite: 0, out: 600, usd: 0.000626, ok: true }, d2);
  await logUsage(kv, { fn: "narrative_daily", model: "claude-opus-5-5", in: 0, out: 0, usd: 0, ok: false, err: "http 500" }, d2);
  await logUsage(kv, { fn: "narrative_daily", model: "claude-opus-5-5", usd: 0, ok: false, skipped: true, reason: "cap" }, d2);
  const byDay = await usageRange(kv, "2026-10-01", "2026-10-10");

  const day = aggregate(byDay, "day");
  assert.deepEqual(day.rows.map((r) => [r.key, r.calls, r.skipped, r.errors]), [["2026-10-05", 1, 0, 0], ["2026-10-10", 2, 1, 1]]);
  assert.deepEqual(day.totals, {
    key: "total", calls: 3, inputTokens: 4200, cacheReadTokens: 2600, cacheWriteTokens: 2600,
    outputTokens: 1050, usd: 0.027426, errors: 1, skipped: 1,
  });
  assert.deepEqual(aggregate(byDay, "week").rows.map((r) => r.key), ["2026-W41"]);
  assert.deepEqual(aggregate(byDay, "month").rows.map((r) => [r.key, r.calls]), [["2026-10", 3]]);
  const fn = aggregate(byDay, "function").rows;
  assert.equal(fn[0].key, "narrative_workout"); // sorted by usd desc
  assert.deepEqual(fn.map((r) => r.key).sort(), ["coach_chat", "narrative_daily", "narrative_workout"]);
  const model = aggregate(byDay, "model").rows;
  assert.deepEqual(model.map((r) => [r.key, r.calls, r.usd]), [["claude-opus-5-5", 2, 0.0268], ["claude-haiku-5-5", 1, 0.000626]]);
});
