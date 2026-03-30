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

export function config(_key, fallback) {
  return fallback;
}
