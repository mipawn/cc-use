// Provider types - only claude and codex are supported
export type ProviderType = 'claude' | 'codex'

// v3.2.0: ClientKind - 客户端类型 (替代 ProviderType)
// ProviderType 混淆了供应商、客户端、协议格式,逐步迁移到 ClientKind
export type ClientKind = 'codex' | 'claude_code' | 'claude_desktop'

// 接入形态: cc-use 能不能亲自启动这个客户端
export type IntegrationForm =
  | 'process_injection'   // 进程级: wrapper 注入 env (Claude Code)
  | 'config_takeover'     // 配置级: 改客户端配置文件指向本地代理 (Codex/Claude Desktop)

// 协议格式 (网关内部用于路由与转换)
export type ProtocolFormat = 'codex_responses' | 'openai_chat' | 'anthropic_messages'

// 配置作用域 (只对 config_takeover 有意义)
export type ConfigScope =
  | 'codex_user_config'        // ~/.codex/config.toml
  | 'claude_desktop_app_config'

// ClientKind 配置
export interface ClientKindConfig {
  kind: ClientKind
  label: string
  form: IntegrationForm
  defaultProtocol: ProtocolFormat
  cliCommand?: string // 仅 process_injection 有值
}

// ClientKind 配置表
export const CLIENT_KIND_CONFIGS: ClientKindConfig[] = [
  {
    kind: 'claude_code',
    label: 'Claude Code',
    form: 'process_injection',
    defaultProtocol: 'anthropic_messages',
    cliCommand: 'claude',
  },
  {
    kind: 'codex',
    label: 'Codex',
    form: 'config_takeover',
    defaultProtocol: 'codex_responses',
    cliCommand: 'codex',
  },
  {
    kind: 'claude_desktop',
    label: 'Claude Desktop',
    form: 'config_takeover',
    defaultProtocol: 'anthropic_messages',
  },
]

// Helper: 获取 ClientKind 配置
export function getClientKindConfig(kind: ClientKind): ClientKindConfig {
  const config = CLIENT_KIND_CONFIGS.find((c) => c.kind === kind)
  if (!config) {
    return CLIENT_KIND_CONFIGS[0] // Default to claude_code
  }
  return config
}

// 临时兼容: ProviderType -> ClientKind 映射
export function providerTypeToClientKind(type: ProviderType): ClientKind {
  return type === 'claude' ? 'claude_code' : 'codex'
}

// 临时兼容: ClientKind -> ProviderType 映射 (仅 claude_code/codex)
export function clientKindToProviderType(kind: ClientKind): ProviderType | null {
  if (kind === 'claude_code') return 'claude'
  if (kind === 'codex') return 'codex'
  return null // claude_desktop 无对应 ProviderType
}

export type PresetIcon =
  | 'claude'
  | 'codex'
  | 'deepseek'
  | 'newapi'
  | 'custom'

// Terminal types
export type TerminalType = 'iterm2' | 'terminal'

// Terminal type display labels
export const TERMINAL_TYPE_LABELS: Record<TerminalType, string> = {
  iterm2: 'iTerm2',
  terminal: 'Terminal (macOS)',
}

// Format inline env vars + command (unix format)
export function formatEnvCommand(
  envVars: Record<string, string>,
  command: string,
): string {
  const entries = Object.entries(envVars)
  const inline = entries.map(([k, v]) => `${k}="${v}"`).join(' ')
  return `${inline} ${command}`
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
    envKeyName: 'ANTHROPIC_AUTH_TOKEN',
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
): string {
  const config = getProviderTypeConfig(provider.type)
  const baseUrl = useProxy ? `http://localhost:${proxyPort}` : provider.baseUrl
  const key = useProxy ? 'proxy' : apiKey

  const envVars: Record<string, string> = {
    [config.envBaseUrlName]: baseUrl,
    [config.envKeyName]: key,
  }
  return formatEnvCommand(envVars, config.cliCommand)
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
  walletBalanceType: 'none' | 'newapi' | 'custom' | 'deepseek'
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
  sortOrder: number
  // v3.2.0: 格式转换
  apiFormat?: string
  transformEnabled: boolean
}

export interface CreateProviderInput {
  name: string
  baseUrl: string
  type?: ProviderType
  website?: string
  remark?: string
  token?: string
  icon?: string
  walletBalanceType?: 'none' | 'newapi' | 'custom' | 'deepseek'
  walletBalanceUrl?: string
  walletBalancePath?: string
  walletBalanceHeaders?: string
  walletBalanceUserId?: string
  usageType?: 'none' | 'newapi' | 'custom'
  usageUrl?: string
  usagePath?: string
  usageHeaders?: string
  // v3.2.0: 格式转换
  apiFormat?: string
  transformEnabled?: boolean
}

