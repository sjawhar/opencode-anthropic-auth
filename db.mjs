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
  return db;
}

export function config(key, fallback) {
  return fallback;
}
