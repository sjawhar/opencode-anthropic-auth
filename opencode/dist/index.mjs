var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// db.mjs
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
function listAccounts(dbInstance) {
  const db2 = dbInstance || open();
  const rows = db2.prepare(`
    SELECT
      id, label, type, status, cooldown_until, expires,
      util5h, util5h_at, util7d, util7d_at,
      overage, overage_at, consecutive_failures
    FROM account
  `).all();
  return rows;
}
function removeAccount(dbInstance, id) {
  const db2 = dbInstance || open();
  const result = db2.prepare("DELETE FROM account WHERE id = ?").run(id);
  const remaining = db2.prepare("SELECT COUNT(*) as count FROM account").get();
  return {
    deleted: result.changes === 1,
    remaining: remaining.count
  };
}
function resetAccount(dbInstance, id) {
  const db2 = dbInstance || open();
  const existing = db2.prepare("SELECT id FROM account WHERE id = ?").get(id);
  if (!existing) throw new Error(`Account not found: ${id}`);
  db2.prepare(`
    UPDATE account
    SET status = 'active', cooldown_until = 0, consecutive_failures = 0, refresh_lock = 0
    WHERE id = ?
  `).run(id);
  const updated = db2.prepare(`
    SELECT
      id, label, type, status, cooldown_until, expires,
      util5h, util5h_at, util7d, util7d_at,
      overage, overage_at, consecutive_failures, refresh_lock
    FROM account WHERE id = ?
  `).get(id);
  return updated;
}
function setConfig(dbInstance, key, value) {
  const allowlist = ["prefer_apikey_over_overage"];
  if (!allowlist.includes(key)) {
    throw new Error(`Unknown config key: ${key}`);
  }
  const db2 = dbInstance || open();
  db2.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, value);
}
function listConfig(dbInstance) {
  const db2 = dbInstance || open();
  return db2.prepare("SELECT key, value FROM config").all();
}
var DB_PATH, db, LOCK_TIMEOUT, STALE_5H, STALE_7D;
var init_db = __esm({
  "db.mjs"() {
    DB_PATH = join(homedir(), ".opencode", "data", "anthropic-pool.db");
    LOCK_TIMEOUT = 3e4;
    STALE_5H = 36e5;
    STALE_7D = 432e5;
  }
});

