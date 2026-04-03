import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicAuthPlugin } from "./index.mjs";
const __test = AnthropicAuthPlugin.__test;
import { createTestDb, seedAccounts } from "./test-harness.mjs";
const { persistAccountCredentials } = __test;

test("persistAccountCredentials stores fresh access token and expiry from authorization exchange", () => {
  let captured;
  const db = {
    exec() {},
    prepare(sql) {
      if (sql.includes("config")) return { run() {} };
      assert.match(
        sql,
        /INSERT INTO account \(id, label, refresh, access, expires, status, consecutive_failures, type\).*ON CONFLICT\(id\) DO UPDATE SET/,
      );
      return {
        run(...args) {
          captured = args;
        },
      };
    },
  };

  persistAccountCredentials(db, "personal", {
    account: { uuid: "acct-123" },
    refresh_token: "refresh-123",
    access_token: "access-123",
    expires_in: 3600,
  }, 1_000);

  assert.deepEqual(captured, [
    "acct-123",
    "personal",
    "refresh-123",
    "access-123",
    3_601_000,
    "oauth",
  ]);
});

test("persistAccountCredentials stores API key with type='apikey' and generated UUID", () => {
  let captured;
  const db = {
    exec() {},
    prepare(sql) {
      if (sql.includes("config")) return { run() {} };
      assert.match(
        sql,
        /INSERT INTO account \(id, label, refresh, access, expires, status, consecutive_failures, type\).*ON CONFLICT\(id\) DO UPDATE SET/,
      );
      return {
        run(...args) {
          captured = args;
        },
      };
    },
  };

  persistAccountCredentials(db, "fallback", { apiKey: "sk-ant-test" }, 1_000, "apikey");

  assert.match(captured[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(captured[1], "fallback");
  assert.equal(captured[2], "");
  assert.equal(captured[3], "sk-ant-test");
  assert.equal(captured[4], 0);
  assert.equal(captured[5], "apikey");
});

test("describeRefreshFailure includes API error details in log text", () => {
  assert.equal(
    __test.describeRefreshFailure(429, '{"error":{"type":"rate_limit_error","message":"Rate limited. Please try again later."}}'),
    "HTTP 429 rate_limit_error: Rate limited. Please try again later.",
  );
});

test("pool_initialized flag prevents auto-migration resurrection", () => {
  // persistAccountCredentials sets pool_initialized in config
  let configSet = false;
  const db = {
    exec() {},
    prepare(sql) {
      if (sql.includes("config")) {
        return {
          run(key, value) {
            if (key === "pool_initialized" && value === "true") configSet = true;
          },
        };
      }
      return { run() {} };
    },
  };

  persistAccountCredentials(db, "test", {
    account: { uuid: "acct-999" },
    refresh_token: "r",
    access_token: "a",
    expires_in: 3600,
  });

  assert.ok(configSet, "persistAccountCredentials should set pool_initialized config flag");
});

test("persistAccountCredentials preserves utilization when re-adding existing account", () => {
  const db = createTestDb();
  
  // Seed an account with utilization data
  seedAccounts(db, [{
    id: "acct-existing",
    label: "Existing Account",
    refresh: "old-refresh",
    access: "old-access",
    type: "oauth",
    status: "active",
    util5h: 0.8,
    util5h_at: Date.now() - 1000,
    util7d: 0.5,
    util7d_at: Date.now() - 2000,
    overage: 200,
    overage_at: Date.now() - 3000,
    cooldown_until: 9999999999,
    consecutive_failures: 3,
  }]);
  
  // Re-add same account with new credentials
  persistAccountCredentials(db, "Existing Account", {
    account: { uuid: "acct-existing" },
    refresh_token: "new-refresh",
    access_token: "new-access",
    expires_in: 3600,
  }, Date.now());
  
  // Verify utilization preserved
  const row = db.prepare("SELECT * FROM account WHERE id = ?").get("acct-existing");
  assert.equal(row.util5h, 0.8, "util5h should be preserved");
  assert.equal(row.util7d, 0.5, "util7d should be preserved");
  assert.equal(row.overage, 200, "overage should be preserved");
  assert.equal(row.cooldown_until, 9999999999, "cooldown_until should be preserved");
  // Credentials updated
  assert.equal(row.refresh, "new-refresh");
  assert.equal(row.access, "new-access");
  // Status reset on re-add
  assert.equal(row.status, "active");
  assert.equal(row.consecutive_failures, 0);
  
  db.close(false);
});
