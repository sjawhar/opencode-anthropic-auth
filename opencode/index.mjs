import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { open, tryAcquireRefreshLock, releaseRefreshLock } from "./db.mjs";
import {
  CLAUDE_CODE_AGENT,
  CLAUDE_CODE_VERSION,
  authHeaders,
  authorize,
  exchange,
  refreshAccessToken,
} from "../shared/oauth.mjs";

const BILLING_SALT = "59cf53e54c78";
const BILLING_ENTRY_ENV = "CLAUDE_CODE_ENTRYPOINT";

// --- Logging ---

const LOG_PATH = join(homedir(), ".opencode", "data", "anthropic-pool.log");
function poolLog(msg) {
  const ts = new Date().toISOString();
  try {
    writeFileSync(LOG_PATH, `${ts} ${msg}\n`, { flag: "a" });
  } catch {}
}

// --- SQLite pool helpers ---

// Staleness TTLs (ms)
const STALE_5H = 3600000; // 1 hour
const STALE_7D = 43200000; // 12 hours
const STALE_OVERAGE = 1800000; // 30 min
const TRANSIENT_THRESHOLD = 10000;
const CLOCK_SKEW_BUFFER = 2000;
const FALLBACK_COOLDOWN = 30000;
const MAX_RETRY_AFTER = 60;
const THRESHOLD = 0.8;

function loadPool() {
  const db = open();
  const rows = db
    .prepare("SELECT * FROM account WHERE status = 'active'")
    .all();
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
    })),
    config: { threshold: THRESHOLD },
  };
}

function saveUtil(account) {
  const db = open();
  const now = Date.now();
  db.prepare(
    `
    UPDATE account SET
      util5h = ?, util5h_at = ?,
      util7d = ?, util7d_at = ?,
      overage = ?, overage_at = ?
    WHERE id = ?
  `,
  ).run(
    account.util5h,
    now,
    account.util7d,
    now,
    account.overage ? 1 : 0,
    now,
    account.id,
  );
}

function saveRefresh(account) {
  const db = open();
  db.prepare(
    "UPDATE account SET refresh = ?, access = ?, expires = ? WHERE id = ?",
  ).run(account.refresh, account.access, account.expires, account.id);
}

function markDead(id, reason) {
  const db = open();
  db.prepare("UPDATE account SET status = 'dead' WHERE id = ?").run(id);
  poolLog(`marked "${id}" as dead: ${reason}`);
}

function setCooldown(id, until) {
  const db = open();
  db.prepare("UPDATE account SET cooldown_until = ? WHERE id = ?").run(
    until,
    id,
  );
}

// --- Account selection ---

function pickNext(pool, current) {
  const now = Date.now();
  const threshold = pool.config.threshold;
  const currentUtil = Math.max(current.util5h, current.util7d);
  const available = pool.accounts.filter(
    (a) => a !== current && now >= a.cooloffUntil,
  );
  if (!available.length) return current;
  // Prefer healthy accounts (under threshold, no overage)
  const healthy = available.filter(
    (a) => Math.max(a.util5h, a.util7d) < threshold && !a.overage,
  );
  if (healthy.length) return healthy[0];
  // Prefer accounts with lower utilization than current
  const better = available.filter(
    (a) => Math.max(a.util5h, a.util7d) < currentUtil,
  );
  if (better.length) {
    better.sort(
      (a, b) => Math.max(a.util5h, a.util7d) - Math.max(b.util5h, b.util7d),
    );
    return better[0];
  }
  // All accounts are equally bad — pick the one with lowest util anyway
  available.sort(
    (a, b) => Math.max(a.util5h, a.util7d) - Math.max(b.util5h, b.util7d),
  );
  return available[0];
}

// --- Token refresh (serialized via SQLite lock to prevent rotation races) ---

const LOCK_WAIT_MS = 2000;
const LOCK_MAX_RETRIES = 3;
const DEAD_AFTER_FAILURES = 3;

