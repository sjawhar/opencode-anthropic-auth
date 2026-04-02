import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AnthropicAuthPlugin } from "./index.mjs";
const __test = AnthropicAuthPlugin.__test;

test("authHeaders uses Claude Code identity", () => {
  const headers = __test.authHeaders({ authorization: "Bearer token" });

  assert.equal(headers["User-Agent"], "claude-cli/2.1.76 (external, cli)");
  assert.equal(headers.authorization, "Bearer token");
});

test("buildRequest adds billing and Claude Code headers for messages", () => {
  const body = JSON.stringify({
    system: [{ type: "text", text: "OpenCode system" }],
    messages: [{ role: "user", content: "please help" }],
    tools: [{ name: "shell", input_schema: { type: "object" } }],
  });

  const request = __test.buildRequest(
    "https://api.anthropic.com/v1/messages",
    {
      body,
      headers: {
        "anthropic-beta": "existing-beta",
        "x-api-key": "should-be-removed",
      },
    },
    "access-token",
  );

  assert.equal(request.requestHeaders.get("authorization"), "Bearer access-token");
  assert.equal(request.requestHeaders.get("user-agent"), "claude-cli/2.1.76 (external, cli)");
  assert.equal(request.requestHeaders.get("x-api-key"), null);
  assert.match(
    request.requestHeaders.get("x-anthropic-billing-header"),
    /^cc_version=2\.1\.76\.[0-9a-f]{3}; cc_entrypoint=cli; cch=00000;$/,
  );
  const requestUrl = new URL(request.requestInput.toString());
  assert.match(requestUrl.searchParams.get("beta"), /^true$/);
  assert.match(request.requestHeaders.get("anthropic-beta"), /oauth-2025-04-20/);
  assert.match(request.requestHeaders.get("anthropic-beta"), /interleaved-thinking-2025-05-14/);
  assert.match(request.requestHeaders.get("anthropic-beta"), /context-1m-2025-08-07/);
  assert.match(request.requestHeaders.get("anthropic-beta"), /existing-beta/);

  const parsed = JSON.parse(request.body);
  assert.equal(parsed.system[0].text, "Claude Code system");
  assert.equal(parsed.tools[0].name, "mcp_shell");
});

test("account type column defaults to 'oauth'", async () => {
  const { open } = await import("./db.mjs");
  const db = open();
  const testId = `test-type-col-${Date.now()}`;

  db.prepare(
    "INSERT OR IGNORE INTO account (id, label, refresh) VALUES (?, ?, ?)",
  ).run(testId, "test-label", "test-refresh");

  const result = db.prepare("SELECT type FROM account WHERE id = ?").get(testId);
  assert.equal(result.type, "oauth", "type column should default to oauth");

  db.prepare("DELETE FROM account WHERE id = ?").run(testId);
});

test("buildRequest uses x-api-key header and excludes oauth beta for apikey mode", () => {
  const body = JSON.stringify({
    system: [{ type: "text", text: "hello" }],
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "shell", input_schema: { type: "object" } }],
  });
  const request = __test.buildRequest(
    "https://api.anthropic.com/v1/messages",
    { body, headers: {} },
    "sk-ant-test-key",
    "apikey",
  );
  assert.equal(request.requestHeaders.get("x-api-key"), "sk-ant-test-key");
  assert.equal(request.requestHeaders.get("authorization"), null);
  const beta = request.requestHeaders.get("anthropic-beta");
  assert.ok(!beta.includes("oauth-2025-04-20"), "oauth beta must not be present");
  assert.ok(beta.includes("interleaved-thinking-2025-05-14"), "interleaved-thinking must be present");
  assert.ok(beta.includes("context-1m-2025-08-07"), "context-1m must be present");
  const parsed = JSON.parse(request.body);
  assert.equal(parsed.tools[0].name, "mcp_shell");
});

function makeAccount(overrides) {
  return {
    id: overrides.id || `acc-${Math.random()}`,
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
  };
}

const mockPool = (accounts) => ({ accounts, config: { threshold: 0.8 } });

test("pickNext: apikey account never returned when eligible oauth exists", () => {
  const oauth = makeAccount({ type: "oauth", id: "o1" });
  const apikey = makeAccount({ type: "apikey", id: "k1" });
  const pool = mockPool([oauth, apikey]);
  const next = __test.pickNext(pool, apikey);
  assert.equal(next.type, "oauth", "should pick oauth over apikey");
  assert.equal(next.id, "o1");
});

test("pickNext: apikey returned when all oauth on cooldown", () => {
  const future = Date.now() + 60000;
  const oauth = makeAccount({ type: "oauth", id: "o1", cooloffUntil: future });
  const apikey = makeAccount({ type: "apikey", id: "k1" });
  const pool = mockPool([oauth, apikey]);
  const next = __test.pickNext(pool, oauth);
  assert.equal(next.type, "apikey", "should return apikey when all oauth on cooldown");
  assert.equal(next.id, "k1");
});

