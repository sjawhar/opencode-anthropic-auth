import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, seedAccounts } from "./test-harness.mjs";
import {
  listAccounts,
  removeAccount,
  resetAccount,
  getAccountHealth,
  setConfig,
  listConfig,
} from "./db.mjs";

const STALE_5H = 3600000; // 1 hour
const STALE_7D = 43200000; // 12 hours

let db;

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db?.close(false);
  db = null;
});

describe("listAccounts", () => {
  test("returns empty array when no accounts exist", () => {
    const accounts = listAccounts(db);
    expect(accounts).toEqual([]);
  });

  test("returns all accounts with required fields, no tokens", () => {
    seedAccounts(db, [
      {
        id: "acc1",
        label: "Account 1",
        refresh: "refresh_token_1",
        access: "access_token_1",
        type: "oauth",
        status: "active",
        util5h: 0.5,
        util5h_at: Date.now(),
        util7d: 0.3,
        util7d_at: Date.now(),
        overage: 100,
        overage_at: Date.now(),
        consecutive_failures: 0,
        cooldown_until: 0,
      },
    ]);

    const accounts = listAccounts(db);
    expect(accounts).toHaveLength(1);
    const acc = accounts[0];
    expect(acc.id).toBe("acc1");
    expect(acc.label).toBe("Account 1");
    expect(acc.type).toBe("oauth");
    expect(acc.status).toBe("active");
    expect(acc.util5h).toBe(0.5);
    expect(acc.util7d).toBe(0.3);
    expect(acc.overage).toBe(100);
    expect(acc.consecutive_failures).toBe(0);
    expect(acc.cooldown_until).toBe(0);
    expect(acc.refresh).toBeUndefined();
    expect(acc.access).toBeUndefined();
  });

  test("returns accounts with all statuses", () => {
    seedAccounts(db, [
      { id: "active1", label: "Active", refresh: "r1", status: "active" },
      { id: "dead1", label: "Dead", refresh: "r2", status: "dead" },
      { id: "cooldown1", label: "Cooldown", refresh: "r3", status: "cooldown" },
    ]);

    const accounts = listAccounts(db);
    expect(accounts).toHaveLength(3);
    expect(accounts.map((a) => a.status)).toEqual(["active", "dead", "cooldown"]);
  });

  test("includes cooldown_until and expires fields", () => {
    seedAccounts(db, [
      {
        id: "acc1",
        label: "Test",
        refresh: "r1",
        cooldown_until: 1234567890,
        expires: 9876543210,
      },
    ]);

    const accounts = listAccounts(db);
    expect(accounts[0].cooldown_until).toBe(1234567890);
    expect(accounts[0].expires).toBe(9876543210);
  });
});

