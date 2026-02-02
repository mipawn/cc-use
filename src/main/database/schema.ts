import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  walletBalanceType: text('wallet_balance_type').default('none'),
  walletBalanceUrl: text('wallet_balance_url'),
  walletBalancePath: text('wallet_balance_path'),
  walletBalanceHeaders: text('wallet_balance_headers'),
  cachedWalletBalance: real('cached_wallet_balance'),
  lastBalanceCheckedAt: text('last_balance_checked_at'),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
})

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  providerId: text('provider_id').references(() => providers.id, {
    onDelete: 'cascade',
  }),
  alias: text('alias'),
  value: text('value').notNull(),
  priority: integer('priority').default(0),
  isExhausted: integer('is_exhausted', { mode: 'boolean' }).default(false),
})

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  providerId: text('provider_id').references(() => providers.id, {
    onDelete: 'set null',
  }),
  lastOpenedAt: text('last_opened_at'),
})

export type ProviderRow = typeof providers.$inferSelect
export type ApiKeyRow = typeof apiKeys.$inferSelect
export type ProjectRow = typeof projects.$inferSelect
