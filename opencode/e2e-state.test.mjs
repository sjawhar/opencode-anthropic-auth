import { mock, test, expect, beforeEach, afterEach, afterAll } from "bun:test";

const T = { db: null, refreshFn: null, fetchCalls: [] };
const originalFetch = globalThis.fetch;

mock.module("./db.mjs", () => ({
  open: () => T.db,
  tryAcquireRefreshLock: (id) => {
    const now = Date.now();
    const result = T.db
      .prepare(
        "UPDATE account SET refresh_lock = ? WHERE id = ? AND (refresh_lock = 0 OR refresh_lock < ?)"
      )
      .run(now, id, now - 30000);
    return result.changes === 1;
  },
  releaseRefreshLock: (id) => {
    T.db.prepare("UPDATE account SET refresh_lock = 0 WHERE id = ?").run(id);
  },
  config: (_key, fb) => fb,
}));

mock.module("../shared/oauth.mjs", () => ({
  CLAUDE_CODE_AGENT: "test-agent/0.0.0",
  CLAUDE_CODE_VERSION: "0.0.0",
  authHeaders: (extra = {}) => ({ "User-Agent": "test-agent/0.0.0", ...extra }),
  authorize: async () => ({}),
  exchange: async () => ({}),
  refreshAccessToken: (...args) => {
    if (!T.refreshFn) throw new Error("T.refreshFn not set");
    return T.refreshFn(...args);
  },
}));

import {
  createTestDb,
  getAccountState,
  authResponse,
  makeRequestBody,
  getInterceptor,
} from "./test-harness.mjs";

beforeEach(() => {
  globalThis.fetch = () => {
    throw new Error("Unmocked fetch call — check test setup");
  };
  T.db = createTestDb();
  T.fetchCalls = [];
  T.refreshFn = null;
});

afterEach(() => {
  T.db?.close(false);
  T.db = null;
  T.fetchCalls = [];
  T.refreshFn = null;
  globalThis.fetch = originalFetch;
});

afterAll(() => { mock.restore(); });

function messagesRequest() {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: makeRequestBody(),
  };
}

test("scenario 10: API key 401 increments failures without OAuth refresh", async () => {
  const apikey = {
    id: "k1",
    label: "apikey",
    type: "apikey",
    access: "sk-test",
    refresh: "",
  };

  let refreshCalled = false;
  T.refreshFn = async () => {
    refreshCalled = true;
    throw new Error("should not refresh API keys");
  };

  const interceptor = await getInterceptor(T, [apikey], () => new Response("", { status: 401 }));
  const startedAt = Date.now();

  const resp = await interceptor("https://api.anthropic.com/v1/messages", messagesRequest());

  expect(resp.status).toBe(401);
  expect(refreshCalled).toBe(false);

  const state = getAccountState(T.db, "k1");
  expect(state.consecutive_failures).toBe(1);
  expect(state.cooldown_until).toBeGreaterThan(startedAt);
  expect(state.status).toBe("active");
});

test("scenario 11: API key 3x 401 marks account dead", async () => {
  const apikey = {
    id: "k1",
    label: "apikey",
    type: "apikey",
    access: "sk-test",
    refresh: "",
  };

  T.refreshFn = async () => {
    throw new Error("should not refresh API keys");
  };

  const interceptor = await getInterceptor(T, [apikey], () => new Response("", { status: 401 }));

  await interceptor("https://api.anthropic.com/v1/messages", messagesRequest());
  await interceptor("https://api.anthropic.com/v1/messages", messagesRequest());
  await interceptor("https://api.anthropic.com/v1/messages", messagesRequest());

  expect(T.fetchCalls).toHaveLength(3);

  const state = getAccountState(T.db, "k1");
  expect(state.consecutive_failures).toBe(3);
  expect(state.status).toBe("dead");
});

test("scenario 12: overage detection triggers proactive switch", async () => {
  const now = Date.now();
  const acc1 = {
    id: "acc-1",
    label: "first",
    type: "oauth",
    refresh: "r1",
    access: "a1",
    expires: now + 3600000,
    util5h: 0.1,
    util5h_at: now,
  };
  const acc2 = {
    id: "acc-2",
    label: "second",
    type: "oauth",
    refresh: "r2",
    access: "a2",
    expires: now + 3600000,
    util5h: 0.9,
    util5h_at: now,
  };

  const interceptor = await getInterceptor(T, [acc1, acc2], (callIdx) => {
    if (callIdx === 0) return authResponse(200, { overage: true });
    return authResponse(200, {});
  });

  await interceptor("https://api.anthropic.com/v1/messages", messagesRequest());

  const firstState = getAccountState(T.db, "acc-1");
  expect(firstState.overage).toBe(1);

  await interceptor("https://api.anthropic.com/v1/messages", messagesRequest());
  await interceptor("https://api.anthropic.com/v1/messages", messagesRequest());

  expect(T.fetchCalls[0].headers.authorization).toBe("Bearer a1");
  expect(T.fetchCalls[1].headers.authorization).toBe("Bearer a2");
  expect(T.fetchCalls[2].headers.authorization).toBe("Bearer a2");
});