async function refreshToken(account) {
  const db = open();

  // Step 1: Check if token is already valid (another process may have refreshed)
  const cached = db
    .prepare("SELECT refresh, access, expires FROM account WHERE id = ?")
    .get(account.id);
  if (cached && cached.access && cached.expires > Date.now() + 5000) {
    account.refresh = cached.refresh;
    account.access = cached.access;
    account.expires = cached.expires;
    return true;
  }
  // Sync refresh token from DB (another process may have rotated it)
  if (cached && cached.refresh !== account.refresh) {
    poolLog(`re-read fresher token for "${account.label}" from db`);
    account.refresh = cached.refresh;
  }

  // Step 2: Acquire exclusive refresh lock (SQLite write-serialized CAS)
  let lockAcquired = false;
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    if (tryAcquireRefreshLock(account.id)) {
      lockAcquired = true;
      break;
    }
    // Another process is refreshing — wait for it to finish
    poolLog(
      `refresh lock held for "${account.label}", waiting (attempt ${attempt + 1}/${LOCK_MAX_RETRIES})`,
    );
    await new Promise((r) => setTimeout(r, LOCK_WAIT_MS));

    // Check if the other process succeeded while we waited
    const updated = db
      .prepare("SELECT refresh, access, expires FROM account WHERE id = ?")
      .get(account.id);
    if (updated && updated.access && updated.expires > Date.now() + 5000) {
      account.refresh = updated.refresh;
      account.access = updated.access;
      account.expires = updated.expires;
      poolLog(`got refreshed token from another process for "${account.label}"`);
      return true;
    }
  }

  if (!lockAcquired) {
    poolLog(
      `could not acquire refresh lock for "${account.label}" after ${LOCK_MAX_RETRIES} attempts`,
    );
    return false;
  }

  // Step 3: We hold the lock — re-read token and do the actual refresh
  try {
    const fresh = db
      .prepare("SELECT refresh FROM account WHERE id = ?")
      .get(account.id);
    if (fresh && fresh.refresh !== account.refresh) {
      account.refresh = fresh.refresh;
    }

    try {
      const tokens = await refreshAccessToken(account.refresh);
      account.refresh = tokens.refresh;
      account.access = tokens.access;
      account.expires = tokens.expires;
      saveRefresh(account);
      // Reset failure counter on success
      db.prepare(
        "UPDATE account SET consecutive_failures = 0 WHERE id = ?",
      ).run(account.id);
      releaseRefreshLock(account.id);
      return true;
    } catch (error) {
      poolLog(`refresh failed (${error.message}) for "${account.label}"`);
      db.prepare(
        "UPDATE account SET consecutive_failures = consecutive_failures + 1 WHERE id = ?",
      ).run(account.id);
      const row = db
        .prepare("SELECT consecutive_failures FROM account WHERE id = ?")
        .get(account.id);
      const failures = row?.consecutive_failures ?? 0;

      if (failures >= DEAD_AFTER_FAILURES) {
        markDead(account.id, `${failures} consecutive refresh failures`);
      } else {
        poolLog(
          `refresh failure ${failures}/${DEAD_AFTER_FAILURES} for "${account.label}" (not marking dead yet)`,
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

// --- Utilization header parsing ---

function parseUtil(response, account) {
  const h5 = response.headers.get("anthropic-ratelimit-unified-5h-utilization");
  const h7 = response.headers.get("anthropic-ratelimit-unified-7d-utilization");
  const overage = response.headers.get(
    "anthropic-ratelimit-unified-overage-in-use",
  );
  if (h5 != null) account.util5h = parseFloat(h5);
  if (h7 != null) account.util7d = parseFloat(h7);
  if (overage != null) account.overage = overage === "true";
}

function parseCooldown(response, now = Date.now()) {
  const ms = parseInt(response.headers.get("retry-after-ms"));
  if (ms > 0) return now + ms;

  const val = parseFloat(response.headers.get("retry-after"));
  if (val > 0) return now + val * 1000;

  const reset = [
    "anthropic-ratelimit-requests-reset",
    "anthropic-ratelimit-tokens-reset",
    "anthropic-ratelimit-input-tokens-reset",
    "anthropic-ratelimit-output-tokens-reset",
  ].flatMap((header) => {
    const val = response.headers.get(header);
    if (val == null) return [];
    const ts = new Date(val).getTime();
    if (Number.isNaN(ts)) return [];
    if (ts <= now) return [now + CLOCK_SKEW_BUFFER];
    return [ts];
  });
  if (reset.length) return Math.min(...reset);

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
  const sample = [4, 7, 20]
    .map((idx) => firstUserText(json.messages).charAt(idx) || "0")
    .join("");
  const hash = createHash("sha256")
    .update(`${BILLING_SALT}${sample}${CLAUDE_CODE_VERSION}`)
    .digest("hex")
    .slice(0, 3);
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
  } catch {}

  const compact = bodyText.replace(/\s+/g, " ").trim();
  if (!compact) return `HTTP ${status}`;
  const preview = compact.length > 200 ? `${compact.slice(0, 197)}...` : compact;
  return `HTTP ${status} ${preview}`;
}

// --- Request/response transforms ---

const TOOL_PREFIX = "mcp_";

function buildRequest(input, init, access) {
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
  const incomingBetasList = incomingBeta
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
  const requiredBetas = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14", "context-1m-2025-08-07"];
  const mergedBetas = [
    ...new Set([...requiredBetas, ...incomingBetasList]),
  ].join(",");

  requestHeaders.set("authorization", `Bearer ${access}`);
  requestHeaders.set("anthropic-beta", mergedBetas);
  requestHeaders.set("user-agent", CLAUDE_CODE_AGENT);
  requestHeaders.delete("x-api-key");

  let body = requestInit.body;
  if (body && typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      if (parsed.system && Array.isArray(parsed.system)) {
        parsed.system = parsed.system.map((item) => {
          if (item.type === "text" && item.text) {
            return {
              ...item,
              text: item.text
                .replace(/OpenCode/g, "Claude Code")
                .replace(/(?<!\/)opencode/gi, "Claude"),
            };
          }
          return item;
        });
      }
      if (parsed.tools && Array.isArray(parsed.tools)) {
        parsed.tools = parsed.tools.map((tool) => ({
          ...tool,
          name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
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
    } catch (e) {}
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

  if (
    requestUrl &&
    requestUrl.pathname === "/v1/messages" &&
    typeof body === "string"
  ) {
    requestHeaders.set("x-anthropic-billing-header", buildBillingHeader(body));
  }

  if (
    requestUrl &&
    requestUrl.pathname === "/v1/messages" &&
    !requestUrl.searchParams.has("beta")
  ) {
    requestUrl.searchParams.set("beta", "true");
    requestInput =
      input instanceof Request
        ? new Request(requestUrl.toString(), input)
        : requestUrl;
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
      },
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  return response;
}

// --- Plugin export ---

export async function AnthropicAuthPlugin({ client }) {
  return {
    "experimental.chat.system.transform": (input, output) => {
      const prefix =
        "You are Claude Code, Anthropic's official CLI for Claude.";
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
        const pool = loadPool();

        if ((auth && auth.type === "oauth") || pool) {
          for (const model of Object.values(provider.models)) {
            model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
          }

          // Pool mode
          if (pool) {
            // Start with healthiest account, not arbitrary DB order
            pool.accounts.sort((a, b) => {
              if (a.overage !== b.overage) return a.overage ? 1 : -1;
              return (
                Math.max(a.util5h, a.util7d) - Math.max(b.util5h, b.util7d)
              );
            });
            let current = pool.accounts[0];
            poolLog(
              `pool mode: ${pool.accounts.length} accounts, starting with "${current.label}" (5h=${current.util5h.toFixed(2)} 7d=${current.util7d.toFixed(2)} overage=${current.overage})`,
            );

            return {
              apiKey: "",
              async fetch(input, init) {
                // Ensure valid token
                if (!current.access || current.expires < Date.now()) {
                  const ok = await refreshToken(current);
                  if (!ok) {
                    const prev = current;
                    setCooldown(current.id, Date.now() + FALLBACK_COOLDOWN);
                    current.cooloffUntil = Date.now() + FALLBACK_COOLDOWN;
                    current = pickNext(pool, current);
                    poolLog(
                      `refresh failed, switching from "${prev.label}" to "${current.label}"`,
                    );
                    const ok2 = await refreshToken(current);
                    if (!ok2) throw new Error("All accounts failed to refresh");
                  }
                }

                const req = buildRequest(input, init, current.access);
                const response = await fetch(req.requestInput, {
                  ...(init ?? {}),
                  body: req.body,
                  headers: req.requestHeaders,
                });

                parseUtil(response, current);
                saveUtil(current);

                // 401/403: refresh + retry
                if (response.status === 401 || response.status === 403) {
                  const ok = await refreshToken(current);
                  if (ok) {
                    const retry = buildRequest(input, init, current.access);
                    const r2 = await fetch(retry.requestInput, {
                      ...(init ?? {}),
                      body: retry.body,
                      headers: retry.requestHeaders,
                    });
                    parseUtil(r2, current);
                    saveUtil(current);
                    return wrapStream(r2);
                  }
                  // Refresh failed — try every other account before giving up
                  const until = parseCooldown(response);
                  setCooldown(current.id, until);
                  current.cooloffUntil = until;
                  const tried401 = new Set([current.id]);
                  let last401 = response;
                  while (tried401.size < pool.accounts.length) {
                    const prev = current;
                    current = pickNext(pool, current);
                    if (current === prev || tried401.has(current.id)) break;
                    tried401.add(current.id);
                    poolLog(
                      `401/403 trying "${current.label}" after "${prev.label}" failed`,
                    );
                    const ok2 = await refreshToken(current);
                    if (!ok2) continue;
                    const retry = buildRequest(input, init, current.access);
                    const r2 = await fetch(retry.requestInput, {
                      ...(init ?? {}),
                      body: retry.body,
                      headers: retry.requestHeaders,
                    });
                    parseUtil(r2, current);
                    saveUtil(current);
                    if (r2.status !== 401 && r2.status !== 403)
                      return wrapStream(r2);
                    last401 = r2;
                    const until = parseCooldown(r2);
                    setCooldown(current.id, until);
                    current.cooloffUntil = until;
                  }
                  return wrapStream(last401);
                }

                // 429: transient retry on same account first, then sustained rotation
                if (response.status === 429) {
                  const retryAfterMs =
                    parseFloat(response.headers.get("retry-after") || "0") *
                    1000;
                  const transient =
                    retryAfterMs > 0 && retryAfterMs <= TRANSIENT_THRESHOLD;
                  let latestResp;
                  if (transient) {
                    await new Promise((r) => setTimeout(r, retryAfterMs));
                    const sameRetry = buildRequest(input, init, current.access);
                    const sameResp = await fetch(sameRetry.requestInput, {
                      ...(init ?? {}),
                      body: sameRetry.body,
                      headers: sameRetry.requestHeaders,
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
                  const tried = new Set([current.id]);
                  let last429 = latestResp;
                  while (tried.size < pool.accounts.length) {
                    const prev = current;
                    current = pickNext(pool, current);
                    if (current === prev || tried.has(current.id)) break;
                    tried.add(current.id);
                    poolLog(
                      `429 trying "${current.label}" after "${prev.label}" rate limited`,
                    );
                    if (!current.access || current.expires < Date.now()) {
                      const ok = await refreshToken(current);
                      if (!ok) continue;
                    }
                    const retry = buildRequest(input, init, current.access);
                    const r2 = await fetch(retry.requestInput, {
                      ...(init ?? {}),
                      body: retry.body,
                      headers: retry.requestHeaders,
                    });
                    parseUtil(r2, current);
                    saveUtil(current);
                    if (r2.status !== 429) return wrapStream(r2);
                    const u = parseCooldown(r2);
                    setCooldown(current.id, u);
                    current.cooloffUntil = u;
                    last429 = r2;
                  }

                  const now = Date.now();
                  const times = pool.accounts
                    .map((a) => a.cooloffUntil)
                    .filter((t) => t > now);
                  const earliest = times.length
                    ? Math.min(...times)
                    : now + FALLBACK_COOLDOWN;
                  const secs = Math.max(
                    1,
                    Math.min(
                      Math.ceil((earliest - now) / 1000),
                      MAX_RETRY_AFTER,
                    ),
                  );
                  const hdrs = new Headers(last429.headers);
                  hdrs.set("retry-after", String(secs));
                  return new Response(last429.body, {
                    status: 429,
                    statusText: last429.statusText,
                    headers: hdrs,
                  });
                }

                // Proactive switch: only if there's a strictly healthier account
                // (not in overage, under threshold, and not in cooldown)
                // Don't switch away from a working account to one that might be worse
                if (
                  current.overage ||
                  Math.max(current.util5h, current.util7d) >
                    pool.config.threshold
                ) {
                  const candidate = pickNext(pool, current);
                  if (
                    candidate !== current &&
                    !candidate.overage &&
                    Math.max(candidate.util5h, candidate.util7d) <
                      pool.config.threshold
                  ) {
                    poolLog(
                      `proactive switch from "${current.label}" to "${candidate.label}" (5h=${current.util5h.toFixed(2)} 7d=${current.util7d.toFixed(2)} overage=${current.overage})`,
                    );
                    current = candidate;
                  }
                }

                return wrapStream(response);
              },
            };
          }

          // Single-account mode (no pool DB)
          return {
            apiKey: "",
            async fetch(input, init) {
              const auth = await getAuth();
              if (auth.type !== "oauth") return fetch(input, init);
              if (!auth.access || auth.expires < Date.now()) {
                const json = await refreshAccessToken(auth.refresh);
                await client.auth.set({
                  path: { id: "anthropic" },
                  body: {
                    type: "oauth",
                    refresh: json.refresh,
                    access: json.access,
                    expires: json.expires,
                  },
                });
                auth.access = json.access;
              }
              const req = buildRequest(input, init, auth.access);
              const response = await fetch(req.requestInput, {
                ...(init ?? {}),
                body: req.body,
                headers: req.requestHeaders,
              });
              if (response.status === 401 || response.status === 403) {
                const cur = await getAuth();
                if (cur.type !== "oauth") return wrapStream(response);
                let json;
                try {
                  json = await refreshAccessToken(cur.refresh);
                } catch {
                  return wrapStream(response);
                }
                await client.auth.set({
                  path: { id: "anthropic" },
                  body: {
                    type: "oauth",
                    refresh: json.refresh,
                    access: json.access,
                    expires: json.expires,
                  },
                });
                const retry = buildRequest(input, init, json.access);
                const r2 = await fetch(retry.requestInput, {
                  ...(init ?? {}),
                  body: retry.body,
                  headers: retry.requestHeaders,
                });
                return wrapStream(r2);
              }
              return wrapStream(response);
            },
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
              callback: async (code) => exchange(code, verifier),
            };
          },
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
              callback: async (code) => {
                const credentials = await exchange(code, verifier);
                if (credentials.type === "failed") return credentials;
                const result = await fetch(
                  `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`,
                  {
                    method: "POST",
                    headers: authHeaders({
                      authorization: `Bearer ${credentials.access}`,
                    }),
                  },
                ).then((r) => r.json());
                return { type: "success", key: result.raw_key };
              },
            };
          },
        },
        {
          provider: "anthropic",
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  };
}

export const __test = { authHeaders, buildBillingHeader, buildRequest, describeRefreshFailure };