// cli-ui.mjs
function parseKey(data) {
  const s = data.toString();
  if (s === "\x1B[A" || s === "\x1BOA") return "up";
  if (s === "\x1B[B" || s === "\x1BOB") return "down";
  if (s === "\r" || s === "\n") return "enter";
  if (s === "") return "escape";
  if (s === "\x1B") return "escape-start";
  return null;
}
function isTTY() {
  return Boolean(process.stdin.isTTY);
}
function stripAnsi(input) {
  return input.replace(ANSI_REGEX, "");
}
function truncateAnsi(input, maxVisibleChars) {
  if (maxVisibleChars <= 0) return "";
  const visible = stripAnsi(input);
  if (visible.length <= maxVisibleChars) return input;
  const suffix = maxVisibleChars >= 3 ? "..." : ".".repeat(maxVisibleChars);
  const keep = Math.max(0, maxVisibleChars - suffix.length);
  let out = "";
  let i = 0;
  let kept = 0;
  while (i < input.length && kept < keep) {
    if (input[i] === "\x1B") {
      const m = input.slice(i).match(ANSI_LEADING_REGEX);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += input[i];
    i += 1;
    kept += 1;
  }
  if (out.includes("\x1B[")) {
    return `${out}${ANSI.reset}${suffix}`;
  }
  return out + suffix;
}
function getColorCode(color) {
  switch (color) {
    case "red":
      return ANSI.red;
    case "green":
      return ANSI.green;
    case "yellow":
      return ANSI.yellow;
    case "cyan":
      return ANSI.cyan;
    default:
      return "";
  }
}
async function select(items, options) {
  if (!isTTY()) {
    throw new Error("Interactive select requires a TTY terminal");
  }
  if (items.length === 0) {
    throw new Error("No menu items provided");
  }
  const isSelectable = (i) => !i.disabled && !i.separator && i.kind !== "heading";
  const enabledItems = items.filter(isSelectable);
  if (enabledItems.length === 0) {
    throw new Error("All items disabled");
  }
  if (enabledItems.length === 1) {
    return enabledItems[0].value;
  }
  const { message, subtitle } = options;
  const { stdin, stdout } = process;
  let cursor = items.findIndex(isSelectable);
  if (cursor === -1) cursor = 0;
  let escapeTimeout = null;
  let isCleanedUp = false;
  let renderedLines = 0;
  const render = () => {
    const columns = stdout.columns ?? 80;
    const rows = stdout.rows ?? 24;
    const shouldClearScreen = options.clearScreen === true;
    const previousRenderedLines = renderedLines;
    if (shouldClearScreen) {
      stdout.write(ANSI.clearScreen + ANSI.moveTo(1, 1));
    } else if (previousRenderedLines > 0) {
      stdout.write(ANSI.up(previousRenderedLines));
    }
    let linesWritten = 0;
    const writeLine = (line) => {
      stdout.write(`${ANSI.clearLine}${line}
`);
      linesWritten += 1;
    };
    const subtitleLines = subtitle ? 3 : 0;
    const fixedLines = 1 + subtitleLines + 2;
    const maxVisibleItems = Math.max(1, Math.min(items.length, rows - fixedLines - 1));
    let windowStart = 0;
    let windowEnd = items.length;
    if (items.length > maxVisibleItems) {
      windowStart = cursor - Math.floor(maxVisibleItems / 2);
      windowStart = Math.max(0, Math.min(windowStart, items.length - maxVisibleItems));
      windowEnd = windowStart + maxVisibleItems;
    }
    const visibleItems = items.slice(windowStart, windowEnd);
    const headerMessage = truncateAnsi(message, Math.max(1, columns - 4));
    writeLine(`${ANSI.dim}\u250C  ${ANSI.reset}${headerMessage}`);
    if (subtitle) {
      writeLine(`${ANSI.dim}\u2502${ANSI.reset}`);
      const sub = truncateAnsi(subtitle, Math.max(1, columns - 4));
      writeLine(`${ANSI.cyan}\u25C6${ANSI.reset}  ${sub}`);
      writeLine("");
    }
    for (let i = 0; i < visibleItems.length; i++) {
      const itemIndex = windowStart + i;
      const item = visibleItems[i];
      if (!item) continue;
      if (item.separator) {
        writeLine(`${ANSI.dim}\u2502${ANSI.reset}`);
        continue;
      }
      if (item.kind === "heading") {
        const heading = truncateAnsi(`${ANSI.dim}${ANSI.bold}${item.label}${ANSI.reset}`, Math.max(1, columns - 6));
        writeLine(`${ANSI.cyan}\u2502${ANSI.reset}  ${heading}`);
        continue;
      }
      const isSelected = itemIndex === cursor;
      const colorCode = getColorCode(item.color);
      let labelText;
      if (item.disabled) {
        labelText = `${ANSI.dim}${item.label} (unavailable)${ANSI.reset}`;
      } else if (isSelected) {
        labelText = colorCode ? `${colorCode}${item.label}${ANSI.reset}` : item.label;
        if (item.hint) labelText += ` ${ANSI.dim}${item.hint}${ANSI.reset}`;
      } else {
        labelText = colorCode ? `${ANSI.dim}${colorCode}${item.label}${ANSI.reset}` : `${ANSI.dim}${item.label}${ANSI.reset}`;
        if (item.hint) labelText += ` ${ANSI.dim}${item.hint}${ANSI.reset}`;
      }
      labelText = truncateAnsi(labelText, Math.max(1, columns - 8));
      if (isSelected) {
        writeLine(`${ANSI.cyan}\u2502${ANSI.reset}  ${ANSI.green}\u25CF${ANSI.reset} ${labelText}`);
      } else {
        writeLine(`${ANSI.cyan}\u2502${ANSI.reset}  ${ANSI.dim}\u25CB${ANSI.reset} ${labelText}`);
      }
    }
    const windowHint = items.length > visibleItems.length ? ` (${windowStart + 1}-${windowEnd}/${items.length})` : "";
    const helpText = options.help ?? `Up/Down to select | Enter: confirm | Esc: back${windowHint}`;
    const help = truncateAnsi(helpText, Math.max(1, columns - 6));
    writeLine(`${ANSI.cyan}\u2502${ANSI.reset}  ${ANSI.dim}${help}${ANSI.reset}`);
    writeLine(`${ANSI.cyan}\u2514${ANSI.reset}`);
    if (!shouldClearScreen && previousRenderedLines > linesWritten) {
      const extra = previousRenderedLines - linesWritten;
      for (let i = 0; i < extra; i++) {
        writeLine("");
      }
    }
    renderedLines = linesWritten;
  };
  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw ?? false;
    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      if (escapeTimeout) {
        clearTimeout(escapeTimeout);
        escapeTimeout = null;
      }
      try {
        stdin.removeListener("data", onKey);
        stdin.setRawMode(wasRaw);
        stdin.pause();
        stdout.write(ANSI.show);
      } catch {
      }
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    };
    const onSignal = () => {
      cleanup();
      resolve(null);
    };
    const finishWithValue = (value) => {
      cleanup();
      resolve(value);
    };
    const findNextSelectable = (from, direction) => {
      if (items.length === 0) return from;
      let next = from;
      do {
        next = (next + direction + items.length) % items.length;
      } while (items[next]?.disabled || items[next]?.separator || items[next]?.kind === "heading");
      return next;
    };
    const onKey = (data) => {
      if (escapeTimeout) {
        clearTimeout(escapeTimeout);
        escapeTimeout = null;
      }
      const action = parseKey(data);
      switch (action) {
        case "up":
          cursor = findNextSelectable(cursor, -1);
          render();
          return;
        case "down":
          cursor = findNextSelectable(cursor, 1);
          render();
          return;
        case "enter":
          finishWithValue(items[cursor]?.value ?? null);
          return;
        case "escape":
          finishWithValue(null);
          return;
        case "escape-start":
          escapeTimeout = setTimeout(() => {
            finishWithValue(null);
          }, ESCAPE_TIMEOUT_MS);
          return;
        default:
          return;
      }
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      stdin.setRawMode(true);
    } catch {
      cleanup();
      resolve(null);
      return;
    }
    stdin.resume();
    stdout.write(ANSI.hide);
    render();
    stdin.on("data", onKey);
  });
}
async function confirm(message, defaultYes = false) {
  const items = defaultYes ? [
    { label: "Yes", value: true },
    { label: "No", value: false }
  ] : [
    { label: "No", value: false },
    { label: "Yes", value: true }
  ];
  const result = await select(items, { message });
  return result ?? false;
}
var ANSI, ESCAPE_TIMEOUT_MS, ANSI_REGEX, ANSI_LEADING_REGEX;
var init_cli_ui = __esm({
  "cli-ui.mjs"() {
    ANSI = {
      // Cursor control
      hide: "\x1B[?25l",
      show: "\x1B[?25h",
      up: (n = 1) => `\x1B[${n}A`,
      down: (n = 1) => `\x1B[${n}B`,
      clearLine: "\x1B[2K",
      clearScreen: "\x1B[2J",
      moveTo: (row, col) => `\x1B[${row};${col}H`,
      // Styles
      cyan: "\x1B[36m",
      green: "\x1B[32m",
      red: "\x1B[31m",
      yellow: "\x1B[33m",
      dim: "\x1B[2m",
      bold: "\x1B[1m",
      reset: "\x1B[0m",
      inverse: "\x1B[7m"
    };
    ESCAPE_TIMEOUT_MS = 50;
    ANSI_REGEX = new RegExp("\\x1b\\[[0-9;]*m", "g");
    ANSI_LEADING_REGEX = new RegExp("^\\x1b\\[[0-9;]*m");
  }
});