test("scenario 13: initial selection matches pickNext(pool, worstDummy)", async () => {
  const now = Date.now();
  const acc1 = {
    id: "acc-1",
    label: "high-util",
    type: "oauth",
    refresh: "r1",
    access: "a1",
    expires: now + 3600000,
    util5h: 0.9,
    util5h_at: now,
  };
  const acc2 = {
    id: "acc-2",
    label: "low-util",
    type: "oauth",
    refresh: "r2",
    access: "a2",
    expires: now + 3600000,
    util5h: 0.1,
    util5h_at: now,
  };
  const apikey = {
    id: "k1",
    label: "apikey",
    type: "apikey",
    access: "sk-test",
    refresh: "",
  };

  const interceptor = await getInterceptor(T, [acc1, acc2, apikey], () => authResponse(200, {}));
  const { __test } = await import("./index.mjs");
  const pool = __test.loadPool();
  const dummy = {
    util5h: Infinity,
    util7d: Infinity,
    overage: true,
    cooloffUntil: Infinity,
    type: "apikey",
  };

  const picked = __test.pickNext(pool, dummy);
  expect(picked.access).toBe("a2");

  await interceptor("https://api.anthropic.com/v1/messages", messagesRequest());
  expect(T.fetchCalls[0].headers.authorization).toBe("Bearer a2");
});

test("scenario 14: stale overage_at clears overage flag on pool load", async () => {
  const now = Date.now();
  const { __test } = await import("./index.mjs");
  const account = {
    id: "acc-1",
    label: "stale-overage",
    type: "oauth",
    refresh: "r1",
    access: "a1",
    expires: now + 3600000,
    overage: 1,
    overage_at: now - __test.STALE_OVERAGE - 1000,
  };

  const interceptor = await getInterceptor(T, [account], () => authResponse(200, {}));
  const raw = getAccountState(T.db, "acc-1");
  const pool = __test.loadPool();

  expect(raw.overage).toBe(1);
  expect(pool.accounts[0].overage).toBe(false);

  await interceptor("https://api.anthropic.com/v1/messages", messagesRequest());
  expect(T.fetchCalls[0].headers.authorization).toBe("Bearer a1");
});

test("scenario 16: auto-migration inserts OAuth credential to pool when pool is empty", async () => {
  const now = Date.now();
  const { AnthropicAuthPlugin } = await import("./index.mjs");

  globalThis.fetch = async (url, req = {}) => {
    const headers = Object.fromEntries(req.headers?.entries?.() ?? []);
    const body = typeof req.body === "string" ? req.body : req.body == null ? "" : String(req.body);
    T.fetchCalls.push({ url, headers, body });
    return authResponse(200, {});
  };

  const plugin = await AnthropicAuthPlugin({ client: {} });
  const loader = await plugin.auth.loader(
    async () => ({
      type: "oauth",
      refresh: "migrated-r",
      access: "migrated-a",
      expires: now + 3600000,
    }),
    { models: {} },
  );

  const rows = T.db.prepare("SELECT * FROM account").all();
  expect(rows).toHaveLength(1);
  expect(rows[0].label).toBe("migrated");
  expect(rows[0].type).toBe("oauth");

  await loader.fetch("https://api.anthropic.com/v1/messages", messagesRequest());
  expect(T.fetchCalls[0].headers.authorization).toBe("Bearer migrated-a");
});

test("scenario 3p: recovery check picks up OAuth with stale overage_at", async () => {
  const now = Date.now();
  const { __test } = await import("./index.mjs");
  const oauth = {
    id: "o1",
    label: "oauth",
    type: "oauth",
    refresh: "r-oauth",
    access: "a-oauth",
    expires: now + 3600000,
    overage: 0,
    overage_at: now - __test.STALE_OVERAGE - 1000,
    cooldown_until: now + 3600000,
  };
  const apikey = {
    id: "k1",
    label: "apikey",
    type: "apikey",
    access: "sk-test",
    refresh: "",
  };

  const interceptor = await getInterceptor(T, [oauth, apikey], () => authResponse(200, {}));

  T.db.prepare("UPDATE account SET cooldown_until = 0 WHERE id = ?").run("o1");

  await interceptor("https://api.anthropic.com/v1/messages", messagesRequest());
  await interceptor("https://api.anthropic.com/v1/messages", messagesRequest());

  expect(T.fetchCalls[0].headers["x-api-key"]).toBe("sk-test");
  expect(T.fetchCalls[1].headers.authorization).toBe("Bearer a-oauth");
});
