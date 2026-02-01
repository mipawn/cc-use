import { getDatabase } from "./database";
import { Config, DEFAULT_CONFIG, Provider, CLIType, generateId, UsageConfig, Common } from "./types";

export function ensureConfigDir(): void {
  // 调用 getDatabase() 会自动初始化数据库和目录
  getDatabase();
}

// ============ Provider 管理 ============

function rowToProvider(row: any): Provider {
  const db = getDatabase();

  // 获取环境变量
  const envRows = db.prepare("SELECT key, value FROM provider_env WHERE provider_id = ?").all(row.id) as { key: string; value: string }[];
  const env: Record<string, string> = {};
  for (const envRow of envRows) {
    env[envRow.key] = envRow.value;
  }

  // 获取用量配置
  const usageRow = db.prepare("SELECT * FROM provider_usage_config WHERE provider_id = ?").get(row.id) as any;
  let usageConfig: UsageConfig | undefined;
  if (usageRow) {
    usageConfig = {
      enabled: Boolean(usageRow.enabled),
      templateType: usageRow.template_type as 'newapi' | 'custom',
      baseUrl: usageRow.base_url || undefined,
      accessToken: usageRow.access_token || undefined,
      userId: usageRow.user_id || undefined,
      customScript: usageRow.custom_script || undefined,
    };
  }

  return {
    id: row.id,
    name: row.name,
    type: row.type as CLIType,
    description: row.description || undefined,
    websiteUrl: row.website_url || undefined,
    env,
    order: row.order,
    usageConfig,
    createdAt: row.created_at || undefined,
    updatedAt: row.updated_at || undefined,
  };
}

export function getProviders(): Provider[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM providers ORDER BY "order" ASC').all();
  return rows.map(rowToProvider);
}

export function getProvidersByType(type: CLIType): Provider[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM providers WHERE type = ? ORDER BY "order" ASC').all(type);
  return rows.map(rowToProvider);
}

export function getProvider(id: string): Provider | undefined {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM providers WHERE id = ?").get(id);
  return row ? rowToProvider(row) : undefined;
}

export function getProviderByName(name: string): Provider | undefined {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM providers WHERE name = ?").get(name);
  return row ? rowToProvider(row) : undefined;
}

export function addProvider(provider: Omit<Provider, 'id' | 'order' | 'createdAt'>): Provider {
  const db = getDatabase();

  // 检查名称是否已存在
  const existing = db.prepare("SELECT id FROM providers WHERE name = ?").get(provider.name);
  if (existing) {
    throw new Error(`Provider "${provider.name}" already exists`);
  }

  const id = generateId();
  const maxOrderRow = db.prepare('SELECT MAX("order") as max_order FROM providers').get() as { max_order: number | null };
  const order = (maxOrderRow?.max_order ?? -1) + 1;
  const createdAt = new Date().toISOString();

  db.transaction(() => {
    // 插入 provider
    db.prepare(`
      INSERT INTO providers (id, name, type, description, website_url, "order", created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, provider.name, provider.type, provider.description || null, provider.websiteUrl || null, order, createdAt);

    // 插入环境变量
    const envStmt = db.prepare("INSERT INTO provider_env (provider_id, key, value) VALUES (?, ?, ?)");
    for (const [key, value] of Object.entries(provider.env)) {
      envStmt.run(id, key, value);
    }

    // 插入用量配置
    if (provider.usageConfig) {
      db.prepare(`
        INSERT INTO provider_usage_config (provider_id, enabled, template_type, base_url, access_token, user_id, custom_script)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        provider.usageConfig.enabled ? 1 : 0,
        provider.usageConfig.templateType || null,
        provider.usageConfig.baseUrl || null,
        provider.usageConfig.accessToken || null,
        provider.usageConfig.userId || null,
        provider.usageConfig.customScript || null
      );
    }
  })();

  return getProvider(id)!;
}