export interface UpdateProviderInput extends Partial<CreateProviderInput> {
  id: string
  isActive?: boolean
  // v3.2.0: 格式转换
  apiFormat?: string
  transformEnabled?: boolean
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
  modelMapping: string | null
  // Failover state — managed by the proxy's key_selector
  cooldownUntil: string | null
  lastErrorAt: string | null
  lastErrorKind: string | null
  consecutiveErrors: number
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
  modelMapping?: string
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
  modelMapping?: string
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

/// Realtime console event — a discriminated union carried over one transport.
/// Mirrors the Rust `proxy::console::ConsoleEvent` tagged serde enum.
/// - `category: "request"` — a proxy request crossing the handler
/// - `category: "log"` — a log record from Rust `log::*` in daemon/app or a
///   renderer `console.*` call (captured by rendererConsoleTap)
///
/// Not persisted. When the Console page is closed, in-flight events are
/// dropped and history does not replay on reopen.
export type ConsoleEvent = ConsoleRequestEvent | ConsoleLogEvent

export interface ConsoleRequestEvent {
  category: 'request'
  /// UTC timestamp formatted `YYYY-MM-DD HH:MM:SS` (seconds resolution).
  timestamp: string
  /// HTTP method, or "WS" for websocket upgrades.
  method: string
  /// Incoming request path + query as seen by the proxy.
  path: string
  /// Upstream response status; null for pre-dispatch rejections.
  status: number | null
  /// Wall-clock latency from handler entry to emission.
  latencyMs: number | null
  /// Final upstream URL we forwarded to; null for rejection / passthrough miss.
  upstream: string | null
  /// Provider display name; null for passthrough or rejection.
  provider: string | null
  /// API key alias; null for passthrough or rejection.
  keyAlias: string | null
  /// Classification tag.
  kind: 'ok' | 'upstream_error' | 'rejected' | 'ws' | string
  /// Optional human-readable note (error text, "streaming", ...).
  message: string | null
}

export interface ConsoleLogEvent {
  category: 'log'
  /// UTC timestamp `YYYY-MM-DD HH:MM:SS`.
  timestamp: string
  /// Severity.
  level: 'error' | 'warn' | 'info' | 'debug' | 'trace' | string
  /// Where the log came from.
  source: 'daemon' | 'app' | 'renderer' | string
  /// Log target / module path; null if unknown (renderer console).
  target: string | null
  /// Log message body.
  message: string
}

// CLI configuration for Claude Code or Codex
export interface CliConfig {
  model?: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
  [key: string]: unknown // Allow additional custom fields
}

export interface TerminalLaunchPreview {
  cliType: ProviderType
  env: Record<string, string>
  command: string
}

// Global settings types
export interface GlobalSettings {
  defaultProviderType: ProviderType
  proxyPort: number
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
  walletBalanceType?: 'none' | 'newapi' | 'custom' | 'deepseek'
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
  // Snapshot columns — preserve display names after entity deletion
  keyAlias?: string | null
  providerName?: string | null
  projectName?: string | null
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

export type ManagedInstanceStatus = 'launching' | 'running' | 'stale' | 'stopped' | 'failed'

export interface ManagedInstance {
  id: string
  sessionToken: string
  projectId: string | null
  providerId: string | null
  apiKeyId: string | null
  cliType: ProviderType
  terminalType: TerminalType
  projectPath: string
  shellPid: number | null
  processPid: number | null
  status: ManagedInstanceStatus | string
  assignmentSource: string | null
  lastSeenAt: string
  launchedAt: string
  stoppedAt: string | null
  stopReason: string | null
  exitCode: number | null
}

export interface UpdateManagedInstanceAssignmentInput {
  id: string
  providerId: string
  apiKeyId: string
  assignmentSource?: string
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

export interface PaginatedRecentRequests {
  items: RecentRequestLogDisplay[]
  total: number
  page: number
  pageSize: number
}

export interface CostStatistics {
  summary: CostStatsSummary
  topKeys: TopKeyCostItem[]
  topProviders: TopProviderCostItem[]
  topProjects: TopProjectCostItem[]
  topModels: TopModelCostItem[]
  dailyTrend: DailyCostTrendItem[]
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
