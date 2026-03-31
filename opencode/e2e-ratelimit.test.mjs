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

import { rate429 } from "./test-harness.mjs";

test("scenario 6: 429 transient retries in place on same OAuth account", async () => {
  const now = Date.now();
  const account = {
    id: "oauth-1",
    label: "primary-oauth",
    refresh: "refresh-1",
    access: "a-tok-1",
    expires: now + 3600000,
    type: "oauth",
  };

  const interceptor = await getInterceptor(T, [account], (callIdx) => {
    if (callIdx === 0) return rate429({ retryAfter: 1 });
    return authResponse(200, { utilization: { "5h": 0.3, "7d": 0.2 } });
  });

  const startedAt = Date.now();
  const resp = await interceptor("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: makeRequestBody(),
  });
  const elapsedMs = Date.now() - startedAt;

  // Lens 1: request headers
  expect(resp.status).toBe(200);
  expect(elapsedMs).toBeGreaterThanOrEqual(900);
  expect(T.fetchCalls).toHaveLength(2);
  expect(T.fetchCalls[0].headers.authorization).toBe("Bearer a-tok-1");
  expect(T.fetchCalls[1].headers.authorization).toBe("Bearer a-tok-1");

  // Lens 2: DB state
  const state = getAccountState(T.db, "oauth-1");
  expect(state.cooldown_until).toBe(0);
  expect(state.util5h).toBeCloseTo(0.3);
  expect(state.util7d).toBeCloseTo(0.2);

  // Lens 3: next-request behavior
  await interceptor("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: makeRequestBody(),
  });
  expect(T.fetchCalls[2].headers.authorization).toBe("Bearer a-tok-1");
});

test("scenario 7: 429 non-transient rotates to next OAuth account", async () => {
  const now = Date.now();
  const accounts = [
    {
      id: "oauth-1",
      label: "first-oauth",
      refresh: "refresh-1",
      access: "a-tok-1",
      expires: now + 3600000,
      type: "oauth",
    },
    {
      id: "oauth-2",
      label: "second-oauth",
      refresh: "refresh-2",
      access: "a-tok-2",
      expires: now + 3600000,
      type: "oauth",
    },
  ];

  const interceptor = await getInterceptor(T, accounts, (callIdx) => {
    if (callIdx === 0) return rate429({ retryAfter: 30 });
    return authResponse(200, { utilization: { "5h": 0.2 } });
  });

  const startedAt = Date.now();
  const resp = await interceptor("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: makeRequestBody(),
  });

  // Lens 1: request headers
  expect(resp.status).toBe(200);
  expect(T.fetchCalls).toHaveLength(2);
  expect(T.fetchCalls[0].headers.authorization).toBe("Bearer a-tok-1");
  expect(T.fetchCalls[1].headers.authorization).toBe("Bearer a-tok-2");

  // Lens 2: DB state
  const state1 = getAccountState(T.db, "oauth-1");
  expect(state1.cooldown_until).toBeGreaterThanOrEqual(startedAt + 28000);
  expect(state1.cooldown_until).toBeLessThanOrEqual(startedAt + 32000);

  // Lens 3: next-request behavior
  await interceptor("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: makeRequestBody(),
  });
  expect(T.fetchCalls[2].headers.authorization).toBe("Bearer a-tok-2");
});

test("scenario 8: all OAuth 429s fall back to API key as last resort", async () => {
  const now = Date.now();
  const accounts = [
    {
      id: "oauth-1",
      label: "first-oauth",
      refresh: "refresh-1",
      access: "a-tok-1",
      expires: now + 3600000,
      type: "oauth",
    },
    {
      id: "oauth-2",
      label: "second-oauth",
      refresh: "refresh-2",
      access: "a-tok-2",
      expires: now + 3600000,
      type: "oauth",
    },
    {
      id: "apikey-1",
      label: "apikey-backstop",
      refresh: "unused-refresh",
      access: "sk-api-key",
      expires: 0,
      type: "apikey",
    },
  ];

  const interceptor = await getInterceptor(T, accounts, (callIdx) => {
    if (callIdx < 2) return rate429({ retryAfter: 60 });
    return authResponse(200, { utilization: { "5h": 0.1 } });
  });

  const startedAt = Date.now();
  const resp = await interceptor("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: makeRequestBody(),
  });

  // Lens 1: request headers
  expect(resp.status).toBe(200);
  expect(T.fetchCalls).toHaveLength(3);
  expect(T.fetchCalls[0].headers.authorization).toBe("Bearer a-tok-1");
  expect(T.fetchCalls[1].headers.authorization).toBe("Bearer a-tok-2");
  expect(T.fetchCalls[2].headers["x-api-key"]).toBe("sk-api-key");
  expect(T.fetchCalls[2].headers.authorization).toBeUndefined();
  expect(T.fetchCalls[2].headers["anthropic-beta"]).not.toContain("oauth-2025-04-20");

  // Lens 2: DB state
  const oauth1 = getAccountState(T.db, "oauth-1");
  const oauth2 = getAccountState(T.db, "oauth-2");
  expect(oauth1.cooldown_until).toBeGreaterThan(startedAt);
  expect(oauth2.cooldown_until).toBeGreaterThan(startedAt);

  // Lens 3: next-request behavior
  await interceptor("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: makeRequestBody(),
  });
  expect(T.fetchCalls[3].headers["x-api-key"]).toBe("sk-api-key");
});

