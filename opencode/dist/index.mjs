// index.mjs
import { createHash as createHash2, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";

// db.mjs
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
var DB_PATH = join(homedir(), ".opencode", "data", "anthropic-pool.db");
var db;
function open() {
  if (db) return db;
  const dir = join(homedir(), ".opencode", "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  db = new Database(DB_PATH);
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
  db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  try {
    db.exec("ALTER TABLE account ADD COLUMN refresh_lock INTEGER NOT NULL DEFAULT 0");
  } catch {
  }
  try {
    db.exec("ALTER TABLE account ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0");
  } catch {
  }
  try {
    db.exec("ALTER TABLE account ADD COLUMN type TEXT NOT NULL DEFAULT 'oauth'");
  } catch {
  }
  return db;
}
var LOCK_TIMEOUT = 3e4;
function tryAcquireRefreshLock(id) {
  const db2 = open();
  const now = Date.now();
  const result = db2.prepare(
    "UPDATE account SET refresh_lock = ? WHERE id = ? AND (refresh_lock = 0 OR refresh_lock < ?)"
  ).run(now, id, now - LOCK_TIMEOUT);
  return result.changes === 1;
}
function releaseRefreshLock(id) {
  const db2 = open();
  db2.prepare("UPDATE account SET refresh_lock = 0 WHERE id = ?").run(id);
}
function config(key, fallback) {
  const db2 = open();
  const row = db2.prepare("SELECT value FROM config WHERE key = ?").get(key);
  if (!row) return fallback;
  if (row.value === "true") return true;
  if (row.value === "false") return false;
  const num = Number(row.value);
  return Number.isNaN(num) ? row.value : num;
}
var STALE_5H = 36e5;
var STALE_7D = 432e5;

// ../shared/oauth.mjs
import { createHash, randomBytes } from "node:crypto";
var CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
var CLAUDE_CODE_VERSION = "2.1.76";
var CLAUDE_CODE_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
var TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
var AUTHORIZE_URL_BASE = {
  console: "https://console.anthropic.com/oauth/authorize",
  max: "https://claude.ai/oauth/authorize"
};
var REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
var SCOPES = "org:create_api_key user:profile user:inference";
function toBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function generatePkce() {
  const verifier = toBase64Url(randomBytes(32));
  const challenge = toBase64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}
function authHeaders(extra = {}) {
  return {
    "User-Agent": CLAUDE_CODE_AGENT,
    ...extra
  };
}
function formBody(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== void 0 && value !== null) {
      body.set(key, String(value));
    }
  }
  return body;
}
async function authorize(mode = "max") {
  const pkce = generatePkce();
  const authorizeUrl = mode === "console" ? AUTHORIZE_URL_BASE.console : AUTHORIZE_URL_BASE.max;
  const url = new URL(authorizeUrl);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", pkce.verifier);
  return { url: url.toString(), verifier: pkce.verifier };
}
async function exchange(code, verifier) {
  const splits = String(code ?? "").split("#");
  const body = formBody({
    code: splits[0],
    state: splits[1],
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier
  });
  const result = await fetch(TOKEN_URL, {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/x-www-form-urlencoded"
    }),
    body
  });
  if (!result.ok) return { type: "failed" };
  const json = await result.json();
  return {
    type: "success",
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1e3
  };
}
async function refreshAccessToken(refreshToken2) {
  const body = formBody({
    grant_type: "refresh_token",
    refresh_token: refreshToken2,
    client_id: CLIENT_ID
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/x-www-form-urlencoded"
    }),
    body
  });
  if (!response.ok) {
    const body2 = await response.text();
    throw new Error(
      `Token refresh failed: ${response.status}${body2 ? ` ${body2}` : ""}`
    );
  }
  const json = await response.json();
  return {
    refresh: json.refresh_token,
    access: json.access_token,
    expires: Date.now() + json.expires_in * 1e3
  };
}

