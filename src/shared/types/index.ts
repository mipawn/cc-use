// Provider types - only claude and codex are supported
export type ProviderType = 'claude' | 'codex'
export type PresetIcon = 'claude' | 'codex' | 'gemini' | 'zhipu' | 'minimax' | 'xiaomi' | 'deepseek' | 'custom'

// Terminal types
export type TerminalType = 'iterm2' | 'terminal' | 'wt' | 'powershell' | 'cmd'

// Usage data structure (from NewAPI or custom API)
export interface UsageData {
  total?: number       // Total quota
  used?: number        // Used amount
  remaining?: number   // Remaining amount
  unit?: string        // Unit (e.g., "USD", "tokens")
  isUnlimited?: boolean  // Whether unlimited
  expireAt?: string    // Expiration time
}

// Provider type configuration for environment variable injection
export interface ProviderTypeConfig {
  type: ProviderType
  label: string
  envKeyName: string
  envBaseUrlName: string
  defaultBaseUrl: string
  cliCommand: string
}

// Predefined provider type configurations
export const PROVIDER_TYPE_CONFIGS: ProviderTypeConfig[] = [
  {
    type: 'claude',
    label: 'Claude',
    envKeyName: 'ANTHROPIC_API_KEY',
    envBaseUrlName: 'ANTHROPIC_BASE_URL',
    defaultBaseUrl: 'https://api.anthropic.com',
    cliCommand: 'claude'
  },
  {
    type: 'codex',
    label: 'Codex',
    envKeyName: 'OPENAI_API_KEY',
    envBaseUrlName: 'OPENAI_BASE_URL',
    defaultBaseUrl: 'https://api.openai.com',
    cliCommand: 'codex'
  }
]

// Helper function to get provider type config
export function getProviderTypeConfig(type: ProviderType): ProviderTypeConfig {
  const config = PROVIDER_TYPE_CONFIGS.find(c => c.type === type)
  if (!config) {
    return PROVIDER_TYPE_CONFIGS[0] // Default to claude
  }
  return config
}

// Generate terminal command for a provider
export function generateTerminalCommand(
  provider: { type: ProviderType; baseUrl: string },
  apiKey: string,
  useProxy: boolean = false,
  proxyPort: number = 12345
): string {
  const config = getProviderTypeConfig(provider.type)
  const baseUrl = useProxy ? `http://localhost:${proxyPort}` : provider.baseUrl
  const key = useProxy ? 'proxy' : apiKey

  return `export ${config.envBaseUrlName}=${baseUrl} && export ${config.envKeyName}=${key} && ${config.cliCommand}`
}

export interface Provider {
  id: string
  name: string
  baseUrl: string
  type?: ProviderType // Deprecated - type is now on ApiKey, kept for backward compatibility
  website: string | null
  remark: string | null
  token: string | null
  icon: string | null
  // Balance configuration
  walletBalanceType: 'none' | 'newapi' | 'custom'
  walletBalanceUrl: string | null
  walletBalancePath: string | null
  walletBalanceHeaders: string | null
  walletBalanceUserId: string | null
  cachedWalletBalance: number | null
  lastBalanceCheckedAt: string | null
  // Usage configuration
  usageType: 'none' | 'newapi' | 'custom'
  usageUrl: string | null
  usagePath: string | null
  usageHeaders: string | null
  cachedUsage: UsageData | null
  lastUsageCheckedAt: string | null
  // Cost multiplier for this provider (e.g., 1.5 means 150% of base price)
  costMultiplier?: number
  isActive: boolean
}

export interface CreateProviderInput {
  name: string
  baseUrl: string
  type?: ProviderType
  website?: string
  remark?: string
  token?: string
  icon?: string
  walletBalanceType?: 'none' | 'newapi' | 'custom'
  walletBalanceUrl?: string
  walletBalancePath?: string
  walletBalanceHeaders?: string
  walletBalanceUserId?: string
  usageType?: 'none' | 'newapi' | 'custom'
  usageUrl?: string
  usagePath?: string
  usageHeaders?: string
}

export interface UpdateProviderInput extends Partial<CreateProviderInput> {
  id: string
  isActive?: boolean
}

// API Key types
export interface ApiKey {
  id: string
  providerId: string
  alias: string | null
  value: string
  types: ProviderType[] // supports multiple types
  priority: number
  isExhausted: boolean
  isActive: boolean
  config?: CliConfig // Per-key configuration override
  // Key-level usage/quota
  usageType: 'none' | 'newapi' | 'custom'
  usageUrl: string | null
  usagePath: string | null
  usageHeaders: string | null
  cachedUsage: UsageData | null
  lastUsageCheckedAt: string | null
}

export interface CreateApiKeyInput {
  providerId: string
  alias?: string
  value: string
  types?: ProviderType[] // defaults to ['claude']
  priority?: number
  isActive?: boolean
  config?: CliConfig
  usageType?: 'none' | 'newapi' | 'custom'
  usageUrl?: string
  usagePath?: string
  usageHeaders?: string
}

