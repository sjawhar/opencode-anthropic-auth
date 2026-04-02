import { existsSync } from "node:fs";
import { mock, test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test";
import { STALE_5H, STALE_7D } from "./db.mjs";

const T = { db: null, refreshFn: null, fetchCalls: [] };
const originalFetch = globalThis.fetch;

function ensureConfigTable(db = T.db) {
  db?.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
}

function parseStoredValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;

  const numeric = Number(value);
  return Number.isNaN(numeric) ? value : numeric;
}

function listAccountsRows(dbInstance = T.db) {
  const db = dbInstance || T.db;
  return db.prepare(`
    SELECT
      id, label, type, status, cooldown_until, expires,
      util5h, util5h_at, util7d, util7d_at,
      overage, overage_at, consecutive_failures
    FROM account
  `).all();
}

function removeAccountRow(dbInstance = T.db, id) {
  const db = dbInstance || T.db;
  const result = db.prepare("DELETE FROM account WHERE id = ?").run(id);
  const remaining = db.prepare("SELECT COUNT(*) as count FROM account").get();
  return { deleted: result.changes === 1, remaining: remaining.count };
}

function resetAccountRow(dbInstance = T.db, id) {
  const db = dbInstance || T.db;
  const existing = db.prepare("SELECT id FROM account WHERE id = ?").get(id);
  if (!existing) throw new Error(`Account not found: ${id}`);

  db.prepare(`
    UPDATE account
    SET status = 'active', cooldown_until = 0, consecutive_failures = 0, refresh_lock = 0
    WHERE id = ?
  `).run(id);

  return db.prepare(`
    SELECT
      id, label, type, status, cooldown_until, expires,
      util5h, util5h_at, util7d, util7d_at,
      overage, overage_at, consecutive_failures, refresh_lock
    FROM account WHERE id = ?
  `).get(id);
}

function getAccountHealthRow(dbInstance = T.db, id) {
  const db = dbInstance || T.db;
  const row = db.prepare(`
    SELECT
      id, label, type, status, cooldown_until, expires,
      util5h, util5h_at, util7d, util7d_at,
      overage, overage_at, consecutive_failures
    FROM account WHERE id = ?
  `).get(id);

  if (!row) throw new Error(`Account not found: ${id}`);

  const now = Date.now();
  const isStale5h = now - row.util5h_at > STALE_5H;
  const isStale7d = now - row.util7d_at > STALE_7D;
  const isCoolingDown = row.cooldown_until > now;

  return {
    ...row,
    isStale5h,
    isStale7d,
    isCoolingDown,
    cooldownRemaining: isCoolingDown ? row.cooldown_until - now : 0,
    isDead: row.status === "dead",
  };
}

function setConfigRow(dbInstance = T.db, key, value) {
  const db = dbInstance || T.db;
  if (key !== "prefer_apikey_over_overage") {
    throw new Error(`Unknown config key: ${key}`);
  }

  ensureConfigTable(db);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, value);
}

function listConfigRows(dbInstance = T.db) {
  const db = dbInstance || T.db;
  ensureConfigTable(db);
  return db.prepare("SELECT key, value FROM config").all();
}

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
  config: (key, fallback) => {
    if (!T.db) return fallback;
    ensureConfigTable(T.db);
    const row = T.db.prepare("SELECT value FROM config WHERE key = ?").get(key);
    return row ? parseStoredValue(row.value) : fallback;
  },
  listAccounts: (dbInstance) => listAccountsRows(dbInstance),
  removeAccount: (dbInstance, id) => removeAccountRow(dbInstance, id),
  resetAccount: (dbInstance, id) => resetAccountRow(dbInstance, id),
  getAccountHealth: (dbInstance, id) => getAccountHealthRow(dbInstance, id),
  setConfig: (dbInstance, key, value) => setConfigRow(dbInstance, key, value),
  listConfig: (dbInstance) => listConfigRows(dbInstance),
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
  const { AnthropicAuthPlugin } = await import("./index.mjs");
  const __test = AnthropicAuthPlugin.__test;
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
  const { AnthropicAuthPlugin } = await import("./index.mjs");
  const __test = AnthropicAuthPlugin.__test;
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
  const { AnthropicAuthPlugin } = await import("./index.mjs");
  const __test = AnthropicAuthPlugin.__test;

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

