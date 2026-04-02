import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  __test,
  formatAccountStatus,
  formatRelativeTime,
  getConfig,
  listAccountsWithHealth,
  redactAccount,
  removeAccount,
  resetAccount,
  setConfig,
} from "./management.mjs";
import { createTestDb, getAccountState, seedAccounts } from "./test-harness.mjs";

const ORIGINAL_DATE_NOW = Date.now;

describe("management helpers", () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    Date.now = () => NOW;
  });

  afterEach(() => {
    Date.now = ORIGINAL_DATE_NOW;
  });

  test("formatRelativeTime returns never for nullish timestamps", () => {
    expect(formatRelativeTime(null)).toBe("never");
    expect(formatRelativeTime(0)).toBe("never");
  });

  test("formatRelativeTime returns just now for recent timestamps", () => {
    expect(formatRelativeTime(NOW - 30_000)).toBe("just now");
  });

  test("formatRelativeTime returns minutes ago", () => {
    expect(formatRelativeTime(NOW - 5 * 60_000)).toBe("5m ago");
  });

  test("formatRelativeTime returns hours ago", () => {
    expect(formatRelativeTime(NOW - 2 * 60 * 60_000)).toBe("2h ago");
  });

  test("formatRelativeTime returns yesterday within forty eight hours", () => {
    expect(formatRelativeTime(NOW - 30 * 60 * 60_000)).toBe("yesterday");
  });

  test("formatRelativeTime returns days ago for older timestamps", () => {
    expect(formatRelativeTime(NOW - 3 * 24 * 60 * 60_000)).toBe("3d ago");
  });

  test("redactAccount masks apikey access and removes secrets without mutating input", () => {
    const account = {
      id: "acc_1",
      type: "apikey",
      refresh: "refresh-secret",
      access: "sk-ant-api03-abcdefghijklmnopQRST",
    };

    const result = redactAccount(account);

    expect(result).toEqual({
      id: "acc_1",
      type: "apikey",
      maskedAccess: "sk-ant-...QRST",
    });
    expect(account.refresh).toBe("refresh-secret");
    expect(account.access).toBe("sk-ant-api03-abcdefghijklmnopQRST");
  });

  test("redactAccount removes oauth secrets entirely", () => {
    expect(
      redactAccount({ id: "acc_2", type: "oauth", refresh: "r", access: "a", label: "OAuth" }),
    ).toEqual({ id: "acc_2", type: "oauth", label: "OAuth" });
  });

  test("formatAccountStatus prefers dead state", () => {
    expect(formatAccountStatus({ status: "dead", cooldown_until: 0, consecutive_failures: 9 })).toBe("[dead]");
  });

  test("formatAccountStatus returns active state", () => {
    expect(formatAccountStatus({ status: "active", cooldown_until: 0, consecutive_failures: 0 })).toBe("[active]");
  });

  test("formatAccountStatus returns cooling down with formatted duration", () => {
    expect(formatAccountStatus({ status: "active", cooldown_until: NOW + 150_000, consecutive_failures: 2 })).toBe(
      "[cooling down: 2m 30s]",
    );
  });

  test("formatAccountStatus returns auth-failing for failing active accounts", () => {
    expect(formatAccountStatus({ status: "active", cooldown_until: 0, consecutive_failures: 1 })).toBe(
      "[auth-failing]",
    );
  });

  test("__test exposes internal helpers", () => {
    expect(__test).toHaveProperty("formatDuration");
    expect(__test).toHaveProperty("parseConfigValue");
    expect(__test.formatDuration(61_000)).toBe("1m 1s");
  });
});