// management.mjs
function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.ceil(durationMs / 1e3));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
function parseConfigValue(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  const numeric = Number(value);
  return Number.isNaN(numeric) ? value : numeric;
}
function formatRelativeTime(timestampMs) {
  if (!timestampMs) return "never";
  const elapsed = Math.max(0, Date.now() - timestampMs);
  if (elapsed < 6e4) return "just now";
  if (elapsed < 60 * 6e4) return `${Math.floor(elapsed / 6e4)}m ago`;
  if (elapsed < 24 * 60 * 6e4) return `${Math.floor(elapsed / (60 * 6e4))}h ago`;
  if (elapsed < 48 * 60 * 6e4) return "yesterday";
  return `${Math.floor(elapsed / (24 * 60 * 6e4))}d ago`;
}
function formatAccountStatus(account) {
  if (account.status === "dead") return "[dead]";
  const now = Date.now();
  if (account.cooldown_until > now) {
    return `[cooling down: ${formatDuration(account.cooldown_until - now)}]`;
  }
  if (account.status === "active" && account.consecutive_failures > 0) {
    return "[auth-failing]";
  }
  if (account.status === "active") return "[active]";
  return `[${account.status ?? "unknown"}]`;
}
function redactAccount(account) {
  const redacted = { ...account };
  if (redacted.type === "apikey" && redacted.access) {
    redacted.maskedAccess = `sk-ant-...${String(redacted.access).slice(-4)}`;
  }
  delete redacted.refresh;
  delete redacted.access;
  return redacted;
}
function formatAccountType(type) {
  return type === "apikey" ? "API Key" : "OAuth";
}
function formatUtilization(utilization) {
  const numeric = Number(utilization ?? 0);
  if (!Number.isFinite(numeric)) return "0%";
  return `${Math.round(numeric * 100)}%`;
}
function formatOverage(overage) {
  const numeric = Number(overage ?? 0);
  if (!Number.isFinite(numeric)) return "$0.00";
  return `$${numeric.toFixed(2)}`;
}
function listAccountsWithHealth(dbInstance) {
  const now = Date.now();
  return listAccounts(dbInstance).map((account) => {
    const isStale5h = now - account.util5h_at > STALE_5H;
    const isStale7d = now - account.util7d_at > STALE_7D;
    const isCoolingDown = account.cooldown_until > now;
    const cooldownRemaining = isCoolingDown ? account.cooldown_until - now : 0;
    const isDead = account.status === "dead";
    const healthObj = { ...account, isStale5h, isStale7d, isCoolingDown, cooldownRemaining, isDead };
    const decorated = {
      ...account,
      isStale5h,
      isStale7d,
      isCoolingDown,
      cooldownRemaining,
      isDead,
      util5h: isStale5h ? 0 : account.util5h,
      util7d: isStale7d ? 0 : account.util7d,
      statusBadge: formatAccountStatus(healthObj),
      util5hRelative: formatRelativeTime(account.util5h_at),
      util7dRelative: formatRelativeTime(account.util7d_at),
      overageRelative: formatRelativeTime(account.overage_at)
    };
    return redactAccount(decorated);
  });
}
function removeAccount2(id, dbInstance) {
  const result = removeAccount(dbInstance, id);
  dbInstance.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run("pool_initialized", "true");
  return result;
}
function resetAccount2(id, dbInstance) {
  const account = resetAccount(dbInstance, id);
  dbInstance.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run("pool_initialized", "true");
  return {
    reset: true,
    account: redactAccount(account)
  };
}
function getConfig(dbInstance) {
  const rawEntries = listConfig(dbInstance);
  const userEntries = rawEntries.filter(({ key }) => !INTERNAL_KEYS.has(key));
  let entries;
  if (userEntries.length > 0) {
    entries = userEntries.map(({ key, value }) => ({
      key,
      value: parseConfigValue(value),
      description: CONFIG_DESCRIPTIONS[key] ?? key
    }));
  } else {
    entries = Object.entries(CONFIG_DESCRIPTIONS).map(([key, description]) => ({
      key,
      value: false,
      description
    }));
  }
  return {
    values: Object.fromEntries(entries.map(({ key, value }) => [key, value])),
    entries
  };
}
function setConfig2(key, value, dbInstance) {
  setConfig(dbInstance, key, value);
  return getConfig(dbInstance);
}
var CONFIG_DESCRIPTIONS, INTERNAL_KEYS;
var init_management = __esm({
  "management.mjs"() {
    init_db();
    CONFIG_DESCRIPTIONS = {
      prefer_apikey_over_overage: "Prefer API key accounts over OAuth accounts currently using overage."
    };
    INTERNAL_KEYS = /* @__PURE__ */ new Set(["pool_initialized"]);
  }
});