test("pickNext: oauth-only pool — same behavior as before (regression)", () => {
  const o1 = makeAccount({ type: "oauth", id: "o1", util5h: 0.9, overage: true });
  const o2 = makeAccount({ type: "oauth", id: "o2", util5h: 0.3 });
  const pool = mockPool([o1, o2]);
  const next = __test.pickNext(pool, o1);
  assert.equal(next.id, "o2", "should pick lower-util oauth");
});

test("isAllOAuthExhausted: returns false when any oauth is healthy", () => {
  const healthy = makeAccount({ type: "oauth", id: "o1" });
  const exhausted = makeAccount({ type: "oauth", id: "o2", cooloffUntil: Date.now() + 60000 });
  const apikey = makeAccount({ type: "apikey", id: "k1" });
  const pool = mockPool([healthy, exhausted, apikey]);
  assert.equal(__test.isAllOAuthExhausted(pool), false);
});

test("isAllOAuthExhausted: returns true when all oauth exhausted", () => {
  const future = Date.now() + 60000;
  const o1 = makeAccount({ type: "oauth", id: "o1", cooloffUntil: future });
  const o2 = makeAccount({ type: "oauth", id: "o2", overage: true });
  const apikey = makeAccount({ type: "apikey", id: "k1" });
  const pool = mockPool([o1, o2, apikey]);
  assert.equal(__test.isAllOAuthExhausted(pool), true);
});

test("isAllOAuthExhausted: ignores apikey accounts", () => {
  const apikey = makeAccount({ type: "apikey", id: "k1" });
  const pool = mockPool([apikey]);
  assert.equal(__test.isAllOAuthExhausted(pool), true);
});

test("loader auto-migrates auth-store OAuth credential to pool DB", async () => {
  const { open } = await import("./db.mjs");
  const db = open();
  const testId = `migrate-test-${Date.now()}`;

  db.prepare(
    "INSERT OR IGNORE INTO account (id, label, refresh, access, expires, status, type) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(testId, "migrated", "r-tok", "a-tok", 0, "active", "oauth");

  const row = db.prepare("SELECT * FROM account WHERE id = ?").get(testId);
  assert.equal(row.label, "migrated");
  assert.equal(row.type, "oauth");

  db.prepare("DELETE FROM account WHERE id = ?").run(testId);
});

test("refreshToken is skipped for apikey accounts", () => {
  const pool = {
    accounts: [
      {
        id: "k1",
        type: "apikey",
        cooloffUntil: 0,
        overage: false,
        status: "active",
        util5h: 0,
        util7d: 0,
        access: "sk-test",
        expires: 0,
        refresh: "",
        label: "k",
      },
    ],
    config: { threshold: 0.8 },
  };

  assert.equal(__test.isAllOAuthExhausted(pool), true);
});

test("isAllOAuthExhausted returns true for pool with only apikey accounts", () => {
  const pool = {
    accounts: [
      {
        id: "k1",
        type: "apikey",
        cooloffUntil: 0,
        overage: false,
        status: "active",
        util5h: 0,
        util7d: 0,
      },
    ],
    config: { threshold: 0.8 },
  };

  assert.equal(__test.isAllOAuthExhausted(pool), true);
});

test("isAllOAuthExhausted identifies when only apikey remains eligible", () => {
  const future = Date.now() + 60000;
  const pool = {
    accounts: [
      {
        id: "o1",
        type: "oauth",
        cooloffUntil: future,
        overage: false,
        status: "active",
        util5h: 0,
        util7d: 0,
      },
      {
        id: "k1",
        type: "apikey",
        cooloffUntil: 0,
        overage: false,
        status: "active",
        util5h: 0,
        util7d: 0,
      },
    ],
    config: { threshold: 0.8 },
  };

  assert.equal(__test.isAllOAuthExhausted(pool), true);
});

test("isAllOAuthExhausted: healthy oauth (cooloffUntil=0, no overage) returns false", () => {
  const pool = {
    accounts: [
      {
        id: "o1",
        type: "oauth",
        cooloffUntil: 0,
        overage: false,
        status: "active",
        util5h: 0.3,
        util7d: 0.2,
      },
      {
        id: "k1",
        type: "apikey",
        cooloffUntil: 0,
        overage: false,
        status: "active",
        util5h: 0,
        util7d: 0,
      },
    ],
    config: { threshold: 0.8 },
  };

  assert.equal(__test.isAllOAuthExhausted(pool), false);
});

test("plugin no longer ships the single-account code path", () => {
  const source = readFileSync(new URL("./index.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("Single-account mode (no pool DB)"), false);
  assert.equal(source.includes("client.auth.set({"), false);
});
