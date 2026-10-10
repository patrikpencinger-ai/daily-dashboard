// Claude API usage / cost ledger (contract: .foreman/api-contract.md).
//
// KV (binding LIVE)
//   usage:<YYYY-MM-DD>  [entry...] appended per call, TTL 400 d. The day is the Europe/Zagreb date.
//   usage:recent        last 50 entries, newest first, TTL 400 d
// entry = {ts, fn, model, effort, in, cacheRead, cacheWrite, out, usd, ms, ok, err,
//          skipped?, reason?, stop?, servedBy?}
//
// USD = (in x input + cacheRead x cache-read + cacheWrite x cache-write + out x output) / 1e6,
// rates per million tokens from PRICES (Claude API list prices, prompts <= 100K tokens).
// `in` is the API's input_tokens, which already EXCLUDES the cached tokens.

export const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};
export const PRICES_NOTE = "USD per million tokens; Claude API list prices, prompts <= 100K tokens; cache write = 5-minute TTL";
export const USAGE_TTL_S = 400 * 86400;
export const RECENT_MAX = 50;
export const DEFAULT_MAX_USD_PER_DAY = 1.0;
export const MAX_RANGE_DAYS = 366;

const ZG_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Zagreb", year: "numeric", month: "2-digit", day: "2-digit",
});

/** Europe/Zagreb calendar date (YYYY-MM-DD) of an epoch-ms instant. */
export const zgDate = (ms) => ZG_DATE.format(new Date(ms));

const round6 = (x) => Math.round(x * 1e6) / 1e6;
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Price row for a model id. Unknown ids (e.g. a fallback model) are priced at the
 *  most expensive allowed model so the cap errs on the safe side. */
export function priceFor(model) {
  const id = String(model || "");
  if (PRICES[id]) return { ...PRICES[id], known: true };
  return { ...PRICES["claude-opus-5-5"], known: false };
}

/** {in, cacheRead, cacheWrite, out} from an API `usage` object. */
export function tokensOf(usage) {
  const u = usage || {};
  return {
    in: n(u.input_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite: n(u.cache_creation_input_tokens),
    out: n(u.output_tokens),
  };
}

export function usdFor(model, t) {
  const p = priceFor(model);
  return round6((t.in * p.input + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite + t.out * p.output) / 1e6);
}

/**
 * Tokens + USD of one API response. With server-side fallbacks the per-attempt
 * `usage.iterations` is the billing source of truth (top-level usage covers only the
 * attempt that produced the message), so it is summed when present, each attempt at
 * its own model's rate. This can over-count a declined-before-output attempt that is
 * not billed, which is the safe direction for the daily cap.
 */
export function costOf(model, usage) {
  const its = usage && Array.isArray(usage.iterations) ? usage.iterations : null;
  if (its && its.length && its.every((it) => it && typeof it === "object" && "input_tokens" in it)) {
    const tot = { in: 0, cacheRead: 0, cacheWrite: 0, out: 0 };
    let usd = 0;
    for (const it of its) {
      const t = tokensOf(it);
      usd += usdFor(it.model || model, t);
      tot.in += t.in; tot.cacheRead += t.cacheRead; tot.cacheWrite += t.cacheWrite; tot.out += t.out;
    }
    return { ...tot, usd: round6(usd) };
  }
  const t = tokensOf(usage);
  return { ...t, usd: usdFor(model, t) };
}

// ---- ledger -------------------------------------------------------------------

async function readArr(kv, key) {
  const v = await kv.get(key, "json");
  return Array.isArray(v) ? v : [];
}

/** Append one entry to usage:<day> and usage:recent. Never throws (logging must not break a call). */
export async function logUsage(kv, entry, now = Date.now()) {
  const e = { ts: new Date(now).toISOString(), ...entry };
  try {
    const key = `usage:${zgDate(now)}`;
    const day = await readArr(kv, key);
    day.push(e);
    await kv.put(key, JSON.stringify(day), { expirationTtl: USAGE_TTL_S });
    const recent = [e, ...(await readArr(kv, "usage:recent"))].slice(0, RECENT_MAX);
    await kv.put("usage:recent", JSON.stringify(recent), { expirationTtl: USAGE_TTL_S });
  } catch (err) {
    console.error("usage log failed", String(err && err.message ? err.message : err));
  }
  return e;
}

export async function dayEntries(kv, day) {
  return readArr(kv, `usage:${day}`);
}

export async function recentEntries(kv) {
  return readArr(kv, "usage:recent");
}

/** USD spent today (Europe/Zagreb date). */
export async function spendToday(kv, now = Date.now()) {
  let s = 0;
  for (const e of await dayEntries(kv, zgDate(now))) s += n(e.usd);
  return round6(s);
}

export function maxUsdPerDay(env) {
  const v = Number.parseFloat(env && env.MAX_USD_PER_DAY);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MAX_USD_PER_DAY;
}

/** {ok, spent, cap}: ok=false once today's spend has reached the cap. */
export async function checkCap(env, kv, now = Date.now()) {
  const cap = maxUsdPerDay(env);
  const spent = await spendToday(kv, now);
  return { ok: spent < cap, spent, cap };
}

// ---- aggregation (GET /admin/usage) ------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayMs = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const msDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export function validDate(d) {
  return typeof d === "string" && DATE_RE.test(d) && msDay(dayMs(d)) === d;
}

