import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { CONFIG_DIR, DB_FILE } from "../constants";

let db: Database | null = null;

export function getDatabase(): Database {
  if (db) return db;

  // 确保配置目录存在
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  db = new Database(DB_FILE);

  // 启用 WAL 模式和外键约束
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // 初始化表结构
  initTables(db);

  return db;
}

function initTables(db: Database): void {
  db.exec(`
    -- providers 主表
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('claude', 'codex')),
      description TEXT,
      website_url TEXT,
      "order" INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    -- provider 环境变量（一对多）
    CREATE TABLE IF NOT EXISTS provider_env (
      provider_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (provider_id, key),
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    );

    -- provider 用量配置（一对一）
    CREATE TABLE IF NOT EXISTS provider_usage_config (
      provider_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      template_type TEXT,
      base_url TEXT,
      access_token TEXT,
      user_id TEXT,
      custom_script TEXT,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    );

    -- common 环境变量
    CREATE TABLE IF NOT EXISTS common_env (
      type TEXT NOT NULL CHECK(type IN ('_global', 'claude', 'codex')),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (type, key)
    );

    -- 用量日志
    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      remaining REAL,
      used REAL,
      unit TEXT DEFAULT 'USD',
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    );

    -- 元数据
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 创建索引
    CREATE INDEX IF NOT EXISTS idx_usage_logs_provider_timestamp
      ON usage_logs(provider_id, timestamp);
  `);

  // 初始化版本号
  const versionStmt = db.prepare("INSERT OR IGNORE INTO metadata (key, value) VALUES ('version', '3')");
  versionStmt.run();
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