test("scenario 9: successful API key request recovers back to OAuth when cooldown clears", async () => {
  const now = Date.now();
  const oauthId = "oauth-1";
  const accounts = [
    {
      id: oauthId,
      label: "recoverable-oauth",
      refresh: "refresh-1",
      access: "a-tok-1",
      expires: now + 3600000,
      cooldown_until: now + 3600000,
      overage: 0,
      overage_at: now,
      type: "oauth",
    },
    {
      id: "apikey-1",
      label: "apikey-current",
      refresh: "unused-refresh",
      access: "sk-api-key",
      expires: 0,
      type: "apikey",
    },
  ];

  const interceptor = await getInterceptor(T, accounts, () => authResponse(200, { utilization: { "5h": 0.1 } }));

  T.db.prepare("UPDATE account SET cooldown_until = 0 WHERE id = ?").run(oauthId);

  const firstResp = await interceptor("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: makeRequestBody(),
  });

  // Lens 1: request headers
  expect(firstResp.status).toBe(200);
  expect(T.fetchCalls[0].headers["x-api-key"]).toBe("sk-api-key");
  expect(T.fetchCalls[0].headers.authorization).toBeUndefined();

  // Lens 2: DB state
  const state = getAccountState(T.db, oauthId);
  expect(state.cooldown_until).toBe(0);
  expect(state.overage).toBe(0);

  // Lens 3: next-request behavior
  await interceptor("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: makeRequestBody(),
  });
  expect(T.fetchCalls[1].headers.authorization).toBe("Bearer a-tok-1");
  expect(T.fetchCalls[1].headers["x-api-key"]).toBeUndefined();
});

test("scenario 15: retry-after-ms drives cooldown instead of far-future reset headers", async () => {
  const now = Date.now();
  const farFutureReset = new Date(now + 86400000).toISOString();
  const accounts = [
    {
      id: "oauth-1",
      label: "first-oauth",
      refresh: "refresh-1",
      access: "a-tok-1",
      expires: now + 3600000,
      type: "oauth",
    },
    {
      id: "oauth-2",
      label: "second-oauth",
      refresh: "refresh-2",
      access: "a-tok-2",
      expires: now + 3600000,
      type: "oauth",
    },
  ];

  const interceptor = await getInterceptor(T, accounts, (callIdx) => {
    if (callIdx === 0) {
      return rate429({
        retryAfterMs: 5000,
        resets: { requests: farFutureReset },
      });
    }
    return authResponse(200, { utilization: { "7d": 0.25 } });
  });

  const startedAt = Date.now();
  const resp = await interceptor("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: makeRequestBody(),
  });

  // Lens 1: request headers
  expect(resp.status).toBe(200);
  expect(T.fetchCalls).toHaveLength(2);
  expect(T.fetchCalls[0].headers.authorization).toBe("Bearer a-tok-1");
  expect(T.fetchCalls[1].headers.authorization).toBe("Bearer a-tok-2");

  // Lens 2: DB state
  const state1 = getAccountState(T.db, "oauth-1");
  expect(state1.cooldown_until).toBeGreaterThanOrEqual(startedAt + 3000);
  expect(state1.cooldown_until).toBeLessThanOrEqual(startedAt + 7000);
  expect(state1.cooldown_until).toBeLessThan(startedAt + 60000);

  // Lens 3: next-request behavior
  await interceptor("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: makeRequestBody(),
  });
  expect(T.fetchCalls[2].headers.authorization).toBe("Bearer a-tok-2");
});
