import ky from 'ky';

// API Base URL - 开发环境使用代理，生产环境使用相对路径
const API_BASE_URL = import.meta.env.DEV ? '/api' : '/api';

// ============================================================
// TypeScript Interfaces
// ============================================================

export type CLIType = 'claude' | 'codex';

// 用量查询配置
export interface UsageConfig {
  enabled: boolean;
  templateType: 'newapi' | 'custom';

  // NewAPI 模板参数
  baseUrl?: string;
  accessToken?: string;
  userId?: string;

  // 自定义模板
  customScript?: string;
}

// 用量数据
export interface UsageData {
  planName?: string;
  total?: number;
  used?: number;
  remaining?: number;
  todayUsed?: number;
  requestCount?: number;
  unit?: string;
  lastUpdated?: string;
  error?: string;
}

// Provider（原 Profile）
export interface Provider {
  id: string;
  name: string;
  type: CLIType;
  description?: string;
  websiteUrl?: string;
  env: Record<string, string>;
  order: number;
  usageConfig?: UsageConfig;
  usageData?: UsageData;
  createdAt?: string;
  updatedAt?: string;
}

// Common（原 Defaults）
export interface Common {
  _global?: Record<string, string>;
  claude?: Record<string, string>;
  codex?: Record<string, string>;
}

// CLI 类型配置
export interface CLITypeConfig {
  type: CLIType;
  command: string;
  displayName: string;
  icon: {
    terminal: string;
    color: string;
  };
}

// 完整配置
export interface Config {
  version: string;
  common: Common;
  providers: Provider[];
}

// 导入结果
export interface ImportResult {
  imported: number;
  skipped: number;
}

// Create ky instance with base configuration
const api = ky.create({
  prefixUrl: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ============================================================
// Providers CRUD
// ============================================================

/**
 * Get all providers, optionally filtered by type
 */
export async function getProviders(type?: CLIType): Promise<Provider[]> {
  const searchParams = type ? { type } : undefined;
  return api.get('providers', { searchParams }).json<Provider[]>();
}

/**
 * Get a single provider by ID
 */
export async function getProvider(id: string): Promise<Provider> {
  return api.get(`providers/${encodeURIComponent(id)}`).json<Provider>();
}

/**
 * Create a new provider
 */
export async function createProvider(provider: Partial<Provider>): Promise<Provider> {
  return api.post('providers', { json: provider }).json<Provider>();
}

/**
 * Update an existing provider
 */
export async function updateProvider(id: string, provider: Partial<Provider>): Promise<Provider> {
  return api.put(`providers/${encodeURIComponent(id)}`, { json: provider }).json<Provider>();
}

/**
 * Delete a provider
 */
export async function deleteProvider(id: string): Promise<void> {
  await api.delete(`providers/${encodeURIComponent(id)}`);
}

/**
 * Duplicate a provider with a new name
 */
export async function duplicateProvider(id: string, newName: string): Promise<Provider> {
  return api
    .post(`providers/${encodeURIComponent(id)}/duplicate`, {
      json: { newName },
    })
    .json<Provider>();
}

/**
 * Reorder providers
 */
export async function reorderProviders(orderedIds: string[]): Promise<void> {
  await api.put('provider-order', { json: { orderedIds } });
}

/**
 * Refresh usage data for a provider
 */
export async function refreshProviderUsage(id: string): Promise<UsageData> {
  return api.post(`providers/${encodeURIComponent(id)}/refresh-usage`).json<UsageData>();
}

/**
 * Test API connection for a provider
 */
export async function testProviderConnection(id: string): Promise<{ success: boolean; message: string }> {
  return api.post(`providers/${encodeURIComponent(id)}/test-connection`).json();
}

/**
 * Test usage query for a provider
 */
export async function testProviderUsage(id: string): Promise<UsageData> {
  return api.post(`providers/${encodeURIComponent(id)}/test-usage`).json<UsageData>();
}

// ============================================================
// Common (原 Defaults)
// ============================================================

/**
 * Get all common config
 */
export async function getCommon(): Promise<Common> {
  return api.get('common').json<Common>();
}

/**
 * Get common config for a specific CLI type
 */
export async function getCommonForType(type: string): Promise<Record<string, string>> {
  return api.get(`common/${encodeURIComponent(type)}`).json<Record<string, string>>();
}

/**
 * Update common config for a specific CLI type (full replace)
 */
export async function setCommonForType(
  type: string,
  values: Record<string, string>
): Promise<Record<string, string>> {
  return api
    .put(`common/${encodeURIComponent(type)}`, { json: values })
    .json<Record<string, string>>();
}

/**
 * Partial update common config for a specific CLI type
 */
export async function updateCommonForType(
  type: string,
  values: Record<string, string>
): Promise<Record<string, string>> {
  return api
    .patch(`common/${encodeURIComponent(type)}`, { json: values })
    .json<Record<string, string>>();
}

// ============================================================
// CLI Types
// ============================================================

/**
 * Get all available CLI types
 */
export async function getCLITypes(): Promise<CLITypeConfig[]> {
  return api.get('cli-types').json<CLITypeConfig[]>();
}

// ============================================================
// Config Import/Export
// ============================================================

/**
 * Export the entire configuration
 */
export async function exportConfig(): Promise<Config> {
  return api.get('config/export').json<Config>();
}

/**
 * Import a configuration
 */
export async function importConfig(config: Config, force?: boolean): Promise<ImportResult> {
  const searchParams = force !== undefined ? { force: String(force) } : undefined;
  return api.post('config/import', { json: config, searchParams }).json<ImportResult>();
}