describe("removeAccount", () => {
  test("returns deleted:false when account does not exist", () => {
    const result = removeAccount(db, "nonexistent");
    expect(result.deleted).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test("hard deletes account and returns deleted:true", () => {
    seedAccounts(db, [
      { id: "acc1", label: "Account 1", refresh: "r1" },
      { id: "acc2", label: "Account 2", refresh: "r2" },
    ]);

    const result = removeAccount(db, "acc1");
    expect(result.deleted).toBe(true);
    expect(result.remaining).toBe(1);

    const remaining = listAccounts(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("acc2");
  });

  test("returns correct remaining count after deletion", () => {
    seedAccounts(db, [
      { id: "acc1", label: "A1", refresh: "r1" },
      { id: "acc2", label: "A2", refresh: "r2" },
      { id: "acc3", label: "A3", refresh: "r3" },
    ]);

    removeAccount(db, "acc1");
    const result = removeAccount(db, "acc2");
    expect(result.remaining).toBe(1);
  });
});

describe("resetAccount", () => {
  test("throws when account does not exist", () => {
    expect(() => resetAccount(db, "nonexistent")).toThrow();
  });

  test("resets status, cooldown_until, consecutive_failures, refresh_lock to defaults", () => {
    seedAccounts(db, [
      {
        id: "acc1",
        label: "Test",
        refresh: "r1",
        status: "dead",
        cooldown_until: 9999999,
        consecutive_failures: 5,
        refresh_lock: 1234567890,
      },
    ]);

    const result = resetAccount(db, "acc1");
    expect(result.status).toBe("active");
    expect(result.cooldown_until).toBe(0);
    expect(result.consecutive_failures).toBe(0);
    expect(result.refresh_lock).toBe(0);
  });

  test("preserves tokens, label, type, utilization", () => {
    seedAccounts(db, [
      {
        id: "acc1",
        label: "Original Label",
        refresh: "original_refresh",
        access: "original_access",
        type: "apikey",
        util5h: 0.75,
        util5h_at: 1000,
        util7d: 0.5,
        util7d_at: 2000,
        status: "dead",
        cooldown_until: 9999999,
      },
    ]);

    const result = resetAccount(db, "acc1");
    expect(result.label).toBe("Original Label");
    expect(result.type).toBe("apikey");
    expect(result.util5h).toBe(0.75);
    expect(result.util7d).toBe(0.5);
    expect(result.refresh).toBeUndefined();
    expect(result.access).toBeUndefined();
  });

  test("returns redacted account (no tokens)", () => {
    seedAccounts(db, [
      {
        id: "acc1",
        label: "Test",
        refresh: "secret_refresh",
        access: "secret_access",
        status: "dead",
      },
    ]);

    const result = resetAccount(db, "acc1");
    expect(result.refresh).toBeUndefined();
    expect(result.access).toBeUndefined();
  });
});

describe("getAccountHealth", () => {
  test("throws when account does not exist", () => {
    expect(() => getAccountHealth(db, "nonexistent")).toThrow();
  });

  test("returns account with health fields", () => {
    const now = Date.now();
    seedAccounts(db, [
      {
        id: "acc1",
        label: "Test",
        refresh: "r1",
        status: "active",
        cooldown_until: 0,
        util5h_at: now - STALE_5H - 1000, // stale (> 1hr)
        util7d_at: now - STALE_7D - 1000, // stale (> 12hr)
        overage_at: now - 1800000 - 1000, // stale (> 30min)
      },
    ]);

    const health = getAccountHealth(db, "acc1");
    expect(health.id).toBe("acc1");
    expect(health.label).toBe("Test");
    expect(health.isStale5h).toBe(true);
    expect(health.isStale7d).toBe(true);
    expect(health.isCoolingDown).toBe(false);
    expect(health.cooldownRemaining).toBe(0);
    expect(health.isDead).toBe(false);
  });

  test("isStale5h is true when util5h_at is older than STALE_5H", () => {
    const now = Date.now();
    seedAccounts(db, [
      {
        id: "acc1",
        label: "Test",
        refresh: "r1",
        util5h_at: now - STALE_5H - 1000, // older than 1hr
      },
    ]);

    const health = getAccountHealth(db, "acc1");
    expect(health.isStale5h).toBe(true);
  });

  test("isStale5h is false when util5h_at is recent", () => {
    const now = Date.now();
    seedAccounts(db, [
      {
        id: "acc1",
        label: "Test",
        refresh: "r1",
        util5h_at: now - 1000, // 1 second ago
      },
    ]);

    const health = getAccountHealth(db, "acc1");
    expect(health.isStale5h).toBe(false);
  });

  test("isStale7d is true when util7d_at is older than STALE_7D", () => {
    const now = Date.now();
    seedAccounts(db, [
      {
        id: "acc1",
        label: "Test",
        refresh: "r1",
        util7d_at: now - STALE_7D - 1000, // older than 12hr
      },
    ]);

    const health = getAccountHealth(db, "acc1");
    expect(health.isStale7d).toBe(true);
  });

  test("isCoolingDown is true when cooldown_until > now", () => {
    const now = Date.now();
    seedAccounts(db, [
      {
        id: "acc1",
        label: "Test",
        refresh: "r1",
        cooldown_until: now + 5000, // 5 seconds in future
      },
    ]);

    const health = getAccountHealth(db, "acc1");
    expect(health.isCoolingDown).toBe(true);
    expect(health.cooldownRemaining).toBeGreaterThan(0);
    expect(health.cooldownRemaining).toBeLessThanOrEqual(5000);
  });

  test("isCoolingDown is false when cooldown_until <= now", () => {
    const now = Date.now();
    seedAccounts(db, [
      {
        id: "acc1",
        label: "Test",
        refresh: "r1",
        cooldown_until: now - 1000, // 1 second in past
      },
    ]);

    const health = getAccountHealth(db, "acc1");
    expect(health.isCoolingDown).toBe(false);
    expect(health.cooldownRemaining).toBe(0);
  });

  test("isDead is true when status === 'dead'", () => {
    seedAccounts(db, [
      {
        id: "acc1",
        label: "Test",
        refresh: "r1",
        status: "dead",
      },
    ]);

    const health = getAccountHealth(db, "acc1");
    expect(health.isDead).toBe(true);
  });

  test("isDead is false when status !== 'dead'", () => {
    seedAccounts(db, [
      {
        id: "acc1",
        label: "Test",
        refresh: "r1",
        status: "active",
      },
    ]);

    const health = getAccountHealth(db, "acc1");
    expect(health.isDead).toBe(false);
  });

  test("does not include tokens in returned object", () => {
    seedAccounts(db, [
      {
        id: "acc1",
        label: "Test",
        refresh: "secret_refresh",
        access: "secret_access",
      },
    ]);

    const health = getAccountHealth(db, "acc1");
    expect(health.refresh).toBeUndefined();
    expect(health.access).toBeUndefined();
  });
});

describe("setConfig", () => {
  test("throws on unknown config key", () => {
    expect(() => setConfig(db, "unknown_key", "value")).toThrow(
      /Unknown config key/
    );
  });

  test("accepts prefer_apikey_over_overage key", () => {
    expect(() => setConfig(db, "prefer_apikey_over_overage", "true")).not.toThrow();
  });

  test("upserts config value", () => {
    setConfig(db, "prefer_apikey_over_overage", "true");
    let config = listConfig(db);
    expect(config).toHaveLength(1);
    expect(config[0]).toEqual({
      key: "prefer_apikey_over_overage",
      value: "true",
    });

    setConfig(db, "prefer_apikey_over_overage", "false");
    config = listConfig(db);
    expect(config).toHaveLength(1);
    expect(config[0].value).toBe("false");
  });
});

describe("listConfig", () => {
  test("returns empty array when no config exists", () => {
    const config = listConfig(db);
    expect(config).toEqual([]);
  });

  test("returns all config rows as { key, value } array", () => {
    setConfig(db, "prefer_apikey_over_overage", "true");
    const config = listConfig(db);
    expect(config).toHaveLength(1);
    expect(config[0].key).toBe("prefer_apikey_over_overage");
    expect(config[0].value).toBe("true");
  });
});
