import { ipcMain, dialog, shell } from 'electron'
import { IPC_CHANNELS } from '@shared/types/ipc'
import * as providerService from '../services/providerService'
import * as apiKeyService from '../services/apiKeyService'
import * as projectService from '../services/projectService'
import * as settingsService from '../services/settingsService'
import * as iconService from '../services/iconService'
import * as importExportService from '../services/importExportService'
import * as usageLogService from '../services/usageLogService'
import * as requestLogService from '../services/requestLogService'
import { refreshBalance } from '../services/balanceService'
import { refreshUsage } from '../services/usageService'
import { refreshKeyUsage } from '../services/keyUsageService'
import * as sessionManager from '../services/proxy/sessionManager'
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
  ExportData,
  ImportOptions,
  StatsTimeRange,
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
      const result = await projectService.updateProject(input)

      // Hot-switch: if provider or apiKey changed, update active sessions
      if ((input.providerId !== undefined || input.apiKeyId !== undefined) && result.providerId && result.apiKeyId) {
        sessionManager.updateSessionsByProject(input.id, result.providerId, result.apiKeyId)
      }

      return result
    }
  )

  ipcMain.handle(IPC_CHANNELS.PROJECT_DELETE, async (_, id: string) => {
    return projectService.deleteProject(id)
  })

  // Terminal handlers
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_LAUNCH,
    async (_, projectId: string, options?: { providerId?: string; apiKeyId?: string }) => {
      return launchTerminal(projectId, options)
    }
  )

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

  // Usage handler
  ipcMain.handle(IPC_CHANNELS.USAGE_REFRESH, async (_, providerId: string) => {
    return refreshUsage(providerId)
  })

  // Key usage handler
  ipcMain.handle(IPC_CHANNELS.KEY_USAGE_REFRESH, async (_, keyId: string) => {
    return refreshKeyUsage(keyId)
  })

  // Import/Export handlers
  ipcMain.handle(IPC_CHANNELS.EXPORT_PROVIDERS, async () => {
    return importExportService.exportProviders()
  })

  ipcMain.handle(
    IPC_CHANNELS.IMPORT_PROVIDERS,
    async (_, data: ExportData, options?: ImportOptions) => {
      return importExportService.importProviders(data, options)
    }
  )

  ipcMain.handle(IPC_CHANNELS.VALIDATE_IMPORT_DATA, async (_, data: unknown) => {
    return importExportService.validateExportData(data)
  })

  // Session handlers
  ipcMain.handle(
    IPC_CHANNELS.SESSION_CREATE,
    async (_, providerId: string, apiKeyId: string) => {
      return sessionManager.createSession(providerId, apiKeyId)
    }
  )

  ipcMain.handle(IPC_CHANNELS.SESSION_GET, async (_, sessionToken: string) => {
    return sessionManager.getSession(sessionToken)
  })

  ipcMain.handle(
    IPC_CHANNELS.SESSION_UPDATE_KEY,
    async (_, sessionToken: string, apiKeyId: string) => {
      return sessionManager.updateSessionKey(sessionToken, apiKeyId)
    }
  )

  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_, sessionToken: string) => {
    return sessionManager.deleteSession(sessionToken)
  })

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
    return sessionManager.listSessions()
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

  ipcMain.handle(IPC_CHANNELS.SYSTEM_OPEN_EXTERNAL, async (_, url: string) => {
    return shell.openExternal(url)
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

  // Usage log handlers
  ipcMain.handle(
    IPC_CHANNELS.USAGE_LOG_GET_STATS,
    async (_, timeRange: StatsTimeRange) => {
      return usageLogService.getUsageStats(timeRange)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.USAGE_LOG_GET_RECENT,
    async (_, limit?: number) => {
      return usageLogService.getRecentUsageLogs(limit)
    }
  )

  ipcMain.handle(IPC_CHANNELS.USAGE_LOG_TODAY_QUICK_STATS, async () => {
    return usageLogService.getTodayQuickStats()
  })

  // Request log handlers (cost tracking)
  ipcMain.handle(IPC_CHANNELS.REQUEST_LOG_GET_COST_STATS, async () => {
    const todayCost = await requestLogService.getTodayCost()
    // Total balance is calculated from providers in the frontend
    return { todayCost, totalBalance: 0 }
  })

  ipcMain.handle(IPC_CHANNELS.REQUEST_LOG_GET_KEY_COSTS, async () => {
    return requestLogService.getAllKeysCostStats()
  })

  ipcMain.handle(IPC_CHANNELS.REQUEST_LOG_GET_DAILY_TREND, async (_, days?: number) => {
    return requestLogService.getDailyCostTrend(days || 7)
  })
}
