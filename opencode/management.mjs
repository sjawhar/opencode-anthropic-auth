import {
  getAccountHealth,
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
    return "[rate-limited]";
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
  return listAccounts(dbInstance).map((account) => {
    const health = getAccountHealth(dbInstance, account.id);
    const decorated = {
      ...account,
      isStale5h: health.isStale5h,
      isStale7d: health.isStale7d,
      isCoolingDown: health.isCoolingDown,
      cooldownRemaining: health.cooldownRemaining,
      isDead: health.isDead,
      util5h: health.isStale5h ? 0 : account.util5h,
      util7d: health.isStale7d ? 0 : account.util7d,
      statusBadge: formatAccountStatus(health),
      util5hRelative: formatRelativeTime(account.util5h_at),
      util7dRelative: formatRelativeTime(account.util7d_at),
      overageRelative: formatRelativeTime(account.overage_at),
    };

    return redactAccount(decorated);
  });
}

export function removeAccount(id, dbInstance) {
  return dbRemoveAccount(dbInstance, id);
}

export function resetAccount(id, dbInstance) {
  const account = dbResetAccount(dbInstance, id);
  return {
    reset: true,
    account: redactAccount(account),
  };
}

export function getConfig(dbInstance) {
  const entries = listConfig(dbInstance).map(({ key, value }) => ({
    key,
    value: parseConfigValue(value),
    description: CONFIG_DESCRIPTIONS[key] ?? key,
  }));

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