describe("management module", () => {
  const NOW = 1_700_000_000_000;
  let db;

  beforeEach(() => {
    db = createTestDb();
    Date.now = () => NOW;
  });

  afterEach(() => {
    Date.now = ORIGINAL_DATE_NOW;
  });

  test("listAccountsWithHealth decorates redacted accounts using db state", () => {
    seedAccounts(db, [
      {
        id: "fresh-oauth",
        label: "Fresh OAuth",
        refresh: "refresh-1",
        access: "access-1",
        util5h: 0.4,
        util5h_at: NOW - 20 * 60_000,
        util7d: 0.7,
        util7d_at: NOW - 2 * 60 * 60_000,
        overage: 1,
        overage_at: NOW - 90_000,
        status: "active",
        type: "oauth",
      },
      {
        id: "cooling-key",
        label: "Cooling Key",
        refresh: "unused-refresh",
        access: "sk-ant-api03-abcdefghijklmnopQRST",
        util5h: 0.9,
        util5h_at: NOW - 2 * 60 * 60_000,
        util7d: 0.2,
        util7d_at: NOW - 13 * 60 * 60_000,
        overage: 0,
        overage_at: 0,
        cooldown_until: NOW + 150_000,
        consecutive_failures: 2,
        type: "apikey",
      },
    ]);

    expect(listAccountsWithHealth(db)).toEqual([
      {
        id: "fresh-oauth",
        label: "Fresh OAuth",
        type: "oauth",
        status: "active",
        cooldown_until: 0,
        expires: 0,
        util5h: 0.4,
        util5h_at: NOW - 20 * 60_000,
        util7d: 0.7,
        util7d_at: NOW - 2 * 60 * 60_000,
        overage: 1,
        overage_at: NOW - 90_000,
        consecutive_failures: 0,
        isStale5h: false,
        isStale7d: false,
        isCoolingDown: false,
        cooldownRemaining: 0,
        isDead: false,
        statusBadge: "[active]",
        util5hRelative: "20m ago",
        util7dRelative: "2h ago",
        overageRelative: "1m ago",
      },
      {
        id: "cooling-key",
        label: "Cooling Key",
        type: "apikey",
        status: "active",
        cooldown_until: NOW + 150_000,
        expires: 0,
        util5h: 0,
        util5h_at: NOW - 2 * 60 * 60_000,
        util7d: 0,
        util7d_at: NOW - 13 * 60 * 60_000,
        overage: 0,
        overage_at: 0,
        consecutive_failures: 2,
        isStale5h: true,
        isStale7d: true,
        isCoolingDown: true,
        cooldownRemaining: 150_000,
        isDead: false,
        statusBadge: "[cooling down: 2m 30s]",
        util5hRelative: "2h ago",
        util7dRelative: "13h ago",
        overageRelative: "never",
      },
    ]);
  });

  test("listAccountsWithHealth makes exactly 1 DB query (no N+1)", () => {
    seedAccounts(db, [
      { id: "a1", label: "A1", refresh: "r1", status: "active" },
      { id: "a2", label: "A2", refresh: "r2", status: "active" },
      { id: "a3", label: "A3", refresh: "r3", status: "active" },
    ]);

    let queryCount = 0;
    const origPrepare = db.prepare.bind(db);
    db.prepare = (...args) => {
      queryCount++;
      return origPrepare(...args);
    };

    const result = listAccountsWithHealth(db);
    expect(result).toHaveLength(3);

    // Before fix: 4 (1 listAccounts + 3 getAccountHealth)
    // After fix: 1 (just listAccounts)
    expect(queryCount).toBe(1);
  });

  test("removeAccount returns deletion result and remaining count", () => {
    seedAccounts(db, [
      { id: "acc_1", label: "One", refresh: "r1" },
      { id: "acc_2", label: "Two", refresh: "r2" },
    ]);

    expect(removeAccount("acc_1", db)).toEqual({ deleted: true, remaining: 1 });
    expect(getAccountState(db, "acc_1")).toBeNull();
  });

  test("resetAccount clears lock and failure state", () => {
    seedAccounts(db, [
      {
        id: "acc_reset",
        label: "Reset Me",
        refresh: "r1",
        status: "dead",
        cooldown_until: NOW + 60_000,
        consecutive_failures: 4,
        refresh_lock: NOW,
        type: "apikey",
        access: "sk-ant-api03-abcdefghijklmnopQRST",
      },
    ]);

    expect(resetAccount("acc_reset", db)).toEqual({
      reset: true,
      account: {
        id: "acc_reset",
        label: "Reset Me",
        type: "apikey",
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
        refresh_lock: 0,
      },
    });
    expect(getAccountState(db, "acc_reset")).toMatchObject({
      status: "active",
      cooldown_until: 0,
      consecutive_failures: 0,
      refresh_lock: 0,
    });
  });

  test("getConfig returns typed values with descriptions", () => {
    setConfig("prefer_apikey_over_overage", "true", db);

    expect(getConfig(db)).toEqual({
      values: {
        prefer_apikey_over_overage: true,
      },
      entries: [
        {
          key: "prefer_apikey_over_overage",
          value: true,
          description: "Prefer API key accounts over OAuth accounts currently using overage.",
        },
      ],
    });
  });

  test("setConfig delegates persistence to db layer", () => {
    setConfig("prefer_apikey_over_overage", "false", db);

    expect(getConfig(db).values.prefer_apikey_over_overage).toBe(false);
  });

  test("getConfig returns synthesized defaults when config table has no user-facing entries", () => {
    // Fresh install — no config rows at all
    const result = getConfig(db);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries[0].key).toBe("prefer_apikey_over_overage");
    expect(result.entries[0].value).toBe(false);
    expect(result.entries[0].description).toBe(
      __test.CONFIG_DESCRIPTIONS.prefer_apikey_over_overage,
    );
    expect(result.values.prefer_apikey_over_overage).toBe(false);
  });

  test("getConfig does not expose pool_initialized internal key", () => {
    // Insert internal key directly (bypassing setConfig which rejects it)
    db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run("pool_initialized", "true");

    const result = getConfig(db);
    const keys = result.entries.map((e) => e.key);
    expect(keys).not.toContain("pool_initialized");
    expect(result.values.pool_initialized).toBeUndefined();
  });

  test("getConfig returns stored user-facing config entries when present", () => {
    db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run("prefer_apikey_over_overage", "true");

    const result = getConfig(db);
    const entry = result.entries.find((e) => e.key === "prefer_apikey_over_overage");
    expect(entry).toBeDefined();
    expect(entry.value).toBe(true);
  });
});

describe("pool_initialized flag", () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db?.close(false);
    db = null;
  });

  test("removeAccount sets pool_initialized flag", () => {
    seedAccounts(db, [{ id: "acc1", label: "A", refresh: "r1", status: "active" }]);
    removeAccount("acc1", db);
    const row = db.prepare("SELECT value FROM config WHERE key = ?").get("pool_initialized");
    expect(row?.value).toBe("true");
  });

  test("resetAccount sets pool_initialized flag", () => {
    seedAccounts(db, [{ id: "acc1", label: "A", refresh: "r1", status: "dead" }]);
    resetAccount("acc1", db);
    const row = db.prepare("SELECT value FROM config WHERE key = ?").get("pool_initialized");
    expect(row?.value).toBe("true");
  });
});
