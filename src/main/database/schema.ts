import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  type: text('type').default('claude'), // 'claude' | 'codex' | 'gemini'
  website: text('website'),
  remark: text('remark'),
  token: text('token'), // API token for claude code/codex authentication
  icon: text('icon'), // preset name or local file path
  // Balance configuration
  walletBalanceType: text('wallet_balance_type').default('none'),
  walletBalanceUrl: text('wallet_balance_url'),
  walletBalancePath: text('wallet_balance_path'),
  walletBalanceHeaders: text('wallet_balance_headers'),
  cachedWalletBalance: real('cached_wallet_balance'),
  lastBalanceCheckedAt: text('last_balance_checked_at'),
  // Usage configuration
  usageType: text('usage_type').default('none'), // 'none' | 'newapi' | 'custom'
  usageUrl: text('usage_url'),
  usagePath: text('usage_path'),
  usageHeaders: text('usage_headers'),
  cachedUsage: text('cached_usage'), // JSON string of UsageData
  lastUsageCheckedAt: text('last_usage_checked_at'),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
})

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  providerId: text('provider_id').references(() => providers.id, {
    onDelete: 'cascade',
  }),
  alias: text('alias'),
  value: text('value').notNull(),
  types: text('types').default('["claude"]'), // JSON array of 'claude' | 'codex'
  priority: integer('priority').default(0),
  isExhausted: integer('is_exhausted', { mode: 'boolean' }).default(false),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  config: text('config'), // JSON string of CliConfig - per-key configuration override
})

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  remark: text('remark'),
  providerId: text('provider_id').references(() => providers.id, {
    onDelete: 'set null',
  }),
  apiKeyId: text('api_key_id').references(() => apiKeys.id, {
    onDelete: 'set null',
  }),
  cliType: text('cli_type').default('claude'), // 'claude' | 'codex'
  terminalType: text('terminal_type').default('iterm2'), // 'iterm2' | 'terminal' | 'wt' | 'powershell' | 'cmd'
  lastOpenedAt: text('last_opened_at'),
})

export type ProviderRow = typeof providers.$inferSelect
export type ApiKeyRow = typeof apiKeys.$inferSelect
export type ProjectRow = typeof projects.$inferSelect

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
})

export type SettingsRow = typeof settings.$inferSelect

// Usage logs - records each terminal launch for statistics
export const usageLogs = sqliteTable('usage_logs', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, {
    onDelete: 'cascade',
  }),
  projectName: text('project_name').notNull(), // Denormalized for history
  providerId: text('provider_id').references(() => providers.id, {
    onDelete: 'set null',
  }),
  providerName: text('provider_name'), // Denormalized for history
  apiKeyId: text('api_key_id').references(() => apiKeys.id, {
    onDelete: 'set null',
  }),
  apiKeyAlias: text('api_key_alias'), // Denormalized for history
  keyType: text('key_type'), // 'claude' | 'codex'
  launchedAt: text('launched_at').notNull(), // ISO timestamp
  duration: integer('duration'), // Session duration in seconds (optional, for future use)
})

export type UsageLogRow = typeof usageLogs.$inferSelect