export interface UpdateApiKeyInput {
  id: string
  alias?: string
  value?: string
  types?: ProviderType[]
  priority?: number
  isExhausted?: boolean
  isActive?: boolean
  config?: CliConfig
  usageType?: 'none' | 'newapi' | 'custom'
  usageUrl?: string
  usagePath?: string
  usageHeaders?: string
}

// Project types
export interface Project {
  id: string
  name: string
  path: string
  remark: string | null
  providerId: string | null
  apiKeyId: string | null
  cliType: ProviderType // CLI type for launching terminal
  terminalType: TerminalType
  lastOpenedAt: string | null
}

export interface CreateProjectInput {
  name: string
  path: string
  remark?: string
  providerId?: string
  apiKeyId?: string
  cliType?: ProviderType
  terminalType?: TerminalType
}

export interface UpdateProjectInput {
  id: string
  name?: string
  remark?: string
  providerId?: string
  apiKeyId?: string
  cliType?: ProviderType
  terminalType?: TerminalType
}

// Proxy types
export interface ProxyStatus {
  isRunning: boolean
  port: number
  requestCount: number
  lastError: string | null
}

// CLI configuration for Claude Code or Codex
export interface CliConfig {
  model?: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
  [key: string]: unknown // Allow additional custom fields
}

// Global settings types
export interface GlobalSettings {
  defaultProviderType: ProviderType
  proxyPort: number
  autoStartProxy: boolean
  defaultTerminalType: TerminalType
  closeToTray: boolean
  claudeConfig?: CliConfig
  codexConfig?: CliConfig
}

// Import/Export types
export interface ExportData {
  version: string
  exportedAt: string
  providers: ExportProvider[]
}

export interface ExportProvider {
  name: string
  type: ProviderType
  baseUrl: string
  website?: string
  remark?: string
  icon?: string
  walletBalanceType?: 'none' | 'newapi' | 'custom'
  walletBalanceUrl?: string
  walletBalancePath?: string
  walletBalanceHeaders?: string
  usageType?: 'none' | 'newapi' | 'custom'
  usageUrl?: string
  usagePath?: string
  usageHeaders?: string
  apiKeys: ExportApiKey[]
}

export interface ExportApiKey {
  alias?: string
  value: string
  types?: ProviderType[]
  priority: number
}

// Import options
export interface ImportOptions {
  overwrite: boolean // If true, overwrite existing providers with same name
}

// Import result
export interface ImportResult {
  imported: number
  skipped: number
  errors: string[]
}

// Session types for proxy hot-switching
export interface ProxySession {
  sessionToken: string
  providerId: string
  apiKeyId: string
  projectId: string | null
  createdAt: string
}

// Usage log types for statistics
export interface UsageLog {
  id: string
  projectId: string | null
  projectName: string
  providerId: string | null
  providerName: string | null
  apiKeyId: string | null
  apiKeyAlias: string | null
  keyType: ProviderType | null
  launchedAt: string
  duration: number | null
}

// Usage statistics
export interface UsageStats {
  totalLaunches: number
  uniqueProjects: number
  uniqueKeys: number
  byProject: { projectId: string; projectName: string; count: number }[]
  byKey: { keyId: string; keyAlias: string; providerName: string; keyType: ProviderType; count: number }[]
  byDate: { date: string; count: number }[]
}

// Time range for statistics query
export type StatsTimeRange = 'today' | 'yesterday' | 'week' | 'month' | 'all'

// Cost statistics types
export interface CostStatsSummary {
  totalRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  totalCostUsd: number
  avgLatencyMs: number | null
}

export interface TopKeyCostItem {
  keyId: string
  keyAlias: string
  providerName: string
  totalCost: number
  totalRequests: number
  totalTokens: number
}

export interface TopProviderCostItem {
  providerId: string
  providerName: string
  totalCost: number
  totalRequests: number
  totalTokens: number
}

export interface TopProjectCostItem {
  projectId: string
  projectName: string
  totalCost: number
  totalRequests: number
  totalTokens: number
}

export interface TopModelCostItem {
  model: string
  totalCost: number
  totalRequests: number
  totalTokens: number
}

export interface DailyCostTrendItem {
  date: string
  cost: number
  requests: number
}

export interface RecentRequestLogDisplay {
  id: string
  model: string | null
  keyAlias: string | null
  providerName: string | null
  projectName: string | null
  totalCostUsd: number
  inputTokens: number
  outputTokens: number
  latencyMs: number | null
  statusCode: number | null
  createdAt: string
}

export interface CostStatistics {
  summary: CostStatsSummary
  topKeys: TopKeyCostItem[]
  topProviders: TopProviderCostItem[]
  topProjects: TopProjectCostItem[]
  topModels: TopModelCostItem[]
  dailyTrend: DailyCostTrendItem[]
  recentRequests: RecentRequestLogDisplay[]
}

export interface DashboardCostStats {
  todayCost: number
  totalCost: number
  todayRequests: number
  todayTokens: number
  weeklyTrend: DailyCostTrendItem[]
  topKeys: TopKeyCostItem[]
  topProjects: TopProjectCostItem[]
}

export interface UpdateCheckResult {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  releaseUrl: string
  releaseNotes: string
}
