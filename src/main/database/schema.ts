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
  walletBalanceUserId: text('wallet_balance_user_id'),
  cachedWalletBalance: real('cached_wallet_balance'),
  lastBalanceCheckedAt: text('last_balance_checked_at'),
  // Usage configuration
  usageType: text('usage_type').default('none'), // 'none' | 'newapi' | 'custom'
  usageUrl: text('usage_url'),
  usagePath: text('usage_path'),
  usageHeaders: text('usage_headers'),
  cachedUsage: text('cached_usage'), // JSON string of UsageData
  lastUsageCheckedAt: text('last_usage_checked_at'),
  // Cost multiplier for this provider (e.g., 1.5 means 150% of base price)
  costMultiplier: real('cost_multiplier').default(1),
  // Cached model pricing from provider's /api/pricing endpoint
  cachedModelPricing: text('cached_model_pricing'), // JSON: Record<string, ModelPricing>
  lastPricingSyncedAt: text('last_pricing_synced_at'),
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
  // Key-level usage/quota configuration
  usageType: text('usage_type').default('none'), // 'none' | 'newapi' | 'custom'
  usageUrl: text('usage_url'),
  usagePath: text('usage_path'),
  usageHeaders: text('usage_headers'),
  cachedUsage: text('cached_usage'), // JSON string of UsageData
  lastUsageCheckedAt: text('last_usage_checked_at'),
  // Cost multiplier for this key (e.g., 1.5 means 150% of base price)
  costMultiplier: real('cost_multiplier').default(1),
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

// Request logs - records each API request for cost tracking
export const requestLogs = sqliteTable('request_logs', {
  id: text('id').primaryKey(),
  providerId: text('provider_id').references(() => providers.id, {
    onDelete: 'set null',
  }),
  apiKeyId: text('api_key_id').references(() => apiKeys.id, {
    onDelete: 'set null',
  }),
  projectId: text('project_id').references(() => projects.id, {
    onDelete: 'set null',
  }),
  sessionId: text('session_id'),
  // Model info
  model: text('model'), // Actual model used
  requestModel: text('request_model'), // Model requested
  // Token usage
  inputTokens: integer('input_tokens').default(0),
  outputTokens: integer('output_tokens').default(0),
  cacheReadTokens: integer('cache_read_tokens').default(0),
  cacheCreationTokens: integer('cache_creation_tokens').default(0),
  // Cost breakdown (in USD)
  inputCostUsd: real('input_cost_usd').default(0),
  outputCostUsd: real('output_cost_usd').default(0),
  cacheReadCostUsd: real('cache_read_cost_usd').default(0),
  cacheCreationCostUsd: real('cache_creation_cost_usd').default(0),
  totalCostUsd: real('total_cost_usd').default(0),
  // Provider cost multiplier at time of request
  costMultiplier: real('cost_multiplier').default(1),
  // Performance metrics
  latencyMs: integer('latency_ms'),
  firstTokenMs: integer('first_token_ms'),
  // Request status
  statusCode: integer('status_code'),
  errorMessage: text('error_message'),
  isStreaming: integer('is_streaming', { mode: 'boolean' }).default(false),
  // Timestamp
  createdAt: text('created_at').notNull(),
})

export type RequestLogRow = typeof requestLogs.$inferSelect
