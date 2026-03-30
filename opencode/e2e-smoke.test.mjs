import { mock, test, expect, beforeEach, afterEach } from "bun:test";

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

test("smoke: OAuth account, valid token, 200 response", async () => {
  const now = Date.now();
  const account = {
    id: "acc-1",
    label: "test-oauth",
    refresh: "refresh-tok",
    access: "access-tok",
    expires: now + 3600000,
    type: "oauth",
  };

  const interceptor = await getInterceptor(T, [account], () => {
    return authResponse(200, { utilization: { "5h": 0.3, "7d": 0.2 } });
  });

  const body = makeRequestBody();
  const resp = await interceptor("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  expect(resp.status).toBe(200);
  expect(T.fetchCalls).toHaveLength(1);
  expect(T.fetchCalls[0].headers.authorization).toBe("Bearer access-tok");

  const state = getAccountState(T.db, "acc-1");
  expect(state.util5h).toBeCloseTo(0.3);
  expect(state.util7d).toBeCloseTo(0.2);
});
