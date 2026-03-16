import assert from "node:assert/strict";
import test from "node:test";

import { __test } from "./index.mjs";

test("authHeaders uses Claude Code identity", () => {
  const headers = __test.authHeaders({ authorization: "Bearer token" });

  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["User-Agent"], "claude-code/2.1.76");
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
  assert.equal(request.requestHeaders.get("user-agent"), "claude-code/2.1.76");
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
