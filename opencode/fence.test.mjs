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
  seedAccounts,
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

// ─── Fence 1: API keys never undergo OAuth refresh ──────────────────────────
test("fence 1: API keys never undergo OAuth refresh", async () => {
  const now = Date.now();
  let refreshCalled = false;
  T.refreshFn = async () => { refreshCalled = true; return {}; };

  const apikey = { id: "k1", label: "apikey1", type: "apikey", access: "sk-test", refresh: "" };
  const oauth = {
    id: "o1", label: "oauth1", type: "oauth", access: "a-tok", refresh: "r-tok",
    expires: now + 3600000, cooldown_until: now + 3600000,
  };

  for (const status of [401, 403, 429, 500]) {
    T.db?.close(false);
    T.db = createTestDb();
    T.fetchCalls = [];
    refreshCalled = false;

    const interceptor = await getInterceptor(
      T,
      [{ ...oauth, cooldown_until: now + 3600000 }, apikey],
      () => new Response("", { status }),
    );

    try {
      await interceptor("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: {}, body: makeRequestBody(),
      });
    } catch {}

    expect(refreshCalled).toBe(false);
  }
});

// ─── Fence 2: OAuth always preferred over API key ───────────────────────────
test("fence 2: OAuth always preferred over API key when available", async () => {
  const { __test } = await import("./index.mjs");
  const now = Date.now();

  // Dummy "current" that won't match any pool account by reference
  const dummy = {
    id: "dummy", label: "dummy", type: "apikey",
    util5h: Infinity, util7d: Infinity, overage: true, cooloffUntil: Infinity,
    access: "", refresh: "", expires: 0, status: "active",
  };

  const configs = [
    { oauthOverrides: { util5h: 0, util7d: 0 } },
    { oauthOverrides: { util5h: 0.5, util7d: 0.3 } },
    { oauthOverrides: { overage: true, util5h: 0.1, util7d: 0.05 } },
    { oauthOverrides: { util5h: 0.9, util7d: 0.85 } },
    { oauthOverrides: { util5h: 0.99, util7d: 0.99 } },
  ];

  for (const { oauthOverrides } of configs) {
    const oauthAcc = {
      id: "o1", label: "oauth1", type: "oauth", access: "a-tok", refresh: "r",
      expires: now + 3600000, util5h: 0, util7d: 0, overage: false,
      cooloffUntil: 0, status: "active", ...oauthOverrides,
    };
    const apikeyAcc = {
      id: "k1", label: "apikey1", type: "apikey", access: "sk-key", refresh: "",
      expires: 0, util5h: 0, util7d: 0, overage: false,
      cooloffUntil: 0, status: "active",
    };
    const pool = { accounts: [oauthAcc, apikeyAcc] };

    const picked = __test.pickNext(pool, dummy);
    expect(picked.type).toBe("oauth");
  }
});

// ─── Fence 3: Cooldown ceiling from reset headers ──────────────────────────
test("fence 3: parseCooldown result never exceeds MAX_COOLDOWN_FROM_RESET from reset headers", async () => {
  const { __test } = await import("./index.mjs");
  const now = Date.now();

  const farFutureTimes = [
    now + 60 * 60 * 1000,              // 1 hour
    now + 24 * 60 * 60 * 1000,         // 1 day
    now + 7 * 24 * 60 * 60 * 1000,     // 1 week
    now + 30 * 24 * 60 * 60 * 1000,    // 1 month
    now + 365 * 24 * 60 * 60 * 1000,   // 1 year
    now + 1000000000,                   // way in the future
    now + 86401000,                     // 24 hours + 1 second
    now + 7201000,                      // 2 hours + 1 second
    now + 3601000,                      // 1 hour + 1 second
    now + 1800001,                      // 30 minutes + 1ms
  ];

  for (const futureTime of farFutureTimes) {
    const iso = new Date(futureTime).toISOString();
    const resp = new Response("", {
      headers: { "anthropic-ratelimit-requests-reset": iso },
    });
    const result = __test.parseCooldown(resp, now);
    const delta = result - now;

    expect(delta).toBeLessThanOrEqual(__test.MAX_COOLDOWN_FROM_RESET);
    expect(delta).toBeGreaterThan(0);
  }
});

// ─── Fence 4: Dead accounts never selected ─────────────────────────────────
test("fence 4: dead accounts never returned by loadPool", async () => {
  const { __test } = await import("./index.mjs");

  seedAccounts(T.db, [
    { id: "active1", label: "a1", refresh: "r1", status: "active" },
    { id: "dead1", label: "d1", refresh: "r2", status: "dead" },
    { id: "active2", label: "a2", refresh: "r3", status: "active" },
    { id: "dead2", label: "d2", refresh: "r4", status: "dead" },
  ]);

  const pool = __test.loadPool();
  expect(pool).not.toBeNull();
  expect(pool.accounts).toHaveLength(2);

  for (const account of pool.accounts) {
    expect(account.status).not.toBe("dead");
  }

  const ids = pool.accounts.map((a) => a.id).sort();
  expect(ids).toEqual(["active1", "active2"]);
});

// ─── Fence 5: No leaked refresh locks ──────────────────────────────────────
test("fence 5: no refresh locks remain after successful operation", async () => {
  const now = Date.now();
  const account = {
    id: "acc-1", label: "test", type: "oauth",
    refresh: "r-tok", access: "a-tok", expires: now - 10000,
  };

  T.refreshFn = async () => ({
    refresh: "r-new", access: "a-new", expires: now + 3600000,
  });

  const interceptor = await getInterceptor(T, [account], () =>
    authResponse(200, {}),
  );

  await interceptor("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: {}, body: makeRequestBody(),
  });

  const rows = T.db.prepare("SELECT id, refresh_lock FROM account").all();
  for (const row of rows) {
    expect(row.refresh_lock).toBe(0);
  }
});

// ─── Fence 6: Util always saved after successful call ──────────────────────
test("fence 6: util timestamps updated after every successful request", async () => {
  const now = Date.now();
  const account = {
    id: "acc-1", label: "test", type: "oauth",
    refresh: "r-tok", access: "a-tok", expires: now + 3600000,
  };

  const interceptor = await getInterceptor(T, [account], () =>
    authResponse(200, { utilization: { "5h": 0.4, "7d": 0.3 } }),
  );

  const before = Date.now();
  await interceptor("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: {}, body: makeRequestBody(),
  });
  const after = Date.now();

  const state = getAccountState(T.db, "acc-1");

  expect(state.util5h_at).toBeGreaterThanOrEqual(before);
  expect(state.util5h_at).toBeLessThanOrEqual(after + 100);
  expect(state.util7d_at).toBeGreaterThanOrEqual(before);
  expect(state.util7d_at).toBeLessThanOrEqual(after + 100);

  expect(state.util5h).toBeCloseTo(0.4);
  expect(state.util7d).toBeCloseTo(0.3);
});
