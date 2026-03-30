import assert from "node:assert/strict";
import test from "node:test";

import { __test } from "./index.mjs";
import { persistAccountCredentials } from "./add-account-lib.mjs";

test("persistAccountCredentials stores fresh access token and expiry from authorization exchange", () => {
  let captured;
  const db = {
    prepare(sql) {
      assert.match(
        sql,
        /INSERT OR REPLACE INTO account \(id, label, refresh, access, expires, status, consecutive_failures, type\)/,
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
    prepare(sql) {
      assert.match(
        sql,
        /INSERT OR REPLACE INTO account \(id, label, refresh, access, expires, status, consecutive_failures, type\)/,
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
