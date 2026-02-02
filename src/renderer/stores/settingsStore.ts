import { create } from 'zustand'
import i18n from '../locales'

export type ThemeMode = 'light' | 'dark' | 'system'

interface SettingsState {
  language: string
  themeMode: ThemeMode
  resolvedTheme: 'light' | 'dark'
  setLanguage: (lang: string) => void
  setThemeMode: (mode: ThemeMode) => void
  initSettings: () => void
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

export const useSettingsStore = create<SettingsState>((set, get) => ({
  language: localStorage.getItem('language') || 'zh', // 默认中文
  themeMode: (localStorage.getItem('themeMode') as ThemeMode) || 'system',
  resolvedTheme: resolveTheme((localStorage.getItem('themeMode') as ThemeMode) || 'system'),

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

    // Initialize language
    const lang = get().language
    i18n.changeLanguage(lang)
  },
}))
