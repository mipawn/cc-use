// Provider types - only claude and codex are supported
export type ProviderType = 'claude' | 'codex'
export type PresetIcon =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'zhipu'
  | 'minimax'
  | 'xiaomi'
  | 'deepseek'
  | 'custom'

// Terminal types
export type TerminalType = 'iterm2' | 'terminal' | 'wt' | 'powershell' | 'cmd'

// Terminal type display labels
export const TERMINAL_TYPE_LABELS: Record<TerminalType, string> = {
  iterm2: 'iTerm2',
  terminal: 'Terminal (macOS)',
  wt: 'Windows Terminal',
  powershell: 'PowerShell',
  cmd: 'CMD',
}

// Check if a terminal type uses Windows-style commands
export function isWindowsTerminal(terminalType: TerminalType): boolean {
  return terminalType === 'cmd' || terminalType === 'powershell' || terminalType === 'wt'
}

// Format inline env vars + command for the given terminal type
export function formatEnvCommand(
  envVars: Record<string, string>,
  command: string,
  terminalType: TerminalType,
): string {
  const entries = Object.entries(envVars)
  switch (terminalType) {
    case 'cmd': {
      const sets = entries.map(([k, v]) => `set ${k}=${v}`)
      return [...sets, command].join(' && ')
    }
    case 'powershell':
    case 'wt': {
      const sets = entries.map(([k, v]) => `$env:${k}="${v}"`)
      return [...sets, command].join('; ')
    }
    default: {
      const inline = entries.map(([k, v]) => `${k}="${v}"`).join(' ')
      return `${inline} ${command}`
    }
  }
}

// Usage data structure (from NewAPI or custom API)
export interface UsageData {
  total?: number // Total quota
  used?: number // Used amount
  remaining?: number // Remaining amount
  unit?: string // Unit (e.g., "USD", "tokens")
  isUnlimited?: boolean // Whether unlimited
  expireAt?: string // Expiration time
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
    cliCommand: 'claude',
  },
  {
    type: 'codex',
    label: 'Codex',
    envKeyName: 'OPENAI_API_KEY',
    envBaseUrlName: 'OPENAI_BASE_URL',
    defaultBaseUrl: 'https://api.openai.com',
    cliCommand: 'codex',
  },
]

// Helper function to get provider type config
export function getProviderTypeConfig(type: ProviderType): ProviderTypeConfig {
  const config = PROVIDER_TYPE_CONFIGS.find((c) => c.type === type)
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
  proxyPort: number = 12345,
  terminalType: TerminalType = 'iterm2',
): string {
  const config = getProviderTypeConfig(provider.type)
  const baseUrl = useProxy ? `http://localhost:${proxyPort}` : provider.baseUrl
  const key = useProxy ? 'proxy' : apiKey

  const envVars: Record<string, string> = {
    [config.envBaseUrlName]: baseUrl,
    [config.envKeyName]: key,
  }
  return formatEnvCommand(envVars, config.cliCommand, terminalType)
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
  // Cached model pricing from provider's pricing API
  cachedModelPricing: Record<string, { input: number; output: number; cacheRead?: number; cacheCreation?: number }> | null
  lastPricingSyncedAt: string | null
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
  // Cost multiplier for this key (e.g., 1.5 means 150% of base price)
  costMultiplier: number
}

export interface CreateApiKeyInput {
  providerId: string
  alias?: string
  value: string
  types?: ProviderType[] // defaults to ['claude']
  priority?: number
  isActive?: boolean
  config?: CliConfig
  costMultiplier?: number
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
  costMultiplier?: number
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
  usageLogs: UsageLog[]
  requestLogs: RequestLog[]
}

export interface ExportProvider {
  id: string
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
  id: string
  alias?: string
  value: string
  types?: ProviderType[]
  priority: number
  costMultiplier?: number
}

export interface RequestLog {
  id: string
  providerId: string | null
  apiKeyId: string | null
  projectId: string | null
  sessionId: string | null
  model: string | null
  requestModel: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  inputCostUsd: number
  outputCostUsd: number
  cacheReadCostUsd: number
  cacheCreationCostUsd: number
  totalCostUsd: number
  costMultiplier: number
  latencyMs: number | null
  firstTokenMs: number | null
  statusCode: number | null
  errorMessage: string | null
  isStreaming: boolean
  createdAt: string
}

// Export options
export interface ExportOptions {
  includeProviders: boolean
  includeUsageLogs: boolean
  includeRequestLogs: boolean
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
  byKey: {
    keyId: string
    keyAlias: string
    providerName: string
    keyType: ProviderType
    count: number
  }[]
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

// Migration types (Electron → Tauri)
export interface MigrationCheck {
  needed: boolean
  electronDbPath: string
}

export interface MigrationResult {
  success: boolean
  providers: number
  apiKeys: number
  projects: number
  requestLogs: number
  usageLogs: number
}
