import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DB_PATH = join(homedir(), ".opencode", "data", "anthropic-pool.db");

let db;

export function open() {
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
  // Migrations: add columns for refresh lock and failure tracking
  try { db.exec("ALTER TABLE account ADD COLUMN refresh_lock INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE account ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE account ADD COLUMN type TEXT NOT NULL DEFAULT 'oauth'"); } catch {}
  return db;
}

// Stale lock timeout: if a process crashes mid-refresh, the lock expires after this
const LOCK_TIMEOUT = 30000; // 30s

/**
 * Atomically acquire an exclusive refresh lock for an account.
 * Uses SQLite write serialization to guarantee only one process wins.
 * Returns true if lock acquired, false if another process holds it.
 */
export function tryAcquireRefreshLock(id) {
  const db = open();
  const now = Date.now();
  const result = db.prepare(
    "UPDATE account SET refresh_lock = ? WHERE id = ? AND (refresh_lock = 0 OR refresh_lock < ?)"
  ).run(now, id, now - LOCK_TIMEOUT);
  return result.changes === 1;
}

/**
 * Release the refresh lock for an account.
 */
export function releaseRefreshLock(id) {
  const db = open();
  db.prepare("UPDATE account SET refresh_lock = 0 WHERE id = ?").run(id);
}

export function config(key, fallback) {
  const db = open();
  try { db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); } catch {}
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key);
  if (!row) return fallback;
  if (row.value === "true") return true;
  if (row.value === "false") return false;
  const num = Number(row.value);
  return Number.isNaN(num) ? row.value : num;
}

// --- Management operations ---

const STALE_5H = 3600000; // 1 hour
const STALE_7D = 43200000; // 12 hours

/**
 * List all accounts (all statuses) with required fields.
 * Excludes refresh and access tokens.
 */
export function listAccounts(dbInstance) {
  const db = dbInstance || open();
  const rows = db.prepare(`
    SELECT
      id, label, type, status, cooldown_until, expires,
      util5h, util5h_at, util7d, util7d_at,
      overage, overage_at, consecutive_failures
    FROM account
  `).all();
  return rows;
}

/**
 * Hard delete an account by ID.
 * Returns { deleted: boolean, remaining: number }
 */
export function removeAccount(dbInstance, id) {
  const db = dbInstance || open();
  const result = db.prepare("DELETE FROM account WHERE id = ?").run(id);
  const remaining = db.prepare("SELECT COUNT(*) as count FROM account").get();
  return {
    deleted: result.changes === 1,
    remaining: remaining.count,
  };
}

/**
 * Reset an account: status='active', cooldown_until=0, consecutive_failures=0, refresh_lock=0.
 * Preserves tokens, label, type, utilization.
 * Returns redacted account (no tokens).
 * Throws if account does not exist.
 */
export function resetAccount(dbInstance, id) {
  const db = dbInstance || open();
  const existing = db.prepare("SELECT id FROM account WHERE id = ?").get(id);
  if (!existing) throw new Error(`Account not found: ${id}`);

  db.prepare(`
    UPDATE account
    SET status = 'active', cooldown_until = 0, consecutive_failures = 0, refresh_lock = 0
    WHERE id = ?
  `).run(id);

  const updated = db.prepare(`
    SELECT
      id, label, type, status, cooldown_until, expires,
      util5h, util5h_at, util7d, util7d_at,
      overage, overage_at, consecutive_failures, refresh_lock
    FROM account WHERE id = ?
  `).get(id);

  return updated;
}

/**
 * Get account health with computed staleness and cooldown info.
 * Returns account with: isStale5h, isStale7d, isCoolingDown, cooldownRemaining, isDead.
 * No tokens included.
 * Throws if account does not exist.
 */
export function getAccountHealth(dbInstance, id) {
  const db = dbInstance || open();
  const row = db.prepare(`
    SELECT
      id, label, type, status, cooldown_until, expires,
      util5h, util5h_at, util7d, util7d_at,
      overage, overage_at, consecutive_failures
    FROM account WHERE id = ?
  `).get(id);

  if (!row) throw new Error(`Account not found: ${id}`);

  const now = Date.now();
  const isStale5h = now - row.util5h_at > STALE_5H;
  const isStale7d = now - row.util7d_at > STALE_7D;
  const isCoolingDown = row.cooldown_until > now;
  const cooldownRemaining = isCoolingDown ? row.cooldown_until - now : 0;
  const isDead = row.status === 'dead';

  return {
    ...row,
    isStale5h,
    isStale7d,
    isCoolingDown,
    cooldownRemaining,
    isDead,
  };
}

/**
 * Set a config value. Only accepts allowlisted keys.
 * Throws on unknown keys.
 */
export function setConfig(dbInstance, key, value) {
  const allowlist = ['prefer_apikey_over_overage'];
  if (!allowlist.includes(key)) {
    throw new Error(`Unknown config key: ${key}`);
  }

  const db = dbInstance || open();
  try { db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); } catch {}
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, value);
}

/**
 * List all config rows as { key, value } array.
 */
export function listConfig(dbInstance) {
  const db = dbInstance || open();
  try { db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); } catch {}
  return db.prepare("SELECT key, value FROM config").all();
}
