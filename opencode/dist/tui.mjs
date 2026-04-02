// tui.jsx
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";

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
var STALE_5H = 36e5;
var STALE_7D = 432e5;
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

// management.mjs
var CONFIG_DESCRIPTIONS = {
  prefer_apikey_over_overage: "Prefer API key accounts over OAuth accounts currently using overage."
};
var INTERNAL_KEYS = /* @__PURE__ */ new Set(["pool_initialized"]);
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

// tui.jsx
import { jsx, jsxs } from "@opentui/solid/jsx-runtime";
var truncate = (s, n) => s && s.length > n ? s.slice(0, n - 1) + "\u2026" : s || "";
var colors = (current) => ({
  panel: current.backgroundPanel,
  border: current.border,
  text: current.text,
  muted: current.textMuted,
  accent: current.primary,
  success: current.success,
  warning: current.warning,
  error: current.error
});
var utilLine = (a) => {
  const u5 = typeof a.util5h === "number" ? (a.util5h * 100).toFixed(0) + "%" : "?";
  const u7 = typeof a.util7d === "number" ? (a.util7d * 100).toFixed(0) + "%" : "?";
  const s5 = a.isStale5h ? " (stale)" : "";
  const s7 = a.isStale7d ? " (stale)" : "";
  return `5h: ${u5}${s5} \xB7 7d: ${u7}${s7} \xB7 ${a.util5hRelative || "never"}`;
};
function showAccountList(api, db2) {
  const accounts = listAccountsWithHealth(db2);
  const active = accounts.filter((a) => !a.isDead && !a.isCoolingDown).length;
  const options = accounts.map((a) => ({
    title: `${truncate(a.label, 20)} ${a.type === "apikey" ? "[API Key]" : "[OAuth]"} ${a.statusBadge}`,
    value: a.id,
    description: utilLine(a)
  }));
  options.push({
    title: "Config",
    value: "__config__",
    description: "Pool configuration settings"
  });
  options.push({
    title: "Back",
    value: "__back__",
    description: "Return home"
  });
  const DialogSelect = api.ui.DialogSelect;
  api.ui.dialog.setSize("large");
  api.ui.dialog.replace(() => /* @__PURE__ */ jsx(
    DialogSelect,
    {
      title: `Anthropic Accounts (${accounts.length} total, ${active} active)`,
      options,
      onSelect: (item) => {
        api.ui.dialog.clear();
        if (item.value === "__back__") {
          api.route.navigate("home");
          return;
        }
        if (item.value === "__config__") {
          showConfig(api, db2);
          return;
        }
        const account = accounts.find((a) => a.id === item.value);
        if (account) showAccountDetail(api, db2, account);
      }
    }
  ));
}
function showAccountDetail(api, db2, account) {
  const options = [];
  if (account.isDead || account.isCoolingDown) {
    options.push({
      title: "Reset",
      value: "reset",
      description: "Reset to active state"
    });
  }
  options.push({
    title: "Remove",
    value: "remove",
    description: "Remove from pool permanently"
  });
  options.push({ title: "Back", value: "back" });
  const DialogSelect = api.ui.DialogSelect;
  api.ui.dialog.setSize("medium");
  api.ui.dialog.replace(() => /* @__PURE__ */ jsx(
    DialogSelect,
    {
      title: `${truncate(account.label, 30)} (${account.type})`,
      options,
      onSelect: (item) => {
        api.ui.dialog.clear();
        if (item.value === "reset") {
          try {
            resetAccount2(account.id, db2);
            api.ui.toast({
              variant: "success",
              title: "Account Reset",
              message: `"${truncate(account.label, 20)}" reset to active`,
              duration: 3e3
            });
          } catch (e) {
            api.ui.toast({
              variant: "error",
              title: "Reset Failed",
              message: String(e.message || e),
              duration: 4e3
            });
          }
          showAccountList(api, db2);
        } else if (item.value === "remove") {
          showRemoveConfirm(api, db2, account);
        } else {
          showAccountList(api, db2);
        }
      }
    }
  ));
}
function showRemoveConfirm(api, db2, account) {
  const DialogConfirm = api.ui.DialogConfirm;
  api.ui.dialog.setSize("medium");
  api.ui.dialog.replace(() => /* @__PURE__ */ jsx(
    DialogConfirm,
    {
      title: "Remove Account",
      message: `Remove "${truncate(account.label, 30)}"? This cannot be undone.`,
      onConfirm: () => {
        try {
          removeAccount2(account.id, db2);
          api.ui.toast({
            variant: "success",
            title: "Removed",
            message: `"${truncate(account.label, 20)}" removed from pool`,
            duration: 3e3
          });
        } catch (e) {
          api.ui.toast({
            variant: "error",
            title: "Remove Failed",
            message: String(e.message || e),
            duration: 4e3
          });
        }
        showAccountList(api, db2);
      },
      onCancel: () => showAccountDetail(api, db2, account)
    }
  ));
}
function showConfig(api, db2) {
  const cfg = getConfig(db2);
  const options = cfg.entries.map((e) => ({
    title: `${e.key}: ${e.value}`,
    value: e.key,
    description: e.description
  }));
  options.push({ title: "Back", value: "__back__" });
  const DialogSelect = api.ui.DialogSelect;
  api.ui.dialog.setSize("medium");
  api.ui.dialog.replace(() => /* @__PURE__ */ jsx(
    DialogSelect,
    {
      title: "Pool Configuration",
      options,
      onSelect: (item) => {
        api.ui.dialog.clear();
        if (item.value === "__back__") {
          showAccountList(api, db2);
          return;
        }
        const current = cfg.values[item.value];
        if (typeof current === "boolean") {
          showConfigToggle(api, db2, item.value, current);
        } else {
          api.ui.toast({
            variant: "info",
            title: "Info",
            message: `"${item.value}" is not toggleable`,
            duration: 2e3
          });
          showConfig(api, db2);
        }
      }
    }
  ));
}
function showConfigToggle(api, db2, key, current) {
  const DialogConfirm = api.ui.DialogConfirm;
  api.ui.dialog.setSize("medium");
  api.ui.dialog.replace(() => /* @__PURE__ */ jsx(
    DialogConfirm,
    {
      title: "Toggle Config",
      message: `Set "${key}" to ${!current}?`,
      onConfirm: () => {
        try {
          setConfig2(key, String(!current), db2);
          api.ui.toast({
            variant: "success",
            title: "Config Updated",
            message: `${key} = ${!current}`,
            duration: 3e3
          });
        } catch (e) {
          api.ui.toast({
            variant: "error",
            title: "Update Failed",
            message: String(e.message || e),
            duration: 4e3
          });
        }
        showConfig(api, db2);
      },
      onCancel: () => showConfig(api, db2)
    }
  ));
}
var AccountListScreen = (props) => {
  const dim = useTerminalDimensions();
  const skin = colors(props.api.theme.current);
  const accounts = listAccountsWithHealth(props.db);
  const active = accounts.filter((a) => !a.isDead && !a.isCoolingDown).length;
  setTimeout(() => {
    if (props.api.route.current.name === "accounts.list") {
      showAccountList(props.api, props.db);
    }
  }, 0);
  useKeyboard((evt) => {
    if (props.api.route.current.name !== "accounts.list") return;
    if (props.api.ui.dialog.open) return;
    if (evt.name === "escape") {
      evt.preventDefault();
      evt.stopPropagation();
      props.api.route.navigate("home");
    }
  });
  return /* @__PURE__ */ jsxs(
    "box",
    {
      width: dim().width,
      height: dim().height,
      backgroundColor: skin.panel,
      flexDirection: "column",
      paddingTop: 1,
      paddingLeft: 2,
      paddingRight: 2,
      children: [
        /* @__PURE__ */ jsx("box", { paddingBottom: 1, children: /* @__PURE__ */ jsxs("text", { fg: skin.text, children: [
          /* @__PURE__ */ jsx("b", { children: "Anthropic Account Management" }),
          /* @__PURE__ */ jsxs("span", { style: { fg: skin.muted }, children: [
            " ",
            "\u2014 ",
            accounts.length,
            " total, ",
            active,
            " active"
          ] })
        ] }) }),
        accounts.map((a) => /* @__PURE__ */ jsxs("box", { flexDirection: "column", paddingBottom: 1, children: [
          /* @__PURE__ */ jsxs("text", { fg: skin.text, children: [
            truncate(a.label, 20),
            " ",
            /* @__PURE__ */ jsx("span", { style: { fg: skin.accent }, children: a.type === "apikey" ? "[API Key]" : "[OAuth]" }),
            " ",
            /* @__PURE__ */ jsx("span", { style: { fg: skin.muted }, children: a.statusBadge })
          ] }),
          /* @__PURE__ */ jsxs("text", { fg: skin.muted, children: [
            " ",
            utilLine(a)
          ] })
        ] }))
      ]
    }
  );
};
var tui = async (api, options, meta) => {
  const db2 = open();
  api.route.register([
    {
      name: "accounts.list",
      render: ({ params }) => /* @__PURE__ */ jsx(AccountListScreen, { api, db: db2, params })
    }
  ]);
  api.command.register(() => [
    {
      title: "Manage Accounts",
      value: "anthropic-auth.accounts",
      category: "Anthropic Auth",
      slash: { name: "accounts" },
      onSelect: () => api.route.navigate("accounts.list")
    }
  ]);
  api.slots.register({
    slots: {
      home_footer(ctx) {
        const skin = colors(ctx.theme.current);
        const accounts = listAccountsWithHealth(db2);
        const active = accounts.filter(
          (a) => !a.isDead && !a.isCoolingDown
        ).length;
        const label = accounts.length === 0 ? "Anthropic: No accounts" : `Anthropic: ${accounts.length} accounts (${active} active)`;
        return /* @__PURE__ */ jsx("box", { paddingLeft: 1, children: /* @__PURE__ */ jsxs("text", { fg: skin.muted, children: [
          /* @__PURE__ */ jsx("span", { style: { fg: skin.accent }, children: "\u25CF" }),
          " ",
          label
        ] }) });
      }
    }
  });
  api.lifecycle.onDispose(() => {
  });
};
var plugin = { id: "anthropic-auth-tui", tui };
var tui_default = plugin;
export {
  tui_default as default
};
