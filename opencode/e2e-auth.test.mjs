import { mock, describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";

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

import { AnthropicAuthPlugin } from "./index.mjs";
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
  expect(T.db).toBeInstanceOf(Database);
  expect(typeof AnthropicAuthPlugin).toBe("function");
});

afterEach(() => {
  T.db?.close(false);
  T.db = null;
  T.fetchCalls = [];
  T.refreshFn = null;
  globalThis.fetch = originalFetch;
});

afterAll(() => { mock.restore(); });

describe("auth lifecycle", () => {
  test("scenario 1: happy path - OAuth valid token returns 200", async () => {
    const now = Date.now();
    const account = {
      id: "acc-1",
      label: "test-oauth",
      type: "oauth",
      refresh: "r-tok",
      access: "a-tok",
      expires: now + 3600000,
    };

    const interceptor = await getInterceptor(T, [account], () =>
      authResponse(200, { utilization: { "5h": 0.3, "7d": 0.2 } })
    );

    const resp = await interceptor("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: makeRequestBody(),
    });

    // Lens 1: request headers
    expect(resp.status).toBe(200);
    expect(T.fetchCalls).toHaveLength(1);
    expect(T.fetchCalls[0].headers.authorization).toBe("Bearer a-tok");
    expect(T.fetchCalls[0].headers["anthropic-beta"]).toContain("oauth-2025-04-20");

    // Lens 2: DB state
    const state = getAccountState(T.db, "acc-1");
    expect(state.util5h).toBeCloseTo(0.3);
    expect(state.util7d).toBeCloseTo(0.2);

    // Lens 3: next-request behavior
    await interceptor("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {},
      body: makeRequestBody(),
    });
    expect(T.fetchCalls[1].headers.authorization).toBe("Bearer a-tok");
  });

  test("scenario 2: expired token triggers refresh and uses new token", async () => {
    const now = Date.now();
    const account = {
      id: "acc-1",
      label: "test-oauth",
      type: "oauth",
      refresh: "old-r",
      access: "old-a",
      expires: now - 10000,
    };

    T.refreshFn = async (refreshToken) => {
      expect(refreshToken).toBe("old-r");
      return { refresh: "new-r", access: "new-a", expires: now + 3600000 };
    };

    const interceptor = await getInterceptor(T, [account], () => authResponse(200, {}));

    const resp = await interceptor("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {},
      body: makeRequestBody(),
    });

    // Lens 1: request headers
    expect(resp.status).toBe(200);
    expect(T.fetchCalls[0].headers.authorization).toBe("Bearer new-a");

    // Lens 2: DB state
    const state = getAccountState(T.db, "acc-1");
    expect(state.refresh).toBe("new-r");
    expect(state.access).toBe("new-a");
    expect(state.consecutive_failures).toBe(0);

    // Lens 3: next-request behavior
    await interceptor("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {},
      body: makeRequestBody(),
    });
    expect(T.fetchCalls[1].headers.authorization).toBe("Bearer new-a");
  });

  test("scenario 3: refresh failure rotates to second account", async () => {
    const now = Date.now();
    const acc1 = {
      id: "acc-1",
      label: "first",
      type: "oauth",
      refresh: "r1",
      access: "a1",
      expires: now - 10000,
    };
    const acc2 = {
      id: "acc-2",
      label: "second",
      type: "oauth",
      refresh: "r2",
      access: "a2",
      expires: now + 3600000,
    };

    let refreshCallCount = 0;
    T.refreshFn = async (refreshToken) => {
      refreshCallCount++;
      if (refreshToken === "r1") throw new Error("refresh failed for acc1");
      return { refresh: "r2-new", access: "a2-new", expires: now + 3600000 };
    };

    const interceptor = await getInterceptor(T, [acc1, acc2], () => authResponse(200, {}));

    const resp = await interceptor("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {},
      body: makeRequestBody(),
    });

    // Lens 1: request headers
    expect(resp.status).toBe(200);
    expect(refreshCallCount).toBe(1);
    expect(T.fetchCalls[0].headers.authorization).toBe("Bearer a2");

    // Lens 2: DB state
    const state1 = getAccountState(T.db, "acc-1");
    expect(state1.cooldown_until).toBeGreaterThan(Date.now());

    // Lens 3: next-request behavior
    await interceptor("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {},
      body: makeRequestBody(),
    });
    expect(T.fetchCalls[1].headers.authorization).toBe("Bearer a2");
  });

  test("scenario 4: 401 triggers refresh and retries same account", async () => {
    const now = Date.now();
    const account = {
      id: "acc-1",
      label: "test-oauth",
      type: "oauth",
      refresh: "r-tok",
      access: "a-tok",
      expires: now + 3600000,
    };

    T.refreshFn = async () => ({
      refresh: "r-new",
      access: "a-new",
      expires: now + 7200000,
    });

    let callIdx = 0;
    const interceptor = await getInterceptor(T, [account], () => {
      if (callIdx++ === 0) {
        T.db.prepare("UPDATE account SET expires = 0 WHERE id = ?").run("acc-1");
        return new Response("", { status: 401 });
      }
      return authResponse(200, {});
    });

    const resp = await interceptor("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {},
      body: makeRequestBody(),
    });

    // Lens 1: request headers
    expect(resp.status).toBe(200);
    expect(T.fetchCalls).toHaveLength(2);
    expect(T.fetchCalls[0].headers.authorization).toBe("Bearer a-tok");
    expect(T.fetchCalls[1].headers.authorization).toBe("Bearer a-new");

    // Lens 2: DB state
    const state = getAccountState(T.db, "acc-1");
    expect(state.access).toBe("a-new");

    // Lens 3: next-request behavior
    await interceptor("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {},
      body: makeRequestBody(),
    });
    expect(T.fetchCalls[2].headers.authorization).toBe("Bearer a-new");
  });

  test("scenario 5: 401 refresh failure rotates through all accounts", async () => {
    const now = Date.now();
    const acc1 = {
      id: "acc-1",
      label: "first",
      type: "oauth",
      refresh: "r1",
      access: "a1",
      expires: now + 3600000,
    };
    const acc2 = {
      id: "acc-2",
      label: "second",
      type: "oauth",
      refresh: "r2",
      access: "a2",
      expires: now + 3600000,
    };
    const acc3 = {
      id: "acc-3",
      label: "third",
      type: "oauth",
      refresh: "r3",
      access: "a3",
      expires: now + 3600000,
    };

    const refreshAttempts = [];
    T.refreshFn = async (refreshToken) => {
      refreshAttempts.push(refreshToken);
      throw new Error(`refresh failed for ${refreshToken}`);
    };

    let callCount = 0;
    const interceptor = await getInterceptor(T, [acc1, acc2, acc3], () => {
      callCount++;
      if (callCount === 1) {
        T.db.prepare("UPDATE account SET expires = 0 WHERE id = ?").run("acc-1");
        return new Response("", { status: 401 });
      }
      if (callCount === 2) return new Response("", { status: 401 });
      return authResponse(200, {});
    });

    const resp = await interceptor("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {},
      body: makeRequestBody(),
    });

    // Lens 1: request headers
    expect(resp.status).toBe(200);
    expect(refreshAttempts).toEqual(["r1"]);
    expect(T.fetchCalls).toHaveLength(3);
    expect(T.fetchCalls[0].headers.authorization).toBe("Bearer a1");
    expect(T.fetchCalls[1].headers.authorization).toBe("Bearer a2");
    expect(T.fetchCalls[2].headers.authorization).toBe("Bearer a3");

    // Lens 2: DB state
    const state1 = getAccountState(T.db, "acc-1");
    const state2 = getAccountState(T.db, "acc-2");
    expect(state1.cooldown_until).toBeGreaterThan(Date.now());
    expect(state2.cooldown_until).toBeGreaterThan(Date.now());

    // Lens 3: next-request behavior
    await interceptor("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {},
      body: makeRequestBody(),
    });
    expect(T.fetchCalls[3].headers.authorization).toBe("Bearer a3");
  });
});