export function updateProvider(id: string, updates: Partial<Omit<Provider, 'id' | 'createdAt'>>): Provider {
  const db = getDatabase();

  // 检查 provider 是否存在
  const existing = db.prepare("SELECT * FROM providers WHERE id = ?").get(id);
  if (!existing) {
    throw new Error(`Provider with id "${id}" not found`);
  }

  // 如果更新名称，检查是否与其他 provider 冲突
  if (updates.name) {
    const nameConflict = db.prepare("SELECT id FROM providers WHERE name = ? AND id != ?").get(updates.name, id);
    if (nameConflict) {
      throw new Error(`Provider "${updates.name}" already exists`);
    }
  }

  const updatedAt = new Date().toISOString();

  db.transaction(() => {
    // 更新 provider 主表
    const setClauses: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined) {
      setClauses.push("name = ?");
      values.push(updates.name);
    }
    if (updates.type !== undefined) {
      setClauses.push("type = ?");
      values.push(updates.type);
    }
    if (updates.description !== undefined) {
      setClauses.push("description = ?");
      values.push(updates.description || null);
    }
    if (updates.websiteUrl !== undefined) {
      setClauses.push("website_url = ?");
      values.push(updates.websiteUrl || null);
    }
    if (updates.order !== undefined) {
      setClauses.push('"order" = ?');
      values.push(updates.order);
    }

    setClauses.push("updated_at = ?");
    values.push(updatedAt);
    values.push(id);

    if (setClauses.length > 1) {
      db.prepare(`UPDATE providers SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
    }

    // 更新环境变量
    if (updates.env !== undefined) {
      db.prepare("DELETE FROM provider_env WHERE provider_id = ?").run(id);
      const envStmt = db.prepare("INSERT INTO provider_env (provider_id, key, value) VALUES (?, ?, ?)");
      for (const [key, value] of Object.entries(updates.env)) {
        envStmt.run(id, key, value);
      }
    }

    // 更新用量配置
    if (updates.usageConfig !== undefined) {
      db.prepare("DELETE FROM provider_usage_config WHERE provider_id = ?").run(id);
      if (updates.usageConfig) {
        db.prepare(`
          INSERT INTO provider_usage_config (provider_id, enabled, template_type, base_url, access_token, user_id, custom_script)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          updates.usageConfig.enabled ? 1 : 0,
          updates.usageConfig.templateType || null,
          updates.usageConfig.baseUrl || null,
          updates.usageConfig.accessToken || null,
          updates.usageConfig.userId || null,
          updates.usageConfig.customScript || null
        );
      }
    }
  })();

  return getProvider(id)!;
}

export function removeProvider(id: string): void {
  const db = getDatabase();

  const existing = db.prepare("SELECT id FROM providers WHERE id = ?").get(id);
  if (!existing) {
    throw new Error(`Provider with id "${id}" not found`);
  }

  db.transaction(() => {
    // 获取被删除 provider 的 order
    const row = db.prepare('SELECT "order" FROM providers WHERE id = ?').get(id) as { order: number };
    const deletedOrder = row.order;

    // 删除 provider（级联删除会自动清理关联表）
    db.prepare("DELETE FROM providers WHERE id = ?").run(id);

    // 重新排序：将 order 大于被删除的都减 1
    db.prepare('UPDATE providers SET "order" = "order" - 1 WHERE "order" > ?').run(deletedOrder);
  })();
}

export function duplicateProvider(id: string, newName: string): Provider {
  const db = getDatabase();

  const original = getProvider(id);
  if (!original) {
    throw new Error(`Provider with id "${id}" not found`);
  }

  const nameConflict = db.prepare("SELECT id FROM providers WHERE name = ?").get(newName);
  if (nameConflict) {
    throw new Error(`Provider "${newName}" already exists`);
  }

  return addProvider({
    name: newName,
    type: original.type,
    description: original.description ? `Copy of ${original.description}` : `Copy of ${original.name}`,
    websiteUrl: original.websiteUrl,
    env: { ...original.env },
    usageConfig: original.usageConfig ? { ...original.usageConfig } : undefined,
  });
}

