// Test helpers: in-memory KV (subset of the Workers KV API) and a scripted fetch.
export class MemoryKV {
  constructor() {
    this.m = new Map();
    this.writes = 0;
  }
  async get(key, type) {
    const e = this.m.get(key);
    if (!e) return null;
    return type === "json" ? JSON.parse(e.value) : e.value;
  }
  async put(key, value, opts = {}) {
    this.writes += 1;
    this.m.set(key, { value: String(value), metadata: opts.metadata ?? null, opts });
  }
  async delete(key) {
    this.m.delete(key);
  }
  async list({ prefix = "" } = {}) {
    const keys = [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort()
      .map((name) => ({ name, metadata: this.m.get(name).metadata }));
    return { keys, list_complete: true };
  }
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** routes: [[method, RegExp, handler(url, init) -> Response]]; records calls. */
export function scriptedFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    calls.push({ method, url: String(url), init });
    for (const [m, re, h] of routes) {
      if (m === method && re.test(String(url))) return h(new URL(String(url)), init);
    }
    return jsonResponse({ error: "no route" }, 404);
  };
  f.calls = calls;
  return f;
}

export const noSleep = async () => {};

export function fakeCtx() {
  const tasks = [];
  return { tasks, waitUntil: (p) => tasks.push(p), passThroughOnException() {} };
}
