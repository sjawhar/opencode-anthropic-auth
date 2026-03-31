import { mock, describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";

// --- Mock setup (needed for loadPool tests) ---
const T = { db: null };

mock.module("./db.mjs", () => ({
  open: () => T.db,
  tryAcquireRefreshLock: () => true,
  releaseRefreshLock: () => {},
  config: (_key, fb) => fb,
}));

mock.module("../shared/oauth.mjs", () => ({
  CLAUDE_CODE_AGENT: "test-agent/0.0.0",
  CLAUDE_CODE_VERSION: "0.0.0",
  authHeaders: (extra = {}) => ({ "User-Agent": "test-agent/0.0.0", ...extra }),
  authorize: async () => ({}),
  exchange: async () => ({}),
  refreshAccessToken: async () => {
    throw new Error("not implemented");
  },
}));

import { __test } from "./index.mjs";
import { createTestDb, seedAccounts } from "./test-harness.mjs";

beforeEach(() => {
  T.db = createTestDb();
});

afterEach(() => {
  T.db?.close(false);
  T.db = null;
});

afterAll(() => { mock.restore(); });

// Helper: create a mock Response with given headers
const makeResp = (headers) => new Response("", { headers });

// Helper: create an account object for pickNext tests
function makeAccount(overrides = {}) {
  return {
    id: overrides.id || `acc-${Math.random().toString(36).slice(2)}`,
    label: overrides.label || "test",
    type: overrides.type || "oauth",
    util5h: overrides.util5h ?? 0,
    util7d: overrides.util7d ?? 0,
    overage: overrides.overage ?? false,
    cooloffUntil: overrides.cooloffUntil ?? 0,
    status: overrides.status || "active",
    refresh: "",
    access: "",
    expires: 0,
    overageAt: 0,
  };
}

// ─── parseCooldown (~12 tests) ──────────────────────────────────────────────

describe("parseCooldown", () => {
  // Bug Class 1 regression: retry-after-ms wins over reset headers
  test("retry-after-ms wins over reset headers", () => {
    const now = 1000000;
    const resp = makeResp({
      "retry-after-ms": "5000",
      "anthropic-ratelimit-requests-reset": new Date(
        now + 86400000,
      ).toISOString(),
    });
    expect(__test.parseCooldown(resp, now)).toBe(now + 5000);
  });

  // Bug Class 1 regression: retry-after (seconds) wins over reset headers
  test("retry-after (seconds) wins over reset headers", () => {
    const now = 1000000;
    const resp = makeResp({
      "retry-after": "30",
      "anthropic-ratelimit-requests-reset": new Date(
        now + 86400000,
      ).toISOString(),
    });
    expect(__test.parseCooldown(resp, now)).toBe(now + 30000);
  });

  // Bug Class 1 regression: far-future reset capped
  test("far-future reset header is capped at MAX_COOLDOWN_FROM_RESET", () => {
    const now = 1000000;
    const farFuture = new Date(now + 86400000).toISOString();
    const resp = makeResp({
      "anthropic-ratelimit-requests-reset": farFuture,
    });
    const result = __test.parseCooldown(resp, now);
    expect(result).toBe(now + __test.MAX_COOLDOWN_FROM_RESET);
    expect(result).toBeLessThanOrEqual(now + 300000);
  });

  test("uses earliest when multiple reset headers", () => {
    const now = 1000000;
    const sooner = new Date(now + 60000).toISOString(); // 60s
    const later = new Date(now + 120000).toISOString(); // 120s
    const resp = makeResp({
      "anthropic-ratelimit-requests-reset": later,
      "anthropic-ratelimit-tokens-reset": sooner,
    });
    expect(__test.parseCooldown(resp, now)).toBe(now + 60000);
  });

  test("past reset header uses CLOCK_SKEW_BUFFER", () => {
    const now = 1000000;
    const past = new Date(now - 10000).toISOString();
    const resp = makeResp({
      "anthropic-ratelimit-requests-reset": past,
    });
    // CLOCK_SKEW_BUFFER = 2000 (not in __test exports)
    expect(__test.parseCooldown(resp, now)).toBe(now + 2000);
  });

  test("no headers returns FALLBACK_COOLDOWN", () => {
    const now = 1000000;
    const resp = makeResp({});
    expect(__test.parseCooldown(resp, now)).toBe(now + __test.FALLBACK_COOLDOWN);
  });

  test("NaN reset header is skipped", () => {
    const now = 1000000;
    const resp = makeResp({
      "anthropic-ratelimit-requests-reset": "not-a-date",
    });
    expect(__test.parseCooldown(resp, now)).toBe(now + __test.FALLBACK_COOLDOWN);
  });

  test("retry-after-ms of 0 falls through to fallback", () => {
    const now = 1000000;
    const resp = makeResp({ "retry-after-ms": "0" });
    expect(__test.parseCooldown(resp, now)).toBe(now + __test.FALLBACK_COOLDOWN);
  });

  test("negative retry-after falls through to fallback", () => {
    const now = 1000000;
    const resp = makeResp({ "retry-after": "-1" });
    expect(__test.parseCooldown(resp, now)).toBe(now + __test.FALLBACK_COOLDOWN);
  });

  test("retry-after-ms takes precedence over retry-after", () => {
    const now = 1000000;
    const resp = makeResp({ "retry-after-ms": "3000", "retry-after": "60" });
    expect(__test.parseCooldown(resp, now)).toBe(now + 3000);
  });

  test("mixed valid/invalid reset headers uses earliest valid", () => {
    const now = 1000000;
    const valid = new Date(now + 60000).toISOString();
    const resp = makeResp({
      "anthropic-ratelimit-requests-reset": valid,
      "anthropic-ratelimit-tokens-reset": "garbage",
    });
    // 60000 < MAX_COOLDOWN_FROM_RESET (300000) so no capping
    expect(__test.parseCooldown(resp, now)).toBe(now + 60000);
  });

  test("returns absolute timestamp not duration", () => {
    const now = 5000000; // high baseline
    const resp = makeResp({ "retry-after-ms": "1000" });
    const result = __test.parseCooldown(resp, now);
    expect(result).toBe(5001000); // now + 1000
    expect(result).toBeGreaterThan(now);
  });
});

// ─── pickNext (~8 tests) ────────────────────────────────────────────────────

describe("pickNext", () => {
  // Bug Class 2: OAuth preferred over API key
  test("OAuth preferred over API key when both available", () => {
    const current = makeAccount({ id: "c" });
    const oauth = makeAccount({ id: "o1", type: "oauth", util5h: 0.5 });
    const apikey = makeAccount({ id: "ak", type: "apikey", util5h: 0.1 });
    const pool = { accounts: [current, oauth, apikey] };
    const picked = __test.pickNext(pool, current);
    // OAuth wins even though apikey has lower utilization
    expect(picked.id).toBe("o1");
  });

  test("API key selected when all OAuth on cooldown", () => {
    const now = Date.now();
    const current = makeAccount({ id: "c", type: "oauth" });
    const o1 = makeAccount({
      id: "o1",
      type: "oauth",
      cooloffUntil: now + 999999,
    });
    const apikey = makeAccount({ id: "ak", type: "apikey" });
    const pool = { accounts: [current, o1, apikey] };
    const picked = __test.pickNext(pool, current);
    expect(picked.id).toBe("ak");
  });

  test("non-overage preferred over overage", () => {
    const current = makeAccount({ id: "c" });
    const inOverage = makeAccount({
      id: "o1",
      overage: true,
      util5h: 0.1,
    });
    const normal = makeAccount({ id: "o2", overage: false, util5h: 0.9 });
    const pool = { accounts: [current, inOverage, normal] };
    const picked = __test.pickNext(pool, current);
    // non-overage wins even with higher utilization
    expect(picked.id).toBe("o2");
  });

  test("lowest utilization wins among equals", () => {
    const current = makeAccount({ id: "c" });
    const high = makeAccount({ id: "o1", util5h: 0.8 });
    const low = makeAccount({ id: "o2", util5h: 0.2 });
    const pool = { accounts: [current, high, low] };
    const picked = __test.pickNext(pool, current);
    expect(picked.id).toBe("o2");
  });

  test("current account excluded from candidates", () => {
    const current = makeAccount({ id: "c", util5h: 0 }); // lowest util
    const other = makeAccount({ id: "o1", util5h: 0.9 });
    const pool = { accounts: [current, other] };
    const picked = __test.pickNext(pool, current);
    // current excluded despite having lowest util
    expect(picked.id).toBe("o1");
  });

  test("all accounts on cooldown returns current", () => {
    const now = Date.now();
    const current = makeAccount({ id: "c" });
    const a1 = makeAccount({ id: "a1", cooloffUntil: now + 999999 });
    const a2 = makeAccount({ id: "a2", cooloffUntil: now + 999999 });
    const pool = { accounts: [current, a1, a2] };
    const picked = __test.pickNext(pool, current);
    expect(picked).toBe(current);
  });

  // Bug Class 5: dummy simulates worst-possible current to get optimal pick
  test("dummy produces same result as pickNext with optimal pick", () => {
    const o1 = makeAccount({ id: "o1", util5h: 0.5 });
    const o2 = makeAccount({ id: "o2", util5h: 0.2 }); // lower util
    const pool = { accounts: [o1, o2] };
    const dummy = {
      util5h: Infinity,
      util7d: Infinity,
      overage: true,
      cooloffUntil: Infinity,
      type: "apikey",
    };
    const picked = __test.pickNext(pool, dummy);
    // dummy not in pool, so both o1/o2 available; lowest util wins
    expect(picked.id).toBe("o2");
  });

  test("single account in pool returns that account (no alternatives)", () => {
    const sole = makeAccount({ id: "sole" });
    const pool = { accounts: [sole] };
    const picked = __test.pickNext(pool, sole);
    // sole is current, excluded from candidates → returns current
    expect(picked).toBe(sole);
  });
});

// ─── parseUtil (~5 tests) ───────────────────────────────────────────────────

describe("parseUtil", () => {
  test("all three util headers update account fields", () => {
    const account = { util5h: 0, util7d: 0, overage: false, label: "test" };
    const resp = makeResp({
      "anthropic-ratelimit-unified-5h-utilization": "0.7",
      "anthropic-ratelimit-unified-7d-utilization": "0.5",
      "anthropic-ratelimit-unified-overage-in-use": "true",
    });
    __test.parseUtil(resp, account);
    expect(account.util5h).toBeCloseTo(0.7);
    expect(account.util7d).toBeCloseTo(0.5);
    expect(account.overage).toBe(true);
  });

  test("partial headers only update present fields", () => {
    const account = { util5h: 0.3, util7d: 0.5, overage: true, label: "test" };
    const resp = makeResp({
      "anthropic-ratelimit-unified-5h-utilization": "0.8",
    });
    __test.parseUtil(resp, account);
    expect(account.util5h).toBeCloseTo(0.8); // updated
    expect(account.util7d).toBeCloseTo(0.5); // unchanged
    expect(account.overage).toBe(true); // unchanged
  });

  test("no headers leaves account unchanged", () => {
    const account = { util5h: 0.3, util7d: 0.5, overage: true, label: "test" };
    const resp = makeResp({});
    __test.parseUtil(resp, account);
    expect(account.util5h).toBeCloseTo(0.3);
    expect(account.util7d).toBeCloseTo(0.5);
    expect(account.overage).toBe(true);
  });

  test("overage-in-use: true sets overage to true", () => {
    const account = { util5h: 0, util7d: 0, overage: false, label: "test" };
    const resp = makeResp({
      "anthropic-ratelimit-unified-overage-in-use": "true",
    });
    __test.parseUtil(resp, account);
    expect(account.overage).toBe(true);
  });

  test("overage-in-use: false clears overage", () => {
    const account = { util5h: 0, util7d: 0, overage: true, label: "test" };
    const resp = makeResp({
      "anthropic-ratelimit-unified-overage-in-use": "false",
    });
    __test.parseUtil(resp, account);
    expect(account.overage).toBe(false);
  });
});

// ─── loadPool (~7 tests) ────────────────────────────────────────────────────

describe("loadPool", () => {
  // Bug Class 4: stale data handling
  test("stale overage_at makes overage: false", () => {
    const staleAt = Date.now() - __test.STALE_OVERAGE - 1000;
    seedAccounts(T.db, [
      { id: "a1", label: "l1", refresh: "r", overage: 1, overage_at: staleAt },
    ]);
    const pool = __test.loadPool();
    expect(pool.accounts[0].overage).toBe(false);
  });

  test("fresh overage_at preserves overage value", () => {
    const freshAt = Date.now() - 60000; // 1 min ago, well within STALE_OVERAGE (30 min)
    seedAccounts(T.db, [
      { id: "a1", label: "l1", refresh: "r", overage: 1, overage_at: freshAt },
    ]);
    const pool = __test.loadPool();
    expect(pool.accounts[0].overage).toBe(true);
  });

  test("stale util5h_at returns util5h: 0", () => {
    const staleAt = Date.now() - __test.STALE_5H - 1000;
    seedAccounts(T.db, [
      { id: "a1", label: "l1", refresh: "r", util5h: 0.7, util5h_at: staleAt },
    ]);
    const pool = __test.loadPool();
    expect(pool.accounts[0].util5h).toBe(0);
  });

  test("stale util7d_at returns util7d: 0", () => {
    const staleAt = Date.now() - __test.STALE_7D - 1000;
    seedAccounts(T.db, [
      { id: "a1", label: "l1", refresh: "r", util7d: 0.5, util7d_at: staleAt },
    ]);
    const pool = __test.loadPool();
    expect(pool.accounts[0].util7d).toBe(0);
  });

  test("fresh util values preserved", () => {
    const freshAt = Date.now() - 60000; // 1 min ago
    seedAccounts(T.db, [
      {
        id: "a1",
        label: "l1",
        refresh: "r",
        util5h: 0.7,
        util5h_at: freshAt,
        util7d: 0.3,
        util7d_at: freshAt,
      },
    ]);
    const pool = __test.loadPool();
    expect(pool.accounts[0].util5h).toBeCloseTo(0.7);
    expect(pool.accounts[0].util7d).toBeCloseTo(0.3);
  });

  test("dead accounts excluded", () => {
    seedAccounts(T.db, [
      { id: "a1", label: "l1", refresh: "r", status: "active" },
      { id: "a2", label: "l2", refresh: "r", status: "dead" },
    ]);
    const pool = __test.loadPool();
    expect(pool.accounts).toHaveLength(1);
    expect(pool.accounts[0].id).toBe("a1");
  });

  test("empty pool returns null", () => {
    // T.db is created in beforeEach but has no rows
    const pool = __test.loadPool();
    expect(pool).toBeNull();
  });
});