describe("account management fences", () => {
  test("delete last account leaves an empty pool", async () => {
    const { AnthropicAuthPlugin } = await import("./index.mjs");
  const __test = AnthropicAuthPlugin.__test;
    const management = await import("./management.mjs");
    const db = await import("./db.mjs");

    seedAccounts(T.db, [{ id: "solo", label: "Solo", refresh: "r-solo" }]);

    expect(management.removeAccount("solo", T.db)).toEqual({ deleted: true, remaining: 0 });
    expect(db.listAccounts(T.db)).toEqual([]);
    expect(() => __test.loadPool()).not.toThrow();
    expect(__test.loadPool()).toBeNull();
  });

  test("delete active account keeps the remaining account usable", async () => {
    const now = Date.now();
    const { AnthropicAuthPlugin } = await import("./index.mjs");
    const __test = AnthropicAuthPlugin.__test;
    const management = await import("./management.mjs");

    seedAccounts(T.db, [
      { id: "oauth-primary", label: "Primary", refresh: "r1", access: "a1", expires: now + 60_000, util5h: 0.1, util5h_at: now, util7d: 0.1, util7d_at: now },
      { id: "oauth-backup", label: "Backup", refresh: "r2", access: "a2", expires: now + 60_000, util5h: 0.8, util5h_at: now, util7d: 0.8, util7d_at: now },
    ]);

    const dummy = { util5h: Infinity, util7d: Infinity, overage: true, cooloffUntil: Infinity, type: "apikey" };
    const picked = __test.pickNext(__test.loadPool(), dummy);
    const survivorId = picked.id === "oauth-primary" ? "oauth-backup" : "oauth-primary";
    const survivorAccess = survivorId === "oauth-backup" ? "a2" : "a1";

    expect(management.removeAccount(picked.id, T.db)).toEqual({ deleted: true, remaining: 1 });

    const plugin = await AnthropicAuthPlugin({ client: {} });
    const loader = await plugin.auth.loader(async () => null, { models: {} });

    globalThis.fetch = async (url, req = {}) => {
      const headers = Object.fromEntries(req.headers?.entries?.() ?? []);
      T.fetchCalls.push({ url, headers });
      return authResponse(200, {});
    };

    await loader.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {},
      body: makeRequestBody(),
    });

    expect(__test.loadPool().accounts.map((account) => account.id)).toEqual([survivorId]);
    expect(T.fetchCalls).toHaveLength(1);
    expect(T.fetchCalls[0].headers.authorization).toBe(`Bearer ${survivorAccess}`);
  });

  test("auth-store OAuth credentials are not resurrected after the pool was initialized", async () => {
    const now = Date.now();
    const { AnthropicAuthPlugin } = await import("./index.mjs");
    const __test = AnthropicAuthPlugin.__test;
    const management = await import("./management.mjs");

    const persistedId = __test.persistAccountCredentials(
      T.db,
      "Migrated Once",
      {
        account: { uuid: "oauth-seeded" },
        refresh_token: "refresh-seeded",
        access_token: "access-seeded",
        expires_in: 60,
      },
      now,
      "oauth",
    );

    expect(management.removeAccount(persistedId, T.db)).toEqual({ deleted: true, remaining: 0 });

    const plugin = await AnthropicAuthPlugin({ client: {} });
    const provider = { models: {} };
    const loader = await plugin.auth.loader(
      async () => ({ type: "oauth", refresh: "auth-refresh", access: "auth-access", expires: now + 60_000 }),
      provider,
    );

    expect(loader).toEqual({});
    expect(__test.loadPool()).toBeNull();
    expect(T.db.prepare("SELECT COUNT(*) AS count FROM account").get().count).toBe(0);
  });

  test("duplicate labels delete by id only", async () => {
    const management = await import("./management.mjs");
    const db = await import("./db.mjs");

    seedAccounts(T.db, [
      { id: "dup-a", label: "test", refresh: "ra" },
      { id: "dup-b", label: "test", refresh: "rb" },
    ]);

    expect(management.removeAccount("dup-a", T.db)).toEqual({ deleted: true, remaining: 1 });
    expect(db.listAccounts(T.db)).toEqual([
      {
        id: "dup-b",
        label: "test",
        type: "oauth",
        status: "active",
        cooldown_until: 0,
        expires: 0,
        util5h: 0,
        util5h_at: 0,
        util7d: 0,
        util7d_at: 0,
        overage: 0,
        overage_at: 0,
        consecutive_failures: 0,
      },
    ]);
  });

  test("reset preserves OAuth credentials while clearing operational state", async () => {
    const now = Date.now();
    const management = await import("./management.mjs");

    seedAccounts(T.db, [
      {
        id: "oauth-reset",
        label: "OAuth Reset",
        refresh: "refresh-known",
        access: "access-known",
        expires: now + 120_000,
        util5h: 0.4,
        util5h_at: now,
        util7d: 0.2,
        util7d_at: now,
        overage: 1,
        overage_at: now,
        status: "dead",
        cooldown_until: now + 30_000,
        refresh_lock: now,
        consecutive_failures: 3,
        type: "oauth",
      },
    ]);

    management.resetAccount("oauth-reset", T.db);

    const row = T.db.prepare("SELECT * FROM account WHERE id = ?").get("oauth-reset");
    expect(row.refresh).toBe("refresh-known");
    expect(row.access).toBe("access-known");
    expect(row.type).toBe("oauth");
    expect(row.expires).toBe(now + 120_000);
    expect(row.util5h).toBe(0.4);
    expect(row.util7d).toBe(0.2);
    expect(row.status).toBe("active");
    expect(row.cooldown_until).toBe(0);
    expect(row.consecutive_failures).toBe(0);
    expect(row.refresh_lock).toBe(0);
  });

  test("config round-trips through db.config parsing", async () => {
    const management = await import("./management.mjs");
    const db = await import("./db.mjs");

    management.setConfig("prefer_apikey_over_overage", "true", T.db);

    expect(db.config("prefer_apikey_over_overage", false)).toBe(true);
  });

  test("existing auth method labels remain unchanged", async () => {
    const { AnthropicAuthPlugin } = await import("./index.mjs");

    const plugin = await AnthropicAuthPlugin({ client: {} });
    const labels = plugin.auth.methods.map((method) => method.label);

    expect(labels[0]).toBe("Claude Pro/Max");
    expect(labels[1]).toBe("Create an API Key");
    expect(labels[2]).toBe("Manually enter API Key");
    expect(labels).toHaveLength(3);
  });

  test("API key accounts keep their type after reset", async () => {
    const now = Date.now();
    const management = await import("./management.mjs");

    seedAccounts(T.db, [
      {
        id: "apikey-reset",
        label: "Key Reset",
        refresh: "",
        access: "sk-ant-api03-preserve",
        status: "dead",
        cooldown_until: now + 45_000,
        refresh_lock: now,
        consecutive_failures: 2,
        type: "apikey",
      },
    ]);

    management.resetAccount("apikey-reset", T.db);

    const row = T.db.prepare("SELECT type, access, refresh FROM account WHERE id = ?").get("apikey-reset");
    expect(row.type).toBe("apikey");
    expect(row.access).toBe("sk-ant-api03-preserve");
    expect(row.refresh).toBe("");
  });

  test("build verification fences require both bundles", () => {
    expect(existsSync(new URL("./dist/index.mjs", import.meta.url))).toBe(true);
    expect(existsSync(new URL("./dist/tui.mjs", import.meta.url))).toBe(true);
  });

  test("standalone add-account scripts stay deleted", () => {
    expect(existsSync(new URL("./add-account.mjs", import.meta.url))).toBe(false);
    expect(existsSync(new URL("./add-account-lib.mjs", import.meta.url))).toBe(false);
  });
});
