// Provider types - kept as string for backward compatibility with stored data.
export type ProviderType = string

// v3.2.0: ClientKind - 客户端类型 (替代 ProviderType)
// ProviderType 混淆了供应商、客户端、协议格式,逐步迁移到 ClientKind
export type ClientKind = 'claude_code' | 'grok' | 'codex' | 'claude_desktop'

// 接入形态: cc-use 能不能亲自启动这个客户端
export type IntegrationForm =
  | 'process_injection' // 进程级: wrapper 注入 env (Claude Code)
  | 'config_takeover' // 配置级: 改客户端配置文件指向本地代理 (Codex/Claude Desktop)

// 配置作用域 (只对 config_takeover 有意义)
export type ConfigScope =
  | 'codex_user_config' // ~/.codex/config.toml
  | 'claude_desktop_app_config'

// ClientKind 配置
export interface ClientKindConfig {
  kind: ClientKind
  label: string
  form: IntegrationForm
  cliCommand?: string // 仅 process_injection 有值
}

// ClientKind 配置表
export const CLIENT_KIND_CONFIGS: ClientKindConfig[] = [
  {
    kind: 'claude_code',
    label: 'Claude Code',
    form: 'process_injection',
    cliCommand: 'claude',
  },
  {
    kind: 'grok',
    label: 'Grok Build',
    form: 'process_injection',
    cliCommand: 'grok',
  },
  {
    kind: 'codex',
    label: 'Codex Desktop',
    form: 'config_takeover',
    // Desktop app config takeover; no terminal command.
  },
  {
    kind: 'claude_desktop',
    label: 'Claude Desktop',
    form: 'config_takeover',
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

// ClientConfig - 客户端专用配置 (存储在 ApiKey.clientConfigs 中)
export type UpstreamAuthScheme = 'x-api-key' | 'bearer' | 'none'

export interface ClientConfig {
  baseUrl?: string // 覆盖 provider.baseUrl
  authScheme?: UpstreamAuthScheme // 覆盖上游认证头
}

// 临时兼容: ProviderType -> ClientKind 映射
export function providerTypeToClientKind(type: ProviderType): ClientKind {
  if (type === 'claude' || type === 'claude_code') return 'claude_code'
  if (type === 'grok') return 'grok'
  if (type === 'codex') return 'codex'
  if (type === 'claude_desktop') return 'claude_desktop'
  return 'claude_code' // fallback
}

// 临时兼容: ClientKind -> ProviderType 映射 (仅进程级 CLI 与 Codex)
export function clientKindToProviderType(kind: ClientKind): ProviderType | null {
  if (kind === 'claude_code') return 'claude_code'
  if (kind === 'grok') return 'grok'
  if (kind === 'codex') return 'codex'
  return null // claude_desktop 无对应 ProviderType
}

export const CLI_CLIENT_KINDS: ClientKind[] = ['claude_code', 'grok']
export const CONFIG_TAKEOVER_CLIENT_KINDS: ClientKind[] = ['codex', 'claude_desktop']

export function isCliClientKind(kind: string): kind is ClientKind {
  return kind === 'claude_code' || kind === 'grok'
}

export function getClientKindLabel(kind: string): string {
  switch (kind) {
    case 'claude':
    case 'claude_code':
      return 'Claude Code'
    case 'codex':
      return 'Codex Desktop'
    case 'grok':
      return 'Grok Build'
    case 'claude_desktop':
      return 'Claude Desktop'
    default:
      return kind
  }
}

export function normalizeClientKind(type: string): ClientKind {
  return providerTypeToClientKind(type)
}

export type PresetIcon = 'claude' | 'codex' | 'deepseek' | 'newapi' | 'custom'

// Terminal types
export type TerminalType = 'iterm2' | 'terminal'

// Terminal type display labels
export const TERMINAL_TYPE_LABELS: Record<TerminalType, string> = {
  iterm2: 'iTerm2',
  terminal: 'Terminal (macOS)',
}

// Format inline env vars + command (unix format)
export function formatEnvCommand(envVars: Record<string, string>, command: string): string {
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

// CLI configuration for environment variable injection. Only Claude Code is a
// process-launched client in 3.2.0; desktop clients use config takeover.
export interface ProviderTypeConfig {
  type: string
  label: string
  envKeyName: string
  envBaseUrlName: string
  defaultBaseUrl: string
  cliCommand: string
}

export const PROVIDER_TYPE_CONFIGS: ProviderTypeConfig[] = [
  {
    type: 'claude_code',
    label: 'Claude Code',
    envKeyName: 'ANTHROPIC_AUTH_TOKEN',
    envBaseUrlName: 'ANTHROPIC_BASE_URL',
    defaultBaseUrl: 'https://api.anthropic.com',
    cliCommand: 'claude',
  },
  {
    type: 'grok',
    label: 'Grok Build',
    envKeyName: 'XAI_API_KEY',
    envBaseUrlName: '',
    defaultBaseUrl: 'https://api.x.ai/v1',
    cliCommand: 'grok',
  },
]

// Helper function to get provider type config
export function getProviderTypeConfig(type: string): ProviderTypeConfig {
  const normalized = normalizeClientKind(type)
  const config = PROVIDER_TYPE_CONFIGS.find((c) => c.type === normalized)
  if (!config) {
    return PROVIDER_TYPE_CONFIGS[0]
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
  const clientKind = normalizeClientKind(provider.type)
  if (!isCliClientKind(clientKind)) {
    throw new Error(`${getClientKindLabel(clientKind)} uses config takeover, not terminal launch`)
  }
  const config = getProviderTypeConfig(clientKind)
  if (clientKind === 'grok') {
    const key = useProxy ? 'proxy' : apiKey
    return formatEnvCommand(
      { [useProxy ? 'CC_USE_GROK_TOKEN' : 'XAI_API_KEY']: key },
      useProxy ? 'grok -m cc-use' : 'grok',
    )
  }
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
  httpProxy: string | null
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
}

export interface CreateProviderInput {
  name: string
  baseUrl: string
  httpProxy?: string
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
  types: ClientKind[]
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
  clientConfigs?: Partial<Record<ClientKind, ClientConfig>>
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
  types?: ClientKind[]
  priority?: number
  isActive?: boolean
  config?: CliConfig
  costMultiplier?: number
  usageType?: 'none' | 'newapi' | 'custom'
  usageUrl?: string
  usagePath?: string
  usageHeaders?: string
  modelMapping?: string
  clientConfigs?: Partial<Record<ClientKind, ClientConfig>>
}

export interface UpdateApiKeyInput {
  id: string
  alias?: string
  value?: string
  types?: ClientKind[]
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
  clientConfigs?: Partial<Record<ClientKind, ClientConfig>>
}

// Project types
export interface Project {
  id: string
  name: string
  path: string
  groupName: string | null
  remark: string | null
  providerId: string | null
  apiKeyId: string | null
  cliType: ProviderType // CLI type for launching terminal
  terminalType: TerminalType
  prelaunchCommand: string | null
  lastOpenedAt: string | null
  bindings?: Partial<Record<'claude_code' | 'grok', ProjectClientBinding>>
}

export interface ProjectClientBinding {
  cliType: 'claude_code' | 'grok'
  providerId: string | null
  apiKeyId: string | null
  terminalType: TerminalType
  prelaunchCommand: string | null
}

export interface ProjectClientBindingInput {
  cliType: 'claude_code' | 'grok'
  providerId: string | null
  apiKeyId: string | null
  terminalType?: TerminalType
  prelaunchCommand: string | null
}

export interface CreateProjectInput {
  name: string
  path: string
  groupName?: string
  remark?: string
  providerId?: string
  apiKeyId?: string
  cliType?: ProviderType
  terminalType?: TerminalType
  prelaunchCommand?: string
}

export interface UpdateProjectInput {
  id: string
  name?: string
  groupName?: string
  remark?: string
  providerId?: string
  apiKeyId?: string
  cliType?: ProviderType
  terminalType?: TerminalType
  prelaunchCommand?: string
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
  /// Stable id for one proxied request. Pending and final events with the
  /// same id should be merged by the renderer.
  requestId?: string | null
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
  kind: string
  message?: string | null
  /// Detail-mode fields (only present when detail mode is on).
  requestHeaders?: string[] | null
  requestBody?: string | null
  responseHeaders?: string[] | null
  responseBody?: string | null
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
  prelaunchCommand?: string | null
}

// Global settings types
export interface GlobalSettings {
  defaultProviderType: ProviderType
  proxyPort: number
  defaultTerminalType: TerminalType
  closeToTray: boolean
  daemonEnabled: boolean
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
  httpProxy?: string
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
  includeApiKeys: boolean
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
  tokens: number
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
  totalTokens: number
  weeklyTrend: DailyCostTrendItem[]
  topKeys: TopKeyCostItem[]
  topProjects: TopProjectCostItem[]
}

export interface GatewayMetricsWindow {
  window: 'hour' | 'day' | 'week'
  totalRequests: number
  successfulRequests: number
  upstreamErrors: number
  rejectedRequests: number
  activeProviders: number
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  lastRequestAt: string | null
}

export interface RecentGatewayMetrics {
  windows: GatewayMetricsWindow[]
}

export interface ProviderGatewayMetrics {
  providerName: string
  totalRequests: number
  successfulRequests: number
  upstreamErrors: number
  avgLatencyMs: number | null
  lastRequestAt: string | null
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
