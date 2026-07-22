/**
 * Tauri API layer — wraps Tauri invoke() calls into the Api interface shape.
 */
import type { Api } from './types'

let _api: Api | null = null

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import('@tauri-apps/api/core')
  return tauriInvoke<T>(cmd, args)
}

type UnlistenFn = () => void

async function listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  const { listen: tauriListen } = await import('@tauri-apps/api/event')
  const unlisten = await tauriListen<T>(event, (e) => handler(e.payload))
  return unlisten
}

function buildApi(): Api {
  return {
    provider: {
      list: () => invoke('provider_list'),
      get: (id) => invoke('provider_get', { id }),
      create: (input) => invoke('provider_create', { input }),
      update: (input) => invoke('provider_update', { input }),
      delete: (id) => invoke('provider_delete', { id }),
      reorder: (providerIds) => invoke('provider_reorder', { providerIds }),
      modelList: (providerId) => invoke('provider_model_list', { providerId }),
    },
    apiKey: {
      list: (providerId) => invoke('api_key_list', { providerId }),
      create: (input) => invoke('api_key_create', { input }),
      update: (input) => invoke('api_key_update', { input }),
      delete: (id) => invoke('api_key_delete', { id }),
      reorder: (providerId, keyIds) => invoke('api_key_reorder', { providerId, keyIds }),
    },
    project: {
      list: () => invoke('project_list'),
      get: (id) => invoke('project_get', { id }),
      getByPath: (path) => invoke('project_get_by_path', { path }),
      create: (input) => invoke('project_create', { input }),
      update: (input) => invoke('project_update', { input }),
      updateBinding: (projectId, input) => invoke('project_binding_upsert', { projectId, input }),
      delete: (id) => invoke('project_delete', { id }),
      open: (id) => invoke('project_open', { id }),
    },
    terminal: {
      launch: (projectId, options) => invoke('terminal_launch', { projectId, options }),
      launchWithPath: (path) => invoke('terminal_launch_with_path', { path }),
      getLaunchPreview: (params) => invoke('terminal_get_launch_preview', params),
      prepareGrokConfig: (apiKeyId) => invoke('terminal_prepare_grok_config', { apiKeyId }),
    },
    proxy: {
      restart: () => invoke('proxy_restart'),
      status: () => invoke('proxy_status'),
      start: () => invoke('proxy_start'),
      stop: () => invoke('proxy_stop'),
      setDetailMode: (enabled: boolean) => invoke('console_detail_mode_set', { enabled }),
      onStatusChanged: (callback) => {
        let unlisten: UnlistenFn | null = null
        listen<{ isRunning: boolean; port: number; lastError?: string | null; source?: string }>(
          'proxy:statusChanged',
          callback,
        ).then((fn) => {
          unlisten = fn
        })
        return () => {
          unlisten?.()
        }
      },
    },
    console: {
      onEvent: (callback) => {
        let unlisten: UnlistenFn | null = null
        listen<import('../../shared/types').ConsoleEvent>('proxy:consoleEvent', callback).then(
          (fn) => {
            unlisten = fn
          },
        )
        return () => {
          unlisten?.()
        }
      },
    },
    balance: {
      refresh: (providerId) => invoke('balance_refresh', { providerId }),
    },
    usage: {
      refresh: (providerId) => invoke('usage_refresh', { providerId }),
    },
    keyUsage: {
      refresh: (keyId) => invoke('key_usage_refresh', { keyId }),
    },
    importExport: {
      export: () => invoke('export_providers'),
      import: (data, options) => invoke('import_providers', { data, options }),
      validate: (data) => invoke('validate_import_data', { data }),
      exportToFile: (path, options) => invoke('export_to_file', { path, options }),
      importFromFile: (path, options) => invoke('import_from_file', { path, options }),
      checkElectronMigration: () => invoke('check_electron_migration'),
      migrateFromElectron: () => invoke('migrate_from_electron'),
    },
    session: {
      create: (providerId, apiKeyId, cliType) =>
        invoke('session_create', { providerId, apiKeyId, cliType }),
      get: (sessionToken) => invoke('session_get', { sessionToken }),
      updateKey: (sessionToken, apiKeyId) =>
        invoke('session_update_key', { sessionToken, apiKeyId }),
      updateByProject: (projectId, providerId, apiKeyId) =>
        invoke('session_update_by_project', { projectId, providerId, apiKeyId }),
      delete: (sessionToken) => invoke('session_delete', { sessionToken }),
      list: () => invoke('session_list'),
    },
    settings: {
      get: () => invoke('settings_get'),
      update: (updates) => invoke('settings_update', { updates }),
    },
    configTakeover: {
      readCodex: () => invoke('codex_config_read'),
      readClaudeDesktop: () => invoke('claude_desktop_config_read'),
    },
    icon: {
      upload: (buffer, filename) => {
        const arr = Array.from(new Uint8Array(buffer))
        return invoke('icon_upload', { buffer: arr, filename })
      },
      list: () => invoke('icon_list'),
    },
    usageLog: {
      getStats: (timeRange) => invoke('usage_log_get_stats', { timeRange }),
      getRecent: (limit) => invoke('usage_log_get_recent', { limit }),
      getTodayQuickStats: () => invoke('usage_log_today_quick_stats'),
    },
    requestLog: {
      getCostStats: () => invoke('request_log_get_cost_stats'),
      getKeyCosts: () => invoke('request_log_get_key_costs'),
      getDailyTrend: (days) => invoke('request_log_get_daily_trend', { days }),
      getCostStatistics: (timeRange) => invoke('request_log_get_cost_statistics', { timeRange }),
      getRecentPaginated: (timeRange, page, pageSize) =>
        invoke('request_log_get_recent_paginated', { timeRange, page, pageSize }),
      getDashboardStats: () => invoke('request_log_get_dashboard_stats'),
      getGatewayMetrics: () => invoke('gateway_metrics_get_recent'),
      getProviderGatewayMetrics: () => invoke('gateway_metrics_get_by_provider'),
      getMonthlyTrend: (year: number, month: number) =>
        invoke('request_log_get_monthly_trend', { year, month }),
      repairCosts: () => invoke('request_log_repair_costs'),
    },
    modelPricing: {
      getAll: () => invoke('model_pricing_get_all'),
      getCustom: () => invoke('model_pricing_get_custom'),
      updateCustom: (pricing) => invoke('model_pricing_update_custom', { pricing }),
      getDefault: () => invoke('model_pricing_get_default'),
    },
    app: {
      getVersion: () => invoke('app_get_version'),
      checkUpdate: async () => {
        const { check } = await import('@tauri-apps/plugin-updater')
        const update = await check()
        if (!update) return { available: false }
        return {
          available: true,
          version: update.version,
          body: update.body,
          date: update.date,
        }
      },
      downloadAndInstall: async (onProgress) => {
        const { check } = await import('@tauri-apps/plugin-updater')
        const update = await check()
        if (!update) throw new Error('No update available')
        let downloaded = 0
        let total = 0
        await update.downloadAndInstall((e) => {
          if (e.event === 'Started') {
            total = e.data.contentLength ?? 0
            if (onProgress) onProgress({ downloaded: 0, total })
          } else if (e.event === 'Progress') {
            downloaded += e.data.chunkLength
            if (onProgress) onProgress({ downloaded, total })
          }
        })
      },
      relaunch: async () => {
        const { relaunch } = await import('@tauri-apps/plugin-process')
        await relaunch()
      },
    },
    system: {
      getPlatform: () => invoke('system_get_platform'),
      selectFolder: async () => {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const result = await open({ directory: true })
        return result as string | null
      },
      openExternal: async (url) => {
        const { openUrl } = await import('@tauri-apps/plugin-opener')
        await openUrl(url)
      },
    },
    sessions: {
      scanSessions: () => invoke('scan_sessions'),
      deleteSessions: (sessionIds) => invoke('delete_sessions', { sessionIds }),
      cleanOldSessions: (days) => invoke('clean_old_sessions', { days }),
      keepRecentSessions: (keepCount) => invoke('keep_recent_sessions', { keepCount }),
    },
    managedInstances: {
      list: () => invoke('managed_instance_list'),
      get: (id) => invoke('managed_instance_get', { id }),
      updateAssignment: (input) => invoke('managed_instance_update_assignment', { input }),
      cleanup: (cliType) => invoke('managed_instance_cleanup', { cliType }),
    },
    systemExt: {
      autoLaunchIsEnabled: () => invoke('auto_launch_is_enabled'),
      autoLaunchSetEnabled: (enabled) => invoke('auto_launch_set_enabled', { enabled }),
      showWindowGetShortcut: () => invoke('show_window_get_shortcut'),
      showWindowSetShortcut: (combo) => invoke('show_window_set_shortcut', { combo }),
    },
    codexApp: {
      launch: (projectId: string) => invoke('codex_app_launch', { projectId }),
      stop: () => invoke('codex_app_stop'),
      getActiveProject: () => invoke<string | null>('codex_app_get_active_project'),
    },
  }
}

/**
 * Get the API object. Cached after first call.
 */
export function getApi(): Api {
  if (!_api) {
    _api = buildApi()
  }
  return _api
}
