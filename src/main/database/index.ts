import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import * as schema from './schema'

let db: ReturnType<typeof drizzle<typeof schema>> | null = null
let sqlite: Database.Database | null = null

export function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return db
}

export function initDatabase() {
  if (db) return db

  const userDataPath = app.getPath('userData')
  const dbDir = join(userDataPath, 'data')

  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }

  const dbPath = join(dbDir, 'cc-use.db')
  console.log('Database path:', dbPath)

  sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  db = drizzle(sqlite, { schema })

  // Create tables if not exist
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      type TEXT DEFAULT 'claude',
      website TEXT,
      remark TEXT,
      token TEXT,
      icon TEXT,
      wallet_balance_type TEXT DEFAULT 'none',
      wallet_balance_url TEXT,
      wallet_balance_path TEXT,
      wallet_balance_headers TEXT,
      cached_wallet_balance REAL,
      last_balance_checked_at TEXT,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      provider_id TEXT REFERENCES providers(id) ON DELETE CASCADE,
      alias TEXT,
      value TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      is_exhausted INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
      last_opened_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `)

  // Migration: Add new columns to existing providers table
  try {
    sqlite.exec(`ALTER TABLE providers ADD COLUMN type TEXT DEFAULT 'claude'`)
  } catch {}
  try {
    sqlite.exec(`ALTER TABLE providers ADD COLUMN website TEXT`)
  } catch {}
  try {
    sqlite.exec(`ALTER TABLE providers ADD COLUMN remark TEXT`)
  } catch {}
  try {
    sqlite.exec(`ALTER TABLE providers ADD COLUMN token TEXT`)
  } catch {}
  try {
    sqlite.exec(`ALTER TABLE providers ADD COLUMN icon TEXT`)
  } catch {}

  return db
}

export function closeDatabase() {
  if (sqlite) {
    sqlite.close()
    sqlite = null
    db = null
  }
}
