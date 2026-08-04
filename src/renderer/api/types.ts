/**
 * Api type definition — describes the shape of the API layer.
 * Previously derived from the Electron preload (typeof api).
 * Now standalone for Tauri-only usage.
 */
import type {
  Provider,
  CreateProviderInput,
  UpdateProviderInput,
  ApiKey,
  CreateApiKeyInput,
  UpdateApiKeyInput,
  Project,
  CreateProjectInput,
  UpdateProjectInput,
  GlobalSettings,
  PresetIcon,
  UsageData,
  ExportData,
  ExportOptions,
  ImportOptions,
  ImportResult,
  ProxySession,
  ProxyStatus,
  ConsoleEvent,
  ManagedInstance,
  UpdateManagedInstanceAssignmentInput,
  UsageStats,
  UsageLog,
  StatsTimeRange,
  UsageStatistics,
  UsageOverview,
  DailyTrendItem,
  CliToolStatus,
  StatuslineState,
  StatuslineEnableResult,
  PaginatedRecentRequests,
  RecentGatewayMetrics,
  ProviderGatewayMetrics,
  MigrationCheck,
  MigrationResult,
  TerminalLaunchPreview,
  ClientKind,
} from '../../shared/types'

export interface Api {
  provider: {
    list: () => Promise<Provider[]>
    get: (id: string) => Promise<Provider | null>
    create: (input: CreateProviderInput) => Promise<Provider>
    update: (input: UpdateProviderInput) => Promise<Provider>
    delete: (id: string) => Promise<void>
    reorder: (providerIds: string[]) => Promise<Provider[]>
    modelList: (providerId: string, apiKeyId: string) => Promise<string[]>
  }
  apiKey: {
    list: (providerId: string) => Promise<ApiKey[]>
    create: (input: CreateApiKeyInput) => Promise<ApiKey>
    update: (input: UpdateApiKeyInput) => Promise<ApiKey>
    delete: (id: string) => Promise<void>
    reorder: (providerId: string, keyIds: string[]) => Promise<ApiKey[]>
  }
  project: {
    list: () => Promise<Project[]>
    get: (id: string) => Promise<Project | null>
    getByPath: (path: string) => Promise<Project | null>
    create: (input: CreateProjectInput) => Promise<Project>
    update: (input: UpdateProjectInput) => Promise<Project>
    updateBinding: (
      projectId: string,
      input: import('../../shared/types').ProjectClientBindingInput,
    ) => Promise<Project>
    delete: (id: string) => Promise<void>
    open: (id: string) => Promise<void>
  }
  terminal: {
    launch: (
      projectId: string,
      options?: { providerId?: string; apiKeyId?: string; cliType?: ClientKind },
    ) => Promise<void>
    launchWithPath: (path: string) => Promise<void>
    getLaunchPreview: (params: {
      projectId?: string
      providerId?: string
      apiKeyId?: string
      cliType: ClientKind | 'claude'
    }) => Promise<TerminalLaunchPreview>
    prepareGrokConfig: (apiKeyId: string) => Promise<void>
  }
  proxy: {
    restart: () => Promise<void>
    status: () => Promise<ProxyStatus>
    start: () => Promise<void>
    stop: () => Promise<void>
    setDetailMode: (enabled: boolean) => Promise<void>
    onStatusChanged: (
      callback: (data: {
        isRunning: boolean
        port: number
        lastError?: string | null
        source?: string
      }) => void,
    ) => () => void
  }
  console: {
    /// Subscribe to the realtime console stream. Emits proxy request events,
    /// daemon/app Rust log records, and renderer `console.*` calls through a
    /// single channel. Returns an unlisten fn.
    onEvent: (callback: (event: ConsoleEvent) => void) => () => void
  }
  balance: {
    refresh: (providerId: string) => Promise<{
      balance: number | null
      total: number | null
      used: number | null
      unlimited: boolean
      error: string | null
    }>
  }
  usage: {
    refresh: (providerId: string) => Promise<{ usage: UsageData | null; error: string | null }>
  }
  keyUsage: {
    refresh: (keyId: string) => Promise<{ usage: UsageData | null; error: string | null }>
  }
  importExport: {
    export: () => Promise<ExportData>
    import: (data: ExportData, options?: ImportOptions) => Promise<ImportResult>
    validate: (data: unknown) => Promise<boolean>
    exportToFile: (path: string, options?: ExportOptions) => Promise<void>
    importFromFile: (path: string, options?: ImportOptions) => Promise<ImportResult>
    checkElectronMigration: () => Promise<MigrationCheck>
    migrateFromElectron: () => Promise<MigrationResult>
  }
  session: {
    create: (providerId: string, apiKeyId: string, cliType?: ClientKind) => Promise<ProxySession>
    get: (sessionToken: string) => Promise<ProxySession | null>
    updateKey: (sessionToken: string, apiKeyId: string) => Promise<boolean>
    updateByProject: (projectId: string, providerId: string, apiKeyId: string) => Promise<void>
    delete: (sessionToken: string) => Promise<boolean>
    list: () => Promise<ProxySession[]>
  }
  settings: {
    get: () => Promise<GlobalSettings>
    update: (updates: Partial<GlobalSettings>) => Promise<GlobalSettings>
  }
  configTakeover: {
    readCodex: () => Promise<string>
    readClaudeDesktop: () => Promise<string>
  }
  icon: {
    upload: (buffer: ArrayBuffer, filename: string) => Promise<string>
    list: () => Promise<{ preset: PresetIcon[]; uploaded: string[] }>
  }
  usageLog: {
    getStats: (timeRange: StatsTimeRange) => Promise<UsageStats>
    getRecent: (limit?: number) => Promise<UsageLog[]>
    getTodayQuickStats: () => Promise<{
      launches: number
      uniqueProjects: number
      uniqueKeys: number
    }>
  }
  requestLog: {
    getDailyTrend: (days?: number) => Promise<DailyTrendItem[]>
    getStatistics: (timeRange: StatsTimeRange) => Promise<UsageStatistics>
    getRecentPaginated: (
      timeRange: StatsTimeRange,
      page?: number,
      pageSize?: number,
    ) => Promise<PaginatedRecentRequests>
    getOverview: () => Promise<UsageOverview>
    getKeyTokenStats: () => Promise<{ keyId: string; todayTokens: number; totalTokens: number }[]>
    getGatewayMetrics: () => Promise<RecentGatewayMetrics>
    getProviderGatewayMetrics: () => Promise<ProviderGatewayMetrics[]>
    getMonthlyTrend: (year: number, month: number) => Promise<DailyTrendItem[]>
  }
  cliTool: {
    status: () => Promise<CliToolStatus>
    install: () => Promise<CliToolStatus>
    uninstall: () => Promise<CliToolStatus>
    statuslineStatus: () => Promise<StatuslineState>
    statuslineEnable: (force?: boolean) => Promise<StatuslineEnableResult>
    statuslineRestore: () => Promise<boolean>
  }
  app: {
    getVersion: () => Promise<string>
    checkUpdate: () => Promise<{
      available: boolean
      version?: string
      body?: string
      date?: string
    }>
    downloadAndInstall: (
      onProgress?: (progress: { downloaded: number; total: number }) => void,
    ) => Promise<void>
    relaunch: () => Promise<void>
  }
  system: {
    getPlatform: () => Promise<string>
    selectFolder: () => Promise<string | null>
    openExternal: (url: string) => Promise<void>
  }
  systemExt: {
    autoLaunchIsEnabled: () => Promise<boolean>
    autoLaunchSetEnabled: (enabled: boolean) => Promise<boolean>
    showWindowGetShortcut: () => Promise<string>
    showWindowSetShortcut: (combo: string) => Promise<string>
  }
  sessions: {
    scanSessions: () => Promise<ClaudeSession[]>
    deleteSessions: (sessionIds: string[]) => Promise<number>
    cleanOldSessions: (days: number) => Promise<number>
    keepRecentSessions: (keepCount: number) => Promise<number>
  }
  managedInstances: {
    list: (cliType?: 'claude_code' | 'grok') => Promise<ManagedInstance[]>
    get: (id: string) => Promise<ManagedInstance | null>
    updateAssignment: (input: UpdateManagedInstanceAssignmentInput) => Promise<ManagedInstance>
    cleanup: (cliType: 'claude_code' | 'grok') => Promise<number>
  }
  codexApp: {
    launch: (projectId: string) => Promise<string>
    stop: () => Promise<void>
    getActiveProject: () => Promise<string | null>
  }
}

export interface ClaudeSession {
  sessionId: string
  projectPath: string
  jsonlSize: number
  dirSize: number
  totalSize: number
  lastModified: number
  messageCount: number
  firstMessage?: string
}
