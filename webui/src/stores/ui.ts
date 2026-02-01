import { create } from 'zustand';

export type Language = 'zh' | 'en';

interface UIState {
  language: Language;
  searchText: string;
  filterType: 'all' | 'claude' | 'codex';
  isDrawerOpen: boolean;
  editingProviderId: string | null;
  isAboutOpen: boolean;
  isCommonDrawerOpen: boolean;

  // Actions
  setLanguage: (lang: Language) => void;
  setSearchText: (text: string) => void;
  setFilterType: (type: 'all' | 'claude' | 'codex') => void;
  openDrawer: (providerId?: string | null) => void;
  closeDrawer: () => void;
  setAboutOpen: (open: boolean) => void;
  setCommonDrawerOpen: (open: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  language: 'zh',
  searchText: '',
  filterType: 'all',
  isDrawerOpen: false,
  editingProviderId: null,
  isAboutOpen: false,
  isCommonDrawerOpen: false,

  setLanguage: (language) => set({ language }),
  setSearchText: (searchText) => set({ searchText }),
  setFilterType: (filterType) => set({ filterType }),
  openDrawer: (providerId = null) => set({ isDrawerOpen: true, editingProviderId: providerId }),
  closeDrawer: () => set({ isDrawerOpen: false, editingProviderId: null }),
  setAboutOpen: (isAboutOpen) => set({ isAboutOpen }),
  setCommonDrawerOpen: (isCommonDrawerOpen) => set({ isCommonDrawerOpen }),
}));

// i18n helper
export const t = (zh: string, en: string, lang: Language) => (lang === 'zh' ? zh : en);