export function reorderProviders(orderedIds: string[]): void {
  const db = getDatabase();

  // 验证所有 ID 都存在
  for (const id of orderedIds) {
    const existing = db.prepare("SELECT id FROM providers WHERE id = ?").get(id);
    if (!existing) {
      throw new Error(`Provider with id "${id}" not found`);
    }
  }

  db.transaction(() => {
    const stmt = db.prepare('UPDATE providers SET "order" = ? WHERE id = ?');
    orderedIds.forEach((id, index) => {
      stmt.run(index, id);
    });
  })();
}

// ============ Common 管理 ============

export function getCommon(): Common {
  const db = getDatabase();
  const rows = db.prepare("SELECT type, key, value FROM common_env").all() as { type: string; key: string; value: string }[];

  const common: Common = {};
  for (const row of rows) {
    const type = row.type as keyof Common;
    if (!common[type]) {
      common[type] = {};
    }
    common[type]![row.key] = row.value;
  }

  return common;
}

export function getCommonForType(type: CLIType | '_global'): Record<string, string> {
  const db = getDatabase();
  const rows = db.prepare("SELECT key, value FROM common_env WHERE type = ?").all(type) as { key: string; value: string }[];

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export function setCommonForType(type: CLIType | '_global', values: Record<string, string>): void {
  const db = getDatabase();

  db.transaction(() => {
    db.prepare("DELETE FROM common_env WHERE type = ?").run(type);
    const stmt = db.prepare("INSERT INTO common_env (type, key, value) VALUES (?, ?, ?)");
    for (const [key, value] of Object.entries(values)) {
      stmt.run(type, key, value);
    }
  })();
}

export function updateCommonForType(type: CLIType | '_global', updates: Record<string, string>): void {
  const db = getDatabase();

  db.transaction(() => {
    const stmt = db.prepare("INSERT OR REPLACE INTO common_env (type, key, value) VALUES (?, ?, ?)");
    for (const [key, value] of Object.entries(updates)) {
      stmt.run(type, key, value);
    }
  })();
}

export function removeCommonKeysForType(type: CLIType | '_global', keys: string[]): void {
  const db = getDatabase();

  db.transaction(() => {
    const stmt = db.prepare("DELETE FROM common_env WHERE type = ? AND key = ?");
    for (const key of keys) {
      stmt.run(type, key);
    }
  })();
}

// Get merged env: _global + type-specific common + provider.env (provider takes precedence)
export function getMergedEnv(provider: Provider): Record<string, string> {
  const globalCommon = getCommonForType('_global');
  const typeCommon = getCommonForType(provider.type);

  return {
    ...globalCommon,
    ...typeCommon,
    ...provider.env,
  };
}

// ============ Config 兼容层 ============

export function loadConfig(): Config {
  ensureConfigDir();

  return {
    version: "3",
    common: getCommon(),
    providers: getProviders(),
  };
}

export function saveConfig(config: Config): void {
  const db = getDatabase();

  db.transaction(() => {
    // 清空所有数据
    db.prepare("DELETE FROM provider_env").run();
    db.prepare("DELETE FROM provider_usage_config").run();
    db.prepare("DELETE FROM providers").run();
    db.prepare("DELETE FROM common_env").run();

    // 插入 providers
    for (const provider of config.providers) {
      db.prepare(`
        INSERT INTO providers (id, name, type, description, website_url, "order", created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        provider.id,
        provider.name,
        provider.type,
        provider.description || null,
        provider.websiteUrl || null,
        provider.order,
        provider.createdAt || new Date().toISOString(),
        provider.updatedAt || null
      );

      // 插入环境变量
      const envStmt = db.prepare("INSERT INTO provider_env (provider_id, key, value) VALUES (?, ?, ?)");
      for (const [key, value] of Object.entries(provider.env)) {
        envStmt.run(provider.id, key, value);
      }

      // 插入用量配置
      if (provider.usageConfig) {
        db.prepare(`
          INSERT INTO provider_usage_config (provider_id, enabled, template_type, base_url, access_token, user_id, custom_script)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          provider.id,
          provider.usageConfig.enabled ? 1 : 0,
          provider.usageConfig.templateType || null,
          provider.usageConfig.baseUrl || null,
          provider.usageConfig.accessToken || null,
          provider.usageConfig.userId || null,
          provider.usageConfig.customScript || null
        );
      }
    }

    // 插入 common
    const commonStmt = db.prepare("INSERT INTO common_env (type, key, value) VALUES (?, ?, ?)");
    for (const [type, values] of Object.entries(config.common)) {
      if (values) {
        for (const [key, value] of Object.entries(values)) {
          commonStmt.run(type, key, value);
        }
      }
    }
  })();
}

