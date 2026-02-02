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
    launch: (projectId: string): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_LAUNCH, projectId),
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
    refresh: (providerId: string): Promise<{ balance: number | null; error: string | null }> =>
      ipcRenderer.invoke(IPC_CHANNELS.BALANCE_REFRESH, providerId),
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

  // System API
  system: {
    getPlatform: (): Promise<NodeJS.Platform> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_GET_PLATFORM),
    selectFolder: (): Promise<string | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_SELECT_FOLDER),
  },
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
