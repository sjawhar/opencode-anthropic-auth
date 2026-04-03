import { Database } from "bun:sqlite";

import { AnthropicAuthPlugin } from "./index.mjs";

export function createTestDb() {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS account (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      refresh TEXT NOT NULL,
      access TEXT NOT NULL DEFAULT '',
      expires INTEGER NOT NULL DEFAULT 0,
      util5h REAL NOT NULL DEFAULT 0,
      util5h_at INTEGER NOT NULL DEFAULT 0,
      util7d REAL NOT NULL DEFAULT 0,
      util7d_at INTEGER NOT NULL DEFAULT 0,
      overage INTEGER NOT NULL DEFAULT 0,
      overage_at INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      cooldown_until INTEGER NOT NULL DEFAULT 0
    )
  `);
  try { db.exec("ALTER TABLE account ADD COLUMN refresh_lock INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE account ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE account ADD COLUMN type TEXT NOT NULL DEFAULT 'oauth'"); } catch {}
  db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}

export function seedAccounts(db, accounts) {
  const defaults = {
    access: "",
    expires: 0,
    util5h: 0,
    util5h_at: 0,
    util7d: 0,
    util7d_at: 0,
    overage: 0,
    overage_at: 0,
    status: "active",
    cooldown_until: 0,
    refresh_lock: 0,
    consecutive_failures: 0,
    type: "oauth",
  };

  const insert = db.prepare(`
    INSERT INTO account (
      id, label, refresh, access, expires, util5h, util5h_at, util7d, util7d_at,
      overage, overage_at, status, cooldown_until, refresh_lock, consecutive_failures, type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const run = db.transaction((rows) => {
    for (const account of rows) {
      const row = { ...defaults, ...account };
      insert.run(
        row.id,
        row.label,
        row.refresh,
        row.access,
        row.expires,
        row.util5h,
        row.util5h_at,
        row.util7d,
        row.util7d_at,
        row.overage,
        row.overage_at,
        row.status,
        row.cooldown_until,
        row.refresh_lock,
        row.consecutive_failures,
        row.type,
      );
    }
  });

  run(accounts);
}

export function getAccountState(db, id) {
  return db.prepare("SELECT * FROM account WHERE id = ?").get(id);
}

export function apiResponse(status, { headers = {}, body = "" } = {}) {
  return new Response(body, { status, headers: new Headers(headers) });
}

export function rate429({ retryAfter, retryAfterMs, resets = {}, utilization = {} } = {}) {
  const headers = {};
  if (retryAfter !== undefined) headers["retry-after"] = String(retryAfter);
  if (retryAfterMs !== undefined) headers["retry-after-ms"] = String(retryAfterMs);
  for (const [key, value] of Object.entries(resets)) {
    headers[`anthropic-ratelimit-${key}-reset`] = String(value);
  }
  if (utilization["5h"] !== undefined) {
    headers["anthropic-ratelimit-unified-5h-utilization"] = String(utilization["5h"]);
  }
  if (utilization["7d"] !== undefined) {
    headers["anthropic-ratelimit-unified-7d-utilization"] = String(utilization["7d"]);
  }
  return apiResponse(429, { headers });
}

export function authResponse(status = 200, { utilization = {}, overage = null } = {}) {
  const headers = {};
  if (utilization["5h"] !== undefined) {
    headers["anthropic-ratelimit-unified-5h-utilization"] = String(utilization["5h"]);
  }
  if (utilization["7d"] !== undefined) {
    headers["anthropic-ratelimit-unified-7d-utilization"] = String(utilization["7d"]);
  }
  if (overage !== null) {
    headers["anthropic-ratelimit-unified-overage-in-use"] = String(overage);
  }
  return apiResponse(status, { headers });
}

export function makeRequestBody(overrides = {}) {
  return JSON.stringify({
    model: "claude-3-5-sonnet-20241022",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 100,
    ...overrides,
  });
}

export async function getInterceptor(T, accounts, fetchResponder) {
  seedAccounts(T.db, accounts);

  globalThis.fetch = async (url, req = {}) => {
    const headers = Object.fromEntries(req.headers?.entries?.() ?? []);
    const body = typeof req.body === "string" ? req.body : req.body == null ? "" : String(req.body);
    const call = { url, headers, body };
    T.fetchCalls.push(call);
    return fetchResponder(T.fetchCalls.length - 1, url, headers, body);
  };

  const plugin = await AnthropicAuthPlugin({ client: {} });
  const getAuth = async () => null;
  const provider = { models: {} };
  const loader = await plugin.auth.loader(getAuth, provider);
  return loader.fetch;
}