// ============ 导出/导入配置 ============

export function exportConfig(): Config {
  return loadConfig();
}

export function importConfig(config: Config, force: boolean = false): { imported: number; skipped: number } {
  const db = getDatabase();
  let imported = 0;
  let skipped = 0;

  db.transaction(() => {
    for (const provider of config.providers) {
      const existing = db.prepare("SELECT id, \"order\" FROM providers WHERE name = ?").get(provider.name) as { id: string; order: number } | undefined;

      if (existing) {
        if (force) {
          // 更新现有 provider，保留原有的 id 和 order
          db.prepare(`
            UPDATE providers SET type = ?, description = ?, website_url = ?, updated_at = ?
            WHERE id = ?
          `).run(provider.type, provider.description || null, provider.websiteUrl || null, new Date().toISOString(), existing.id);

          // 更新环境变量
          db.prepare("DELETE FROM provider_env WHERE provider_id = ?").run(existing.id);
          const envStmt = db.prepare("INSERT INTO provider_env (provider_id, key, value) VALUES (?, ?, ?)");
          for (const [key, value] of Object.entries(provider.env)) {
            envStmt.run(existing.id, key, value);
          }

          // 更新用量配置
          db.prepare("DELETE FROM provider_usage_config WHERE provider_id = ?").run(existing.id);
          if (provider.usageConfig) {
            db.prepare(`
              INSERT INTO provider_usage_config (provider_id, enabled, template_type, base_url, access_token, user_id, custom_script)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
              existing.id,
              provider.usageConfig.enabled ? 1 : 0,
              provider.usageConfig.templateType || null,
              provider.usageConfig.baseUrl || null,
              provider.usageConfig.accessToken || null,
              provider.usageConfig.userId || null,
              provider.usageConfig.customScript || null
            );
          }

          imported++;
        } else {
          skipped++;
        }
      } else {
        // 新增 provider
        const id = provider.id || generateId();
        const maxOrderRow = db.prepare('SELECT MAX("order") as max_order FROM providers').get() as { max_order: number | null };
        const order = (maxOrderRow?.max_order ?? -1) + 1;

        db.prepare(`
          INSERT INTO providers (id, name, type, description, website_url, "order", created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, provider.name, provider.type, provider.description || null, provider.websiteUrl || null, order, provider.createdAt || new Date().toISOString());

        // 插入环境变量
        const envStmt = db.prepare("INSERT INTO provider_env (provider_id, key, value) VALUES (?, ?, ?)");
        for (const [key, value] of Object.entries(provider.env)) {
          envStmt.run(id, key, value);
        }

        // 插入用量配置
        if (provider.usageConfig) {
          db.prepare(`
            INSERT INTO provider_usage_config (provider_id, enabled, template_type, base_url, access_token, user_id, custom_script)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            id,
            provider.usageConfig.enabled ? 1 : 0,
            provider.usageConfig.templateType || null,
            provider.usageConfig.baseUrl || null,
            provider.usageConfig.accessToken || null,
            provider.usageConfig.userId || null,
            provider.usageConfig.customScript || null
          );
        }

        imported++;
      }
    }

    // 合并 common
    if (config.common) {
      const stmt = db.prepare("INSERT OR REPLACE INTO common_env (type, key, value) VALUES (?, ?, ?)");
      for (const [type, values] of Object.entries(config.common)) {
        if (values) {
          for (const [key, value] of Object.entries(values)) {
            stmt.run(type, key, value);
          }
        }
      }
    }
  })();

  return { imported, skipped };
}