/** Inclusive list of YYYY-MM-DD between from and to (calendar arithmetic, no time zone). */
export function daysBetween(from, to) {
  const out = [];
  for (let t = dayMs(from); t <= dayMs(to); t += 86400 * 1000) out.push(msDay(t));
  return out;
}

/** Calendar date `days` before/after a YYYY-MM-DD date. */
export function addDays(day, days) {
  return msDay(dayMs(day) + days * 86400 * 1000);
}

/** ISO-8601 week key of a calendar date, e.g. "2026-W41". */
export function isoWeek(day) {
  const d = new Date(dayMs(day));
  const wd = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - wd + 3); // Thursday decides the ISO year
  const year = d.getUTCFullYear();
  const firstThu = new Date(Date.UTC(year, 0, 4));
  firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((d - firstThu) / (7 * 86400000));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export const GROUPS = ["day", "week", "month", "function", "model"];

function groupKey(group, e, day) {
  switch (group) {
    case "week": return isoWeek(day);
    case "month": return day.slice(0, 7);
    case "function": return e.fn || "unknown";
    case "model": return e.model || "unknown";
    default: return day;
  }
}

const emptyRow = (key) => ({
  key, calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, usd: 0, errors: 0, skipped: 0,
});

/** rows {key, calls, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, usd, errors, skipped}.
 *  `calls` counts requests sent to the API; entries skipped by the cap are counted under `skipped`. */
export function aggregate(byDay, group) {
  const rows = new Map();
  const total = emptyRow("total");
  for (const [day, entries] of byDay) {
    for (const e of entries) {
      const k = groupKey(group, e, day);
      if (!rows.has(k)) rows.set(k, emptyRow(k));
      for (const r of [rows.get(k), total]) {
        if (e.skipped) { r.skipped += 1; continue; }
        r.calls += 1;
        r.inputTokens += n(e.in);
        r.cacheReadTokens += n(e.cacheRead);
        r.cacheWriteTokens += n(e.cacheWrite);
        r.outputTokens += n(e.out);
        r.usd = round6(r.usd + n(e.usd));
        if (!e.ok) r.errors += 1;
      }
    }
  }
  const list = [...rows.values()];
  if (["day", "week", "month"].includes(group)) list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  else list.sort((a, b) => b.usd - a.usd || (a.key < b.key ? -1 : 1));
  return { rows: list, totals: total };
}

/** Read usage:<day> for every day in [from, to] (the caller bounds the range). */
export async function usageRange(kv, from, to) {
  const days = daysBetween(from, to);
  const vals = await Promise.all(days.map((d) => dayEntries(kv, d)));
  return days.map((d, i) => [d, vals[i]]);
}
