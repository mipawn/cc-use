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

  // System channels
  SYSTEM_GET_PLATFORM: 'system:getPlatform',
  SYSTEM_SELECT_FOLDER: 'system:selectFolder',
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