// cli-menu.mjs
var cli_menu_exports = {};
__export(cli_menu_exports, {
  __test: () => __test,
  showAccountMenu: () => showAccountMenu
});
function colorizeStatusBadge(account) {
  const text = account.statusBadge ?? "";
  if (!text) return "";
  if (account.isDead || text.includes("dead")) return `${ANSI.red}${text}${ANSI.reset}`;
  if (account.isCoolingDown || text.includes("cooling") || text.includes("auth-failing")) {
    return `${ANSI.yellow}${text}${ANSI.reset}`;
  }
  return `${ANSI.green}${text}${ANSI.reset}`;
}
function isActiveForSummary(account) {
  return account.status === "active" && !account.isDead && !account.isCoolingDown && !String(account.statusBadge).includes("auth-failing");
}
function buildAccountLabel(account, index) {
  const type = `[${formatAccountType(account.type)}]`;
  const badge = colorizeStatusBadge(account);
  return `${index + 1}. ${account.label} ${type} ${badge}`.trim();
}
function buildAccountHint(account) {
  if (account.type === "apikey" && account.maskedAccess) {
    return account.maskedAccess;
  }
  return `5h: ${formatUtilization(account.util5h)} \xB7 7d: ${formatUtilization(account.util7d)}`;
}
function buildMainMenuItems(accounts) {
  const activeCount = accounts.filter(isActiveForSummary).length;
  const accountItems = accounts.length > 0 ? accounts.map((account, index) => ({
    label: buildAccountLabel(account, index),
    hint: buildAccountHint(account),
    value: { type: "account", accountId: account.id }
  })) : [{ label: "No accounts configured yet", value: { type: "none" }, disabled: true }];
  return [
    { label: "Actions", value: { type: "noop" }, kind: "heading" },
    { label: "Add Claude Pro/Max account", value: { type: "add-oauth" }, color: "cyan" },
    { label: "Add API Key", value: { type: "add-apikey" }, color: "cyan" },
    { label: "Pool config", value: { type: "pool-config" }, color: "cyan" },
    { label: "", value: { type: "noop" }, separator: true },
    { label: `Accounts (${accounts.length} total, ${activeCount} active)`, value: { type: "noop" }, kind: "heading" },
    ...accountItems,
    { label: "", value: { type: "noop" }, separator: true },
    { label: "Danger zone", value: { type: "noop" }, kind: "heading" },
    { label: "Remove all accounts", value: { type: "remove-all" }, color: "red", disabled: accounts.length === 0 }
  ];
}
async function showPoolConfigMenu(db2) {
  while (true) {
    const cfg = getConfig(db2);
    const items = [
      ...cfg.entries.map(({ key, value, description }) => ({
        label: `${key}: ${String(value)} \u2014 ${description}`,
        value: { type: "toggle", key, value },
        color: "cyan"
      })),
      { label: "Back", value: { type: "back" } }
    ];
    const result = await select(items, {
      message: "Pool Configuration",
      clearScreen: true,
      help: "Up/Down to select | Enter: toggle | Esc: back"
    });
    if (!result || result.type === "back") return;
    const nextValue = typeof result.value === "boolean" ? !result.value : result.value;
    setConfig2(result.key, String(nextValue), db2);
  }
}
async function showAccountDetailsMenu(db2, accountId) {
  while (true) {
    const account = listAccountsWithHealth(db2).find((entry) => entry.id === accountId);
    if (!account) return;
    const result = await select(
      [
        { label: "Back", value: "back" },
        { label: "Reset account", value: "reset", color: "cyan" },
        { label: "Remove account", value: "remove", color: "red" }
      ],
      {
        message: `${account.label} [${formatAccountType(account.type)}] ${colorizeStatusBadge(account)}`,
        subtitle: `5h util: ${formatUtilization(account.util5h)} \xB7 7d util: ${formatUtilization(account.util7d)} \xB7 Overage: ${formatOverage(account.overage)}`,
        clearScreen: true
      }
    );
    if (!result || result === "back") return;
    if (result === "reset") {
      resetAccount2(account.id, db2);
      continue;
    }
    if (result === "remove") {
      const approved = await confirm(`Remove ${account.label}?`);
      if (!approved) continue;
      removeAccount2(account.id, db2);
      return;
    }
  }
}
async function showAccountMenu(db2, deps = {}) {
  const { persistAccountCredentials: persistAccountCredentials2 } = deps;
  while (true) {
    const accounts = listAccountsWithHealth(db2);
    const result = await select(buildMainMenuItems(accounts), {
      message: "Anthropic Account Management",
      subtitle: "Select an action or account",
      clearScreen: true
    });
    if (!result) return null;
    switch (result.type) {
      case "add-oauth":
        return "add-oauth";
      case "add-apikey": {
        const key = await promptApiKey();
        if (key && persistAccountCredentials2) {
          persistAccountCredentials2(db2, "API Key", { apiKey: key }, Date.now(), "apikey");
          console.log(`
  \x1B[32m\u2713\x1B[0m API key added to pool (${key.slice(0, 10)}...${key.slice(-4)})
`);
        } else if (key) {
          console.log("\n  \x1B[31m\u2717\x1B[0m Invalid key or missing persistence function\n");
        }
        break;
      }
      case "pool-config":
        await showPoolConfigMenu(db2);
        break;
      case "account":
        await showAccountDetailsMenu(db2, result.accountId);
        break;
      case "remove-all": {
        const approved = await confirm("Remove ALL accounts? This cannot be undone.");
        if (!approved) break;
        for (const account of accounts) {
          removeAccount2(account.id, db2);
        }
        break;
      }
      default:
        return null;
    }
  }
}
async function promptApiKey() {
  const { createInterface } = await import("node:readline");
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("\nPaste your Anthropic API key (sk-ant-...): ", (answer) => {
      rl.close();
      const key = answer.trim();
      if (key && key.startsWith("sk-")) {
        resolve(key);
      } else if (key) {
        console.log("\n  \x1B[31m\u2717\x1B[0m Invalid format. Expected sk-ant-... or sk-...\n");
        resolve(null);
      } else {
        resolve(null);
      }
    });
  });
}
var __test;
var init_cli_menu = __esm({
  "cli-menu.mjs"() {
    init_cli_ui();
    init_management();
    __test = {
      buildAccountHint,
      buildAccountLabel,
      buildMainMenuItems,
      colorizeStatusBadge,
      isActiveForSummary
    };
  }
});

// index.mjs
init_db();
import { createHash as createHash2, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";

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
        },
        {
          label: "Manage accounts",
          type: "oauth",
          authorize: async (inputs) => {
            if (!inputs) {
              return {
                url: "",
                instructions: "Use `opencode auth login` to manage accounts.",
                method: "auto",
                callback: async () => ({ type: "failed" })
              };
            }
            const { showAccountMenu: showAccountMenu2 } = await Promise.resolve().then(() => (init_cli_menu(), cli_menu_exports));
            const db2 = open();
            const action = await showAccountMenu2(db2, { persistAccountCredentials });
            if (action === "add-oauth") {
              const { url, verifier } = await authorize("max");
              return {
                url,
                instructions: "Paste the authorization code here: ",
                method: "code",
                callback: createClaudeProMaxCallback(verifier)
              };
            }
            return {
              url: "",
              instructions: "",
              method: "auto",
              callback: async () => ({ type: "failed" })
            };
          }
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
  DEAD_AFTER_FAILURES
};
var index_default = AnthropicAuthPlugin;
export {
  AnthropicAuthPlugin,
  index_default as default
};
