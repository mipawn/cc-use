// IPC Channel definitions
export const IPC_CHANNELS = {
  // Provider channels
  PROVIDER_LIST: 'provider:list',
  PROVIDER_GET: 'provider:get',
  PROVIDER_CREATE: 'provider:create',
  PROVIDER_UPDATE: 'provider:update',
  PROVIDER_DELETE: 'provider:delete',

  // API Key channels
  API_KEY_LIST: 'apiKey:list',
  API_KEY_CREATE: 'apiKey:create',
  API_KEY_UPDATE: 'apiKey:update',
  API_KEY_DELETE: 'apiKey:delete',
  API_KEY_REORDER: 'apiKey:reorder',

  // Project channels
  PROJECT_LIST: 'project:list',
  PROJECT_GET: 'project:get',
  PROJECT_GET_BY_PATH: 'project:getByPath',
  PROJECT_CREATE: 'project:create',
  PROJECT_UPDATE: 'project:update',
  PROJECT_DELETE: 'project:delete',
  PROJECT_OPEN: 'project:open',

  // Terminal channels
  TERMINAL_LAUNCH: 'terminal:launch',
  TERMINAL_LAUNCH_WITH_PATH: 'terminal:launchWithPath',

  // Proxy channels
  PROXY_START: 'proxy:start',
  PROXY_STOP: 'proxy:stop',
  PROXY_STATUS: 'proxy:status',

  // Balance channels
  BALANCE_REFRESH: 'balance:refresh',

  // Usage channels
  USAGE_REFRESH: 'usage:refresh',

  // Key usage channels
  KEY_USAGE_REFRESH: 'keyUsage:refresh',

  // Import/Export channels
  EXPORT_PROVIDERS: 'export:providers',
  IMPORT_PROVIDERS: 'import:providers',
  VALIDATE_IMPORT_DATA: 'import:validate',

  // Session channels (for proxy hot-switching)
  SESSION_CREATE: 'session:create',
  SESSION_GET: 'session:get',
  SESSION_UPDATE_KEY: 'session:updateKey',
  SESSION_DELETE: 'session:delete',
  SESSION_LIST: 'session:list',

  // Settings channels
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',

  // Icon channels
  ICON_UPLOAD: 'icon:upload',
  ICON_LIST: 'icon:list',

  // Usage log channels (statistics)
  USAGE_LOG_GET_STATS: 'usageLog:getStats',
  USAGE_LOG_GET_RECENT: 'usageLog:getRecent',
  USAGE_LOG_TODAY_QUICK_STATS: 'usageLog:todayQuickStats',

  // Request log channels (cost tracking)
  REQUEST_LOG_GET_COST_STATS: 'requestLog:getCostStats',
  REQUEST_LOG_GET_KEY_COSTS: 'requestLog:getKeyCosts',
  REQUEST_LOG_GET_DAILY_TREND: 'requestLog:getDailyTrend',

  // System channels
  SYSTEM_GET_PLATFORM: 'system:getPlatform',
  SYSTEM_SELECT_FOLDER: 'system:selectFolder',
  SYSTEM_OPEN_EXTERNAL: 'system:openExternal',
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
