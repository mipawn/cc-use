import { ipcMain, dialog } from 'electron'
import { IPC_CHANNELS } from '@shared/types/ipc'
import * as providerService from '../services/providerService'
import * as apiKeyService from '../services/apiKeyService'
import * as projectService from '../services/projectService'
import * as settingsService from '../services/settingsService'
import * as iconService from '../services/iconService'
import { refreshBalance } from '../services/balanceService'
import { launchTerminal, launchTerminalWithPath } from '../services/terminal'
import { startProxy, stopProxy, getProxyStatus } from '../services/proxy'
import type {
  CreateProviderInput,
  UpdateProviderInput,
  CreateApiKeyInput,
  UpdateApiKeyInput,
  CreateProjectInput,
  UpdateProjectInput,
  GlobalSettings,
} from '@shared/types'

export function registerIpcHandlers() {
  // Provider handlers
  ipcMain.handle(IPC_CHANNELS.PROVIDER_LIST, async () => {
    return providerService.listProviders()
  })

  ipcMain.handle(IPC_CHANNELS.PROVIDER_GET, async (_, id: string) => {
    return providerService.getProvider(id)
  })

  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_CREATE,
    async (_, input: CreateProviderInput) => {
      return providerService.createProvider(input)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_UPDATE,
    async (_, input: UpdateProviderInput) => {
      return providerService.updateProvider(input)
    }
  )

  ipcMain.handle(IPC_CHANNELS.PROVIDER_DELETE, async (_, id: string) => {
    return providerService.deleteProvider(id)
  })

  // API Key handlers
  ipcMain.handle(
    IPC_CHANNELS.API_KEY_LIST,
    async (_, providerId: string) => {
      return apiKeyService.listApiKeys(providerId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.API_KEY_CREATE,
    async (_, input: CreateApiKeyInput) => {
      return apiKeyService.createApiKey(input)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.API_KEY_UPDATE,
    async (_, input: UpdateApiKeyInput) => {
      return apiKeyService.updateApiKey(input)
    }
  )

  ipcMain.handle(IPC_CHANNELS.API_KEY_DELETE, async (_, id: string) => {
    return apiKeyService.deleteApiKey(id)
  })

  ipcMain.handle(
    IPC_CHANNELS.API_KEY_REORDER,
    async (_, providerId: string, keyIds: string[]) => {
      return apiKeyService.reorderApiKeys(providerId, keyIds)
    }
  )

  // Project handlers
  ipcMain.handle(IPC_CHANNELS.PROJECT_LIST, async () => {
    return projectService.listProjects()
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_GET, async (_, id: string) => {
    return projectService.getProject(id)
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_GET_BY_PATH, async (_, path: string) => {
    return projectService.getProjectByPath(path)
  })

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_CREATE,
    async (_, input: CreateProjectInput) => {
      return projectService.createProject(input)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROJECT_UPDATE,
    async (_, input: UpdateProjectInput) => {
      return projectService.updateProject(input)
    }
  )

  ipcMain.handle(IPC_CHANNELS.PROJECT_DELETE, async (_, id: string) => {
    return projectService.deleteProject(id)
  })

  // Terminal handlers
  ipcMain.handle(IPC_CHANNELS.TERMINAL_LAUNCH, async (_, projectId: string) => {
    return launchTerminal(projectId)
  })

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_LAUNCH_WITH_PATH,
    async (_, path: string, providerId?: string) => {
      return launchTerminalWithPath(path, providerId)
    }
  )

  // Balance handler
  ipcMain.handle(IPC_CHANNELS.BALANCE_REFRESH, async (_, providerId: string) => {
    return refreshBalance(providerId)
  })

  // System handlers
  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_PLATFORM, async () => {
    return process.platform
  })

  ipcMain.handle(IPC_CHANNELS.SYSTEM_SELECT_FOLDER, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // Proxy handlers
  ipcMain.handle(IPC_CHANNELS.PROXY_START, async () => {
    return startProxy()
  })

  ipcMain.handle(IPC_CHANNELS.PROXY_STOP, async () => {
    return stopProxy()
  })

  ipcMain.handle(IPC_CHANNELS.PROXY_STATUS, async () => {
    return getProxyStatus()
  })

  // Settings handlers
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async () => {
    return settingsService.getGlobalSettings()
  })

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_UPDATE,
    async (_, updates: Partial<GlobalSettings>) => {
      return settingsService.updateGlobalSettings(updates)
    }
  )

  // Icon handlers
  ipcMain.handle(
    IPC_CHANNELS.ICON_UPLOAD,
    async (_, buffer: Buffer, filename: string) => {
      return iconService.uploadIcon(buffer, filename)
    }
  )

  ipcMain.handle(IPC_CHANNELS.ICON_LIST, async () => {
    return {
      preset: iconService.getPresetIcons(),
      uploaded: iconService.getUploadedIcons(),
    }
  })
}
