import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/types/ipc'
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
  ImportOptions,
  ImportResult,
  ProxySession,
  UsageStats,
  UsageLog,
  StatsTimeRange,
} from '../shared/types'

const api = {
  // Provider API
  provider: {
    list: (): Promise<Provider[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_LIST),
    get: (id: string): Promise<Provider | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_GET, id),
    create: (input: CreateProviderInput): Promise<Provider> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_CREATE, input),
    update: (input: UpdateProviderInput): Promise<Provider> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_UPDATE, input),
    delete: (id: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_DELETE, id),
  },

  // API Key API
  apiKey: {
    list: (providerId: string): Promise<ApiKey[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.API_KEY_LIST, providerId),
    create: (input: CreateApiKeyInput): Promise<ApiKey> =>
      ipcRenderer.invoke(IPC_CHANNELS.API_KEY_CREATE, input),
    update: (input: UpdateApiKeyInput): Promise<ApiKey> =>
      ipcRenderer.invoke(IPC_CHANNELS.API_KEY_UPDATE, input),
    delete: (id: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.API_KEY_DELETE, id),
    reorder: (providerId: string, keyIds: string[]): Promise<ApiKey[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.API_KEY_REORDER, providerId, keyIds),
  },

  // Project API
  project: {
    list: (): Promise<Project[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST),
    get: (id: string): Promise<Project | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_GET, id),
    getByPath: (path: string): Promise<Project | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_GET_BY_PATH, path),
    create: (input: CreateProjectInput): Promise<Project> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE, input),
    update: (input: UpdateProjectInput): Promise<Project> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPDATE, input),
    delete: (id: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_DELETE, id),
    open: (id: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_OPEN, id),
  },

  // Terminal API
  terminal: {
    launch: (projectId: string, options?: { providerId?: string; apiKeyId?: string }): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_LAUNCH, projectId, options),
    launchWithPath: (path: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_LAUNCH_WITH_PATH, path),
  },

  // Proxy API
  proxy: {
    start: (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROXY_START),
    stop: (): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROXY_STOP),
    status: (): Promise<{ isRunning: boolean; port: number }> =>
      ipcRenderer.invoke(IPC_CHANNELS.PROXY_STATUS),
  },

  // Balance API
  balance: {
    refresh: (providerId: string): Promise<{ balance: number | null; total: number | null; used: number | null; unlimited: boolean; error: string | null }> =>
      ipcRenderer.invoke(IPC_CHANNELS.BALANCE_REFRESH, providerId),
  },

  // Usage API
  usage: {
    refresh: (providerId: string): Promise<{ usage: UsageData | null; error: string | null }> =>
      ipcRenderer.invoke(IPC_CHANNELS.USAGE_REFRESH, providerId),
  },

  // Key Usage API
  keyUsage: {
    refresh: (keyId: string): Promise<{ usage: UsageData | null; error: string | null }> =>
      ipcRenderer.invoke(IPC_CHANNELS.KEY_USAGE_REFRESH, keyId),
  },

  // Import/Export API
  importExport: {
    export: (): Promise<ExportData> =>
      ipcRenderer.invoke(IPC_CHANNELS.EXPORT_PROVIDERS),
    import: (data: ExportData, options?: ImportOptions): Promise<ImportResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.IMPORT_PROVIDERS, data, options),
    validate: (data: unknown): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.VALIDATE_IMPORT_DATA, data),
  },

  // Session API (for proxy hot-switching)
  session: {
    create: (providerId: string, apiKeyId: string): Promise<ProxySession> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_CREATE, providerId, apiKeyId),
    get: (sessionToken: string): Promise<ProxySession | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET, sessionToken),
    updateKey: (sessionToken: string, apiKeyId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_UPDATE_KEY, sessionToken, apiKeyId),
    delete: (sessionToken: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE, sessionToken),
    list: (): Promise<ProxySession[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST),
  },

  // Settings API
  settings: {
    get: (): Promise<GlobalSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET),
    update: (updates: Partial<GlobalSettings>): Promise<GlobalSettings> =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_UPDATE, updates),
  },

  // Icon API
  icon: {
    upload: (buffer: ArrayBuffer, filename: string): Promise<string> =>
      ipcRenderer.invoke(IPC_CHANNELS.ICON_UPLOAD, Buffer.from(buffer), filename),
    list: (): Promise<{ preset: PresetIcon[]; uploaded: string[] }> =>
      ipcRenderer.invoke(IPC_CHANNELS.ICON_LIST),
  },

  // Usage Log API (statistics)
  usageLog: {
    getStats: (timeRange: StatsTimeRange): Promise<UsageStats> =>
      ipcRenderer.invoke(IPC_CHANNELS.USAGE_LOG_GET_STATS, timeRange),
    getRecent: (limit?: number): Promise<UsageLog[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.USAGE_LOG_GET_RECENT, limit),
    getTodayQuickStats: (): Promise<{ launches: number; uniqueProjects: number; uniqueKeys: number }> =>
      ipcRenderer.invoke(IPC_CHANNELS.USAGE_LOG_TODAY_QUICK_STATS),
  },

  // Request Log API (cost tracking)
  requestLog: {
    getCostStats: (): Promise<{ todayCost: number; totalBalance: number }> =>
      ipcRenderer.invoke(IPC_CHANNELS.REQUEST_LOG_GET_COST_STATS),
    getKeyCosts: (): Promise<{ keyId: string; todayCost: number; totalCost: number }[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.REQUEST_LOG_GET_KEY_COSTS),
    getDailyTrend: (days?: number): Promise<{ date: string; cost: number; requests: number }[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.REQUEST_LOG_GET_DAILY_TREND, days),
  },

  // System API
  system: {
    getPlatform: (): Promise<NodeJS.Platform> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_GET_PLATFORM),
    selectFolder: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_SELECT_FOLDER),
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL, url),
  },
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