// index.mjs
var BILLING_SALT = "59cf53e54c78";
var BILLING_ENTRY_ENV = "CLAUDE_CODE_ENTRYPOINT";
var LOG_PATH = join2(homedir2(), ".opencode", "data", "anthropic-pool.log");
function poolLog(msg) {
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  try {
    writeFileSync(LOG_PATH, `${ts} ${msg}
`, { flag: "a" });
  } catch {
  }
}
var STALE_OVERAGE = 18e5;
var TRANSIENT_THRESHOLD = 1e4;
var CLOCK_SKEW_BUFFER = 2e3;
var FALLBACK_COOLDOWN = 3e4;
var MAX_RETRY_AFTER = 60;
var MAX_COOLDOWN_FROM_RESET = 3e5;
function loadPool() {
  const db2 = open();
  const rows = db2.prepare("SELECT * FROM account WHERE status = 'active'").all();
  if (!rows.length) return null;
  const now = Date.now();
  return {
    accounts: rows.map((r) => ({
      id: r.id,
      label: r.label,
      refresh: r.refresh,
      access: r.access || "",
      expires: r.expires || 0,
      util5h: now - r.util5h_at < STALE_5H ? r.util5h : 0,
      util7d: now - r.util7d_at < STALE_7D ? r.util7d : 0,
      cooloffUntil: r.cooldown_until || 0,
      overage: now - r.overage_at < STALE_OVERAGE ? !!r.overage : false,
      overageAt: r.overage_at || 0,
      status: r.status || "active",
      type: r.type || "oauth"
    }))
  };
}
function saveUtil(account) {
  const db2 = open();
  const now = Date.now();
  db2.prepare(
    `
    UPDATE account SET
      util5h = ?, util5h_at = ?,
      util7d = ?, util7d_at = ?,
      overage = ?, overage_at = ?
    WHERE id = ?
  `
  ).run(
    account.util5h,
    now,
    account.util7d,
    now,
    account.overage ? 1 : 0,
    now,
    account.id
  );
}
function saveRefresh(account) {
  const db2 = open();
  db2.prepare(
    "UPDATE account SET refresh = ?, access = ?, expires = ? WHERE id = ?"
  ).run(account.refresh, account.access, account.expires, account.id);
}
function markDead(id, reason) {
  const db2 = open();
  db2.prepare("UPDATE account SET status = 'dead' WHERE id = ?").run(id);
  poolLog(`marked "${id}" as dead: ${reason}`);
}
function setCooldown(id, until) {
  const db2 = open();
  db2.prepare("UPDATE account SET cooldown_until = ? WHERE id = ?").run(
    until,
    id
  );
}
function persistAccountCredentials(db2, label, credentials, now = Date.now(), type = "oauth") {
  let id;
  let access;
  let refresh;
  let expires;
  if (type === "apikey") {
    id = randomUUID();
    access = credentials.apiKey;
    refresh = "";
    expires = 0;
  } else {
    id = credentials.account?.uuid;
    if (!id) {
      throw new Error("Authorization succeeded but account UUID is missing.");
    }
    access = credentials.access_token || "";
    refresh = credentials.refresh_token;
    expires = credentials.expires_in ? now + credentials.expires_in * 1e3 : 0;
  }
  db2.prepare(
    "INSERT INTO account (id, label, refresh, access, expires, status, consecutive_failures, type) VALUES (?, ?, ?, ?, ?, 'active', 0, ?) ON CONFLICT(id) DO UPDATE SET refresh=excluded.refresh, access=excluded.access, expires=excluded.expires, status='active', consecutive_failures=0"
  ).run(
    id,
    label.trim() || "unnamed",
    refresh,
    access,
    expires,
    type
  );
  db2.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run("pool_initialized", "true");
  return id;
}
function normalizePersistableOAuthCredentials(credentials, now = Date.now()) {
  if (credentials.account?.uuid) return credentials;
  return {
    account: { uuid: randomUUID() },
    refresh_token: credentials.refresh,
    access_token: credentials.access || "",
    expires_in: credentials.expires ? Math.max(0, Math.ceil((credentials.expires - now) / 1e3)) : 0
  };
}
function createClaudeProMaxCallback(verifier, deps = {}) {
  const exchangeFn = deps.exchange ?? exchange;
  const openDb = deps.open ?? open;
  const persist = deps.persistAccountCredentials ?? persistAccountCredentials;
  return async (code) => {
    const credentials = await exchangeFn(code, verifier);
    if (credentials.type !== "failed") {
      persist(openDb(), "Claude Pro/Max", normalizePersistableOAuthCredentials(credentials));
    }
    return credentials;
  };
}
function createApiKeyCallback(verifier, deps = {}) {
  const exchangeFn = deps.exchange ?? exchange;
  const fetchFn = deps.fetch ?? fetch;
  const openDb = deps.open ?? open;
  const persist = deps.persistAccountCredentials ?? persistAccountCredentials;
  const now = deps.now ?? (() => Date.now());
  return async (code) => {
    const credentials = await exchangeFn(code, verifier);
    if (credentials.type === "failed") return credentials;
    const result = await fetchFn(
      `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`,
      {
        method: "POST",
        headers: authHeaders({
          authorization: `Bearer ${credentials.access}`
        })
      }
    ).then((r) => r.json());
    persist(openDb(), "API Key", { apiKey: result.raw_key }, now(), "apikey");
    return { type: "success", key: result.raw_key };
  };
}
function pickNext(pool, current) {
  const now = Date.now();
  const currentUtil = Math.max(current.util5h, current.util7d);
  const available = pool.accounts.filter(
    (a) => a !== current && now >= a.cooloffUntil
  );
  if (!available.length) {
    const allStates = pool.accounts.map((a) => `"${a.label}"(cd=${a.cooloffUntil > now ? Math.round((a.cooloffUntil - now) / 1e3) + "s" : "none"})`).join(", ");
    poolLog(`pickNext: no available accounts besides "${current.label}", keeping current. States: ${allStates}`);
    return current;
  }
  const preferApikeyOverOverage = config("prefer_apikey_over_overage", false);
  const oauthAvailable = available.filter((a) => (a.type || "oauth") !== "apikey");
  const healthyOAuth = preferApikeyOverOverage ? oauthAvailable.filter((a) => !a.overage) : oauthAvailable;
  const apikeyAvailable = available.filter((a) => (a.type || "oauth") === "apikey");
  const candidates = healthyOAuth.length > 0 ? healthyOAuth : apikeyAvailable.length > 0 ? apikeyAvailable : oauthAvailable;
  if (!candidates.length) return current;
  const notInOverage = candidates.filter((a) => !a.overage);
  if (notInOverage.length) {
    notInOverage.sort(
      (a, b) => Math.max(a.util5h, a.util7d) - Math.max(b.util5h, b.util7d)
    );
    poolLog(`pickNext: found non-overage "${notInOverage[0].label}" (5h=${notInOverage[0].util5h.toFixed(2)} 7d=${notInOverage[0].util7d.toFixed(2)})`);
    return notInOverage[0];
  }
  if (current.overage && (current.type || "oauth") !== "apikey") {
    poolLog(`pickNext: all in overage, staying on current "${current.label}"`);
    return current;
  }
  candidates.sort(
    (a, b) => Math.max(a.util5h, a.util7d) - Math.max(b.util5h, b.util7d)
  );
  poolLog(`pickNext: all in overage, picked lowest-util "${candidates[0].label}" (5h=${candidates[0].util5h.toFixed(2)} 7d=${candidates[0].util7d.toFixed(2)})`);
  return candidates[0];
}
function isAllOAuthExhausted(pool) {
  const now = Date.now();
  const oauthAccounts = pool.accounts.filter((a) => (a.type || "oauth") !== "apikey");
  if (!oauthAccounts.length) return true;
  return oauthAccounts.every(
    (a) => a.cooloffUntil > now || a.overage === true || a.status === "dead"
  );
}
var LOCK_WAIT_MS = 2e3;
var LOCK_MAX_RETRIES = 3;
var DEAD_AFTER_FAILURES = 3;
async function refreshToken(account) {
  const db2 = open();
  const cached = db2.prepare("SELECT refresh, access, expires FROM account WHERE id = ?").get(account.id);
  if (cached && cached.access && cached.expires > Date.now() + 5e3) {
    account.refresh = cached.refresh;
    account.access = cached.access;
    account.expires = cached.expires;
    poolLog(`refreshToken "${account.label}": already valid (expires ${new Date(cached.expires).toISOString()})`);
    return true;
  }
  if (cached && cached.refresh !== account.refresh) {
    poolLog(`re-read fresher token for "${account.label}" from db`);
    account.refresh = cached.refresh;
  }
  let lockAcquired = false;
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    if (tryAcquireRefreshLock(account.id)) {
      lockAcquired = true;
      break;
    }
    poolLog(
      `refresh lock held for "${account.label}", waiting (attempt ${attempt + 1}/${LOCK_MAX_RETRIES})`
    );
    await new Promise((r) => setTimeout(r, LOCK_WAIT_MS));
    const updated = db2.prepare("SELECT refresh, access, expires FROM account WHERE id = ?").get(account.id);
    if (updated && updated.access && updated.expires > Date.now() + 5e3) {
      account.refresh = updated.refresh;
      account.access = updated.access;
      account.expires = updated.expires;
      poolLog(`got refreshed token from another process for "${account.label}"`);
      return true;
    }
  }
  if (!lockAcquired) {
    poolLog(
      `could not acquire refresh lock for "${account.label}" after ${LOCK_MAX_RETRIES} attempts`
    );
    return false;
  }
  try {
    const fresh = db2.prepare("SELECT refresh FROM account WHERE id = ?").get(account.id);
    if (fresh && fresh.refresh !== account.refresh) {
      account.refresh = fresh.refresh;
    }
    try {
      const tokens = await refreshAccessToken(account.refresh);
      account.refresh = tokens.refresh;
      account.access = tokens.access;
      account.expires = tokens.expires;
      saveRefresh(account);
      db2.prepare(
        "UPDATE account SET consecutive_failures = 0 WHERE id = ?"
      ).run(account.id);
      poolLog(`refreshToken "${account.label}": success, expires ${new Date(tokens.expires).toISOString()}`);
      releaseRefreshLock(account.id);
      return true;
    } catch (error) {
      poolLog(`refresh failed (${error.message}) for "${account.label}"`);
      db2.prepare(
        "UPDATE account SET consecutive_failures = consecutive_failures + 1 WHERE id = ?"
      ).run(account.id);
      const row = db2.prepare("SELECT consecutive_failures FROM account WHERE id = ?").get(account.id);
      const failures = row?.consecutive_failures ?? 0;
      if (failures >= DEAD_AFTER_FAILURES) {
        markDead(account.id, `${failures} consecutive refresh failures`);
      } else {
        poolLog(
          `refresh failure ${failures}/${DEAD_AFTER_FAILURES} for "${account.label}" (not marking dead yet)`
        );
      }
      releaseRefreshLock(account.id);
      return false;
    }
  } catch (e) {
    releaseRefreshLock(account.id);
    throw e;
  }
}
function parseUtil(response, account) {
  const h5 = response.headers.get("anthropic-ratelimit-unified-5h-utilization");
  const h7 = response.headers.get("anthropic-ratelimit-unified-7d-utilization");
  const overage = response.headers.get(
    "anthropic-ratelimit-unified-overage-in-use"
  );
  const prev5h = account.util5h, prev7d = account.util7d, prevOvg = account.overage;
  if (h5 != null) account.util5h = parseFloat(h5);
  if (h7 != null) account.util7d = parseFloat(h7);
  if (overage != null) account.overage = overage === "true";
  if (h5 != null || h7 != null || overage != null) {
    poolLog(`util "${account.label}": 5h=${prev5h.toFixed(2)}->${account.util5h.toFixed(2)} 7d=${prev7d.toFixed(2)}->${account.util7d.toFixed(2)} overage=${prevOvg}->${account.overage}`);
  }
}
function parseCooldown(response, now = Date.now()) {
  const rlHeaders = {};
  for (const [key, val2] of response.headers.entries()) {
    if (key.startsWith("anthropic-ratelimit") || key === "retry-after" || key === "retry-after-ms") {
      rlHeaders[key] = val2;
    }
  }
  poolLog(`parseCooldown headers: ${JSON.stringify(rlHeaders)}`);
  const ms = parseInt(response.headers.get("retry-after-ms"));
  if (ms > 0) {
    const until = now + ms;
    poolLog(`parseCooldown: using retry-after-ms=${ms} -> cooldown until ${new Date(until).toISOString()} (${Math.round(ms / 1e3)}s)`);
    return until;
  }
  const val = parseFloat(response.headers.get("retry-after"));
  if (val > 0) {
    const until = now + val * 1e3;
    poolLog(`parseCooldown: using retry-after=${val}s -> cooldown until ${new Date(until).toISOString()} (${val}s)`);
    return until;
  }
  const reset = [
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-reset",
    "anthropic-ratelimit-input-tokens-reset",
    "anthropic-ratelimit-output-tokens-reset"
  ].flatMap((header) => {
    const val2 = response.headers.get(header);
    if (val2 == null) return [];
    const ts = new Date(val2).getTime();
    if (Number.isNaN(ts)) {
      poolLog(`parseCooldown: ${header}="${val2}" -> NaN (skipped)`);
      return [];
    }
    if (ts <= now) {
      poolLog(`parseCooldown: ${header}="${val2}" -> in past, using clock_skew_buffer`);
      return [now + CLOCK_SKEW_BUFFER];
    }
    poolLog(`parseCooldown: ${header}="${val2}" -> ${new Date(ts).toISOString()} (${Math.round((ts - now) / 1e3)}s from now)`);
    return [ts];
  });
  if (reset.length) {
    const until = Math.min(Math.min(...reset), now + MAX_COOLDOWN_FROM_RESET);
    poolLog(`parseCooldown: using earliest reset header (capped at ${MAX_COOLDOWN_FROM_RESET}ms) -> cooldown until ${new Date(until).toISOString()} (${Math.round((until - now) / 1e3)}s)`);
    return until;
  }
  poolLog(`parseCooldown: no headers found, using fallback cooldown ${FALLBACK_COOLDOWN}ms`);
  return now + FALLBACK_COOLDOWN;
}
function firstUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";
    for (const block of message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type !== "text") continue;
      if (typeof block.text === "string") return block.text;
    }
    return "";
  }
  return "";
}
function buildBillingHeader(body) {
  const json = JSON.parse(body);
  const sample = [4, 7, 20].map((idx) => firstUserText(json.messages).charAt(idx) || "0").join("");
  const hash = createHash2("sha256").update(`${BILLING_SALT}${sample}${CLAUDE_CODE_VERSION}`).digest("hex").slice(0, 3);
  const entrypoint = process.env[BILLING_ENTRY_ENV]?.trim() || "cli";
  return `cc_version=${CLAUDE_CODE_VERSION}.${hash}; cc_entrypoint=${entrypoint}; cch=00000;`;
}
function describeRefreshFailure(status, bodyText) {
  if (!bodyText) return `HTTP ${status}`;
  try {
    const parsed = JSON.parse(bodyText);
    const error = parsed?.error;
    if (error?.type && error?.message) {
      return `HTTP ${status} ${error.type}: ${error.message}`;
    }
  } catch {
  }
  const compact = bodyText.replace(/\s+/g, " ").trim();
  if (!compact) return `HTTP ${status}`;
  const preview = compact.length > 200 ? `${compact.slice(0, 197)}...` : compact;
  return `HTTP ${status} ${preview}`;
}
var TOOL_PREFIX = "mcp_";
function buildRequest(input, init, access, authMode = "oauth") {
  const requestInit = init ?? {};
  const requestHeaders = new Headers();
  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      requestHeaders.set(key, value);
    });
  }
  if (requestInit.headers) {
    if (requestInit.headers instanceof Headers) {
      requestInit.headers.forEach((value, key) => {
        requestHeaders.set(key, value);
      });
    } else if (Array.isArray(requestInit.headers)) {
      for (const [key, value] of requestInit.headers) {
        if (typeof value !== "undefined") {
          requestHeaders.set(key, String(value));
        }
      }
    } else {
      for (const [key, value] of Object.entries(requestInit.headers)) {
        if (typeof value !== "undefined") {
          requestHeaders.set(key, String(value));
        }
      }
    }
  }
  const incomingBeta = requestHeaders.get("anthropic-beta") || "";
  const incomingBetasList = incomingBeta.split(",").map((b) => b.trim()).filter(Boolean);
  const requiredBetas = authMode === "apikey" ? ["interleaved-thinking-2025-05-14", "context-1m-2025-08-07"] : ["oauth-2025-04-20", "interleaved-thinking-2025-05-14", "context-1m-2025-08-07"];
  const mergedBetas = [
    .../* @__PURE__ */ new Set([...requiredBetas, ...incomingBetasList])
  ].join(",");
  if (authMode === "apikey") {
    requestHeaders.set("x-api-key", access);
    requestHeaders.delete("authorization");
  } else {
    requestHeaders.set("authorization", `Bearer ${access}`);
    requestHeaders.delete("x-api-key");
  }
  requestHeaders.set("anthropic-beta", mergedBetas);
  requestHeaders.set("user-agent", CLAUDE_CODE_AGENT);
  let body = requestInit.body;
  if (body && typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      if (parsed.system && Array.isArray(parsed.system)) {
        parsed.system = parsed.system.map((item) => {
          if (item.type === "text" && item.text) {
            return {
              ...item,
              text: item.text.replace(/OpenCode/g, "Claude Code").replace(/(?<!\/)opencode/gi, "Claude")
            };
          }
          return item;
        });
      }
      if (parsed.tools && Array.isArray(parsed.tools)) {
        parsed.tools = parsed.tools.map((tool) => ({
          ...tool,
          name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name
        }));
      }
      if (parsed.messages && Array.isArray(parsed.messages)) {
        parsed.messages = parsed.messages.map((msg) => {
          if (msg.content && Array.isArray(msg.content)) {
            msg.content = msg.content.map((block) => {
              if (block.type === "tool_use" && block.name) {
                return { ...block, name: `${TOOL_PREFIX}${block.name}` };
              }
              return block;
            });
          }
          return msg;
        });
      }
      body = JSON.stringify(parsed);
    } catch (e) {
    }
  }
  let requestInput = input;
  let requestUrl = null;
  try {
    if (typeof input === "string" || input instanceof URL) {
      requestUrl = new URL(input.toString());
    } else if (input instanceof Request) {
      requestUrl = new URL(input.url);
    }
  } catch {
    requestUrl = null;
  }
  if (requestUrl && requestUrl.pathname === "/v1/messages" && typeof body === "string") {
    requestHeaders.set("x-anthropic-billing-header", buildBillingHeader(body));
  }
  if (requestUrl && requestUrl.pathname === "/v1/messages" && !requestUrl.searchParams.has("beta")) {
    requestUrl.searchParams.set("beta", "true");
    requestInput = input instanceof Request ? new Request(requestUrl.toString(), input) : requestUrl;
  }
  return { requestInput, body, requestHeaders };
}
function wrapStream(response) {
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        let text = decoder.decode(value, { stream: true });
        text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
        controller.enqueue(encoder.encode(text));
      }
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }
  return response;
}
async function runManagementMenu(db2, mgmt, promptFn) {
  let running = true;
  while (running) {
    const accounts = mgmt.listAccountsWithHealth(db2);
    console.log("\n=== Anthropic Account Management ===\n");
    if (accounts.length === 0) {
      console.log("  No accounts configured.\n");
    } else {
      accounts.forEach((a, i) => {
        console.log(`  [${i + 1}] ${a.label} (${a.type}) ${a.statusBadge}`);
      });
      console.log();
    }
    console.log("  [1] List accounts");
    console.log("  [2] Remove account");
    console.log("  [3] Reset account");
    console.log("  [4] Pool config");
    console.log("  [5] Exit");
    console.log();
    const choice = await promptFn("Choose action [1-5]: ");
    switch (choice) {
      case "1": {
        const list = mgmt.listAccountsWithHealth(db2);
        if (list.length === 0) {
          console.log("\n  No accounts.\n");
        } else {
          console.log();
          list.forEach((a, i) => {
            console.log(`  [${i + 1}] ${a.label} (${a.type}) ${a.statusBadge}`);
            console.log(`      5h util: ${typeof a.util5h === "number" ? a.util5h.toFixed(2) : a.util5h} (${a.util5hRelative})`);
            console.log(`      7d util: ${typeof a.util7d === "number" ? a.util7d.toFixed(2) : a.util7d} (${a.util7dRelative})`);
          });
          console.log();
        }
        break;
      }
      case "2": {
        const list = mgmt.listAccountsWithHealth(db2);
        if (list.length === 0) {
          console.log("\n  No accounts to remove.\n");
          break;
        }
        const num = await promptFn(`Account number to remove [1-${list.length}]: `);
        const idx = parseInt(num, 10) - 1;
        if (idx < 0 || idx >= list.length) {
          console.log("  Invalid selection.");
          break;
        }
        const target = list[idx];
        const confirm = await promptFn(`Remove "${target.label}"? [y/N]: `);
        if (confirm.toLowerCase() === "y") {
          mgmt.removeAccount(target.id, db2);
          console.log(`  Removed "${target.label}".`);
        } else {
          console.log("  Cancelled.");
        }
        break;
      }
      case "3": {
        const list = mgmt.listAccountsWithHealth(db2);
        if (list.length === 0) {
          console.log("\n  No accounts to reset.\n");
          break;
        }
        const num = await promptFn(`Account number to reset [1-${list.length}]: `);
        const idx = parseInt(num, 10) - 1;
        if (idx < 0 || idx >= list.length) {
          console.log("  Invalid selection.");
          break;
        }
        const target = list[idx];
        const result = mgmt.resetAccount(target.id, db2);
        console.log(`  Reset "${target.label}". Status: ${result.account.status ?? "active"}`);
        break;
      }
      case "4": {
        const cfg = mgmt.getConfig(db2);
        console.log("\n  Pool Configuration:");
        if (cfg.entries.length === 0) {
          console.log("  No configuration entries.\n");
        } else {
          cfg.entries.forEach(({ key, value, description }) => {
            console.log(`    ${key} = ${value} \u2014 ${description}`);
          });
          console.log();
        }
        const toggle = await promptFn("Toggle a config key (or press Enter to skip): ");
        if (toggle) {
          const current = cfg.values[toggle];
          if (current === void 0) {
            console.log(`  Unknown key: ${toggle}`);
          } else {
            const newValue = typeof current === "boolean" ? !current : current;
            try {
              mgmt.setConfig(toggle, String(newValue), db2);
              console.log(`  Set ${toggle} = ${newValue}`);
            } catch (err) {
              console.log(`  Error: ${err.message}`);
            }
          }
        }
        break;
      }
      case "5":
      default:
        running = false;
        break;
    }
  }
}
async function AnthropicAuthPlugin({ client: _client }) {
  return {
    "experimental.chat.system.transform": (input, output) => {
      const prefix = "You are Claude Code, Anthropic's official CLI for Claude.";
      if (input.model?.providerID === "anthropic") {
        output.system.unshift(prefix);
        if (output.system[1])
          output.system[1] = prefix + "\n\n" + output.system[1];
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        poolLog("loader called");
        const auth = await getAuth();
        let pool = loadPool();
        const poolInitialized = config("pool_initialized", false);
        if ((!pool || !pool.accounts.length) && !poolInitialized && auth && auth.type === "oauth" && auth.refresh) {
          open().prepare(
            "INSERT OR IGNORE INTO account (id, label, refresh, access, expires, status, type) VALUES (?, ?, ?, ?, ?, 'active', 'oauth')"
          ).run(randomUUID(), "migrated", auth.refresh, auth.access || "", auth.expires || 0);
          poolLog("auto-migrated auth-store OAuth credential to pool DB");
          pool = loadPool();
        }
        if (pool) {
          for (const model of Object.values(provider.models)) {
            model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
          }
          const dummy = { util5h: Infinity, util7d: Infinity, overage: true, cooloffUntil: Infinity, type: "apikey" };
          let current = pickNext(pool, dummy);
          if (current === dummy) current = pool.accounts[0];
          poolLog(
            `pool mode: ${pool.accounts.length} accounts, starting with "${current.label}" (5h=${current.util5h.toFixed(2)} 7d=${current.util7d.toFixed(2)} overage=${current.overage})`
          );
          return {
            apiKey: "opencode-oauth-dummy-key",
            async fetch(input, init) {
              poolLog(`fetch start: using "${current.label}" (${current.type})`);
              if (current.type !== "apikey" && (!current.access || current.expires < Date.now())) {
                const ok = await refreshToken(current);
                if (!ok) {
                  const prev = current;
                  const until = Date.now() + FALLBACK_COOLDOWN;
                  setCooldown(current.id, until);
                  current.cooloffUntil = until;
                  current = pickNext(pool, current);
                  poolLog(
                    `refresh failed, switching from "${prev.label}" to "${current.label}"`
                  );
                  if (current.type !== "apikey" && (!current.access || current.expires < Date.now())) {
                    const ok2 = await refreshToken(current);
                    if (!ok2) throw new Error("All accounts failed to refresh");
                  }
                }
              }
              const req = buildRequest(input, init, current.access, current.type);
              const response = await fetch(req.requestInput, {
                ...init ?? {},
                body: req.body,
                headers: req.requestHeaders
              });
              poolLog(`fetch "${current.label}" (${current.type}): ${response.status} ${response.statusText}`);
              parseUtil(response, current);
              saveUtil(current);
              if (response.status === 401 || response.status === 403) {
                if (current.type === "apikey") {
                  const db2 = open();
                  db2.prepare(
                    "UPDATE account SET consecutive_failures = consecutive_failures + 1 WHERE id = ?"
                  ).run(current.id);
                  const row = db2.prepare("SELECT consecutive_failures FROM account WHERE id = ?").get(current.id);
                  const failures = row?.consecutive_failures ?? 0;
                  if (failures >= DEAD_AFTER_FAILURES) {
                    markDead(current.id, `${failures} consecutive 401/403 failures`);
                    current.status = "dead";
                  }
                  const until2 = Date.now() + FALLBACK_COOLDOWN;
                  setCooldown(current.id, until2);
                  current.cooloffUntil = until2;
                  current = pickNext(pool, current);
                  return wrapStream(response);
                }
                const ok = await refreshToken(current);
                if (ok) {
                  const retry = buildRequest(input, init, current.access, current.type);
                  const r2 = await fetch(retry.requestInput, {
                    ...init ?? {},
                    body: retry.body,
                    headers: retry.requestHeaders
                  });
                  parseUtil(r2, current);
                  saveUtil(current);
                  return wrapStream(r2);
                }
                const until = parseCooldown(response);
                setCooldown(current.id, until);
                current.cooloffUntil = until;
                const tried401 = /* @__PURE__ */ new Set([current.id]);
                let last401 = response;
                while (tried401.size < pool.accounts.length) {
                  const prev = current;
                  current = pickNext(pool, current);
                  if (current === prev || tried401.has(current.id)) break;
                  tried401.add(current.id);
                  poolLog(
                    `401/403 trying "${current.label}" after "${prev.label}" failed`
                  );
                  if (current.type !== "apikey" && (!current.access || current.expires < Date.now())) {
                    const ok2 = await refreshToken(current);
                    if (!ok2) continue;
                  }
                  const retry = buildRequest(input, init, current.access, current.type);
                  const r2 = await fetch(retry.requestInput, {
                    ...init ?? {},
                    body: retry.body,
                    headers: retry.requestHeaders
                  });
                  parseUtil(r2, current);
                  saveUtil(current);
                  if (r2.status !== 401 && r2.status !== 403) return wrapStream(r2);
                  last401 = r2;
                  const retryUntil = parseCooldown(r2);
                  setCooldown(current.id, retryUntil);
                  current.cooloffUntil = retryUntil;
                }
                return wrapStream(last401);
              }
              if (response.status === 429) {
                const retryAfterMs = parseFloat(response.headers.get("retry-after") || "0") * 1e3;
                const transient = retryAfterMs > 0 && retryAfterMs <= TRANSIENT_THRESHOLD;
                poolLog(`429 on "${current.label}": retry-after=${response.headers.get("retry-after")}, retry-after-ms=${response.headers.get("retry-after-ms")}, transient=${transient}`);
                let latestResp;
                if (transient) {
                  await new Promise((r) => setTimeout(r, retryAfterMs));
                  const sameRetry = buildRequest(input, init, current.access, current.type);
                  const sameResp = await fetch(sameRetry.requestInput, {
                    ...init ?? {},
                    body: sameRetry.body,
                    headers: sameRetry.requestHeaders
                  });
                  if (sameResp.status !== 429) {
                    parseUtil(sameResp, current);
                    saveUtil(current);
                    return wrapStream(sameResp);
                  }
                  latestResp = sameResp;
                } else {
                  latestResp = response;
                }
                const until = parseCooldown(latestResp);
                setCooldown(current.id, until);
                current.cooloffUntil = until;
                const tried = /* @__PURE__ */ new Set([current.id]);
                let last429 = latestResp;
                while (tried.size < pool.accounts.length) {
                  const prev = current;
                  current = pickNext(pool, current);
                  if (current === prev || tried.has(current.id)) break;
                  tried.add(current.id);
                  poolLog(
                    `429 trying "${current.label}" after "${prev.label}" rate limited`
                  );
                  if (current.type !== "apikey" && (!current.access || current.expires < Date.now())) {
                    const ok = await refreshToken(current);
                    if (!ok) continue;
                  }
                  const retry = buildRequest(input, init, current.access, current.type);
                  const r2 = await fetch(retry.requestInput, {
                    ...init ?? {},
                    body: retry.body,
                    headers: retry.requestHeaders
                  });
                  parseUtil(r2, current);
                  saveUtil(current);
                  if (r2.status !== 429) return wrapStream(r2);
                  const retryUntil = parseCooldown(r2);
                  setCooldown(current.id, retryUntil);
                  current.cooloffUntil = retryUntil;
                  last429 = r2;
                }
                const now = Date.now();
                if (isAllOAuthExhausted(pool)) {
                  const apikeyAccount = pool.accounts.find(
                    (a) => (a.type || "oauth") === "apikey" && now >= a.cooloffUntil && a.status !== "dead"
                  );
                  if (apikeyAccount) {
                    const prevForFallback = current;
                    current = apikeyAccount;
                    poolLog(`all OAuth exhausted, falling back to apikey "${current.label}"`);
                    const fallbackReq = buildRequest(input, init, current.access, current.type);
                    const fallbackResp = await fetch(fallbackReq.requestInput, {
                      ...init ?? {},
                      body: fallbackReq.body,
                      headers: fallbackReq.requestHeaders
                    });
                    parseUtil(fallbackResp, current);
                    saveUtil(current);
                    if (fallbackResp.status !== 429) return wrapStream(fallbackResp);
                    current = prevForFallback;
                    last429 = fallbackResp;
                  }
                }
                const times = pool.accounts.map((a) => a.cooloffUntil).filter((t) => t > now);
                const earliest = times.length ? Math.min(...times) : now + FALLBACK_COOLDOWN;
                const secs = Math.max(
                  1,
                  Math.min(Math.ceil((earliest - now) / 1e3), MAX_RETRY_AFTER)
                );
                poolLog(`429 all accounts exhausted, returning retry-after=${secs}s to client (earliest cooldown: ${new Date(earliest).toISOString()})`);
                const hdrs = new Headers(last429.headers);
                hdrs.set("retry-after", String(secs));
                return new Response(last429.body, {
                  status: 429,
                  statusText: last429.statusText,
                  headers: hdrs
                });
              }
              if (current.overage) {
                const candidate = pickNext(pool, current);
                if (candidate !== current && !candidate.overage) {
                  poolLog(
                    `proactive switch from "${current.label}" to "${candidate.label}" (5h=${current.util5h.toFixed(2)} 7d=${current.util7d.toFixed(2)} overage=${current.overage})`
                  );
                  current = candidate;
                }
              }
              if (current.type === "apikey") {
                const now = Date.now();
                const recoveredRows = open().prepare(
                  "SELECT id, cooldown_until, overage, overage_at, status FROM account WHERE type != 'apikey'"
                ).all();
                const recoveredIds = new Set(
                  recoveredRows.filter(
                    (row) => row.status !== "dead" && row.cooldown_until <= now && !row.overage
                  ).map((row) => row.id)
                );
                const recoveredOAuth = pool.accounts.find((a) => recoveredIds.has(a.id));
                if (recoveredOAuth) {
                  const recoveredRow = recoveredRows.find((row) => row.id === recoveredOAuth.id);
                  if (recoveredRow) {
                    recoveredOAuth.cooloffUntil = recoveredRow.cooldown_until || 0;
                    recoveredOAuth.overage = !!recoveredRow.overage;
                    recoveredOAuth.overageAt = recoveredRow.overage_at || 0;
                    recoveredOAuth.status = recoveredRow.status || "active";
                  }
                  poolLog(`OAuth recovered, switching from apikey "${current.label}" to "${recoveredOAuth.label}"`);
                  current = recoveredOAuth;
                }
              }
              return wrapStream(response);
            }
          };
        }
        return {};
      },
      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("max");
            return {
              url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: createClaudeProMaxCallback(verifier)
            };
          }
        },
        {
          label: "Create an API Key",
          type: "oauth",
          authorize: async () => {
            const { url, verifier } = await authorize("console");
            return {
              url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: createApiKeyCallback(verifier)
            };
          }
        },
        {
          provider: "anthropic",
          label: "Manually enter API Key",
          type: "api"
        }
      ]
    }
  };
}
AnthropicAuthPlugin.__test = {
  authHeaders,
  buildBillingHeader,
  buildRequest,
  describeRefreshFailure,
  pickNext,
  isAllOAuthExhausted,
  persistAccountCredentials,
  createClaudeProMaxCallback,
  createApiKeyCallback,
  loadPool,
  parseUtil,
  parseCooldown,
  STALE_5H,
  STALE_7D,
  STALE_OVERAGE,
  TRANSIENT_THRESHOLD,
  FALLBACK_COOLDOWN,
  MAX_RETRY_AFTER,
  MAX_COOLDOWN_FROM_RESET,
  DEAD_AFTER_FAILURES,
  runManagementMenu
};
var index_default = AnthropicAuthPlugin;
export {
  AnthropicAuthPlugin,
  index_default as default
};
