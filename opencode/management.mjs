import {
  listAccounts,
  listConfig,
  removeAccount as dbRemoveAccount,
  resetAccount as dbResetAccount,
  setConfig as dbSetConfig,
} from "./db.mjs";

const STALE_5H = 3_600_000;
const STALE_7D = 43_200_000;

const CONFIG_DESCRIPTIONS = {
  prefer_apikey_over_overage: "Prefer API key accounts over OAuth accounts currently using overage.",
};

const INTERNAL_KEYS = new Set(["pool_initialized"]);

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.ceil(durationMs / 1000));
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

export function formatRelativeTime(timestampMs) {
  if (!timestampMs) return "never";

  const elapsed = Math.max(0, Date.now() - timestampMs);

  if (elapsed < 60_000) return "just now";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))}h ago`;
  if (elapsed < 48 * 60 * 60_000) return "yesterday";
  return `${Math.floor(elapsed / (24 * 60 * 60_000))}d ago`;
}

export function formatAccountStatus(account) {
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

export function redactAccount(account) {
  const redacted = { ...account };
  const maskedAccess =
    redacted.type === "apikey" && redacted.access
      ? `sk-ant-...${String(redacted.access).slice(-4)}`
      : undefined;

  delete redacted.refresh;
  delete redacted.access;

  if (maskedAccess) redacted.maskedAccess = maskedAccess;
  return redacted;
}

export function listAccountsWithHealth(dbInstance) {
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
      overageRelative: formatRelativeTime(account.overage_at),
    };

    return redactAccount(decorated);
  });
}

export function removeAccount(id, dbInstance) {
  const result = dbRemoveAccount(dbInstance, id);
  // Set pool_initialized to prevent auto-migration from resurrecting deleted accounts
  try { dbInstance.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); } catch {}
  dbInstance.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run("pool_initialized", "true");
  return result;
}

export function resetAccount(id, dbInstance) {
  const account = dbResetAccount(dbInstance, id);
  // Set pool_initialized to prevent auto-migration from resurrecting reset accounts
  try { dbInstance.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); } catch {}
  dbInstance.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run("pool_initialized", "true");
  return {
    reset: true,
    account: redactAccount(account),
  };
}

export function getConfig(dbInstance) {
  const rawEntries = listConfig(dbInstance);
  const userEntries = rawEntries.filter(({ key }) => !INTERNAL_KEYS.has(key));

  let entries;
  if (userEntries.length > 0) {
    entries = userEntries.map(({ key, value }) => ({
      key,
      value: parseConfigValue(value),
      description: CONFIG_DESCRIPTIONS[key] ?? key,
    }));
  } else {
    // Fresh install: synthesize defaults from CONFIG_DESCRIPTIONS
    entries = Object.entries(CONFIG_DESCRIPTIONS).map(([key, description]) => ({
      key,
      value: false,
      description,
    }));
  }

  return {
    values: Object.fromEntries(entries.map(({ key, value }) => [key, value])),
    entries,
  };
}

export function setConfig(key, value, dbInstance) {
  dbSetConfig(dbInstance, key, value);
  return getConfig(dbInstance);
}

export const __test = {
  CONFIG_DESCRIPTIONS,
  STALE_5H,
  STALE_7D,
  formatDuration,
  parseConfigValue,
};
