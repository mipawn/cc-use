import { getApi } from '../api'
import { create } from 'zustand'
import { message } from 'antd'
import i18n from '../locales'
import type { GlobalSettings, TerminalType } from '@shared/types'

export type ThemeMode = 'light' | 'dark' | 'system'

interface SettingsState {
  language: string
  themeMode: ThemeMode
  resolvedTheme: 'light' | 'dark'
  globalSettings: GlobalSettings
  setLanguage: (lang: string) => void
  setThemeMode: (mode: ThemeMode) => void
  initSettings: () => void
  fetchGlobalSettings: () => Promise<void>
  updateGlobalSettings: (updates: Partial<GlobalSettings>) => Promise<void>
}

const getSystemTheme = (): 'light' | 'dark' => {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

const resolveTheme = (mode: ThemeMode): 'light' | 'dark' => {
  if (mode === 'system') {
    return getSystemTheme()
  }
  return mode
}

const getDefaultTerminalType = (): TerminalType => {
  const platform = navigator.userAgent.toLowerCase()
  if (platform.includes('win')) return 'cmd'
  return 'iterm2'
}

const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  defaultProviderType: 'claude',
  proxyPort: 12345,
  defaultTerminalType: getDefaultTerminalType(),
  closeToTray: true,
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  language: localStorage.getItem('language') || 'zh',
  themeMode: (localStorage.getItem('themeMode') as ThemeMode) || 'system',
  resolvedTheme: resolveTheme((localStorage.getItem('themeMode') as ThemeMode) || 'system'),
  globalSettings: DEFAULT_GLOBAL_SETTINGS,

  setLanguage: (lang: string) => {
    localStorage.setItem('language', lang)
    i18n.changeLanguage(lang)
    set({ language: lang })
  },

  setThemeMode: (mode: ThemeMode) => {
    localStorage.setItem('themeMode', mode)
    set({ themeMode: mode, resolvedTheme: resolveTheme(mode) })
  },

  initSettings: () => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = () => {
      const { themeMode } = get()
      if (themeMode === 'system') {
        set({ resolvedTheme: getSystemTheme() })
      }
    }
    mediaQuery.addEventListener('change', handleChange)

    const lang = get().language
    i18n.changeLanguage(lang)

    get().fetchGlobalSettings()
  },

  fetchGlobalSettings: async () => {
    try {
      const settings = await getApi().settings.get()
      set({ globalSettings: settings })
    } catch (error) {
      console.error('Failed to fetch global settings:', error)
      message.error(i18n.t('settings.fetchFailed'))
    }
  },

  updateGlobalSettings: async (updates: Partial<GlobalSettings>) => {
    try {
      const settings = await getApi().settings.update(updates)
      set({ globalSettings: settings })
    } catch (error) {
      console.error('Failed to update global settings:', error)
      message.error(i18n.t('settings.updateFailed'))
    }
  },
}))
