import { create } from 'zustand'
import type { Provider } from '@shared/types'

interface ProviderState {
  providers: Provider[]
  loading: boolean
  error: string | null
  fetchProviders: () => Promise<void>
  createProvider: (input: Parameters<typeof window.api.provider.create>[0]) => Promise<Provider>
  updateProvider: (input: Parameters<typeof window.api.provider.update>[0]) => Promise<Provider>
  deleteProvider: (id: string) => Promise<void>
  refreshBalance: (
    id: string,
  ) => Promise<{
    balance: number | null
    total: number | null
    used: number | null
    unlimited: boolean
    error: string | null
  }>
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  providers: [],
  loading: false,
  error: null,

  fetchProviders: async () => {
    set({ loading: true, error: null })
    try {
      const providers = await window.api.provider.list()
      set({ providers, loading: false })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch providers',
        loading: false,
      })
    }
  },

  createProvider: async (input) => {
    const provider = await window.api.provider.create(input)
    set({ providers: [...get().providers, provider] })
    return provider
  },

  updateProvider: async (input) => {
    const provider = await window.api.provider.update(input)
    set({
      providers: get().providers.map((p) => (p.id === provider.id ? provider : p)),
    })
    return provider
  },

  deleteProvider: async (id) => {
    await window.api.provider.delete(id)
    set({ providers: get().providers.filter((p) => p.id !== id) })
  },

  refreshBalance: async (id) => {
    const result = await window.api.balance.refresh(id)
    if (result.balance !== null) {
      const provider = await window.api.provider.get(id)
      if (provider) {
        set({
          providers: get().providers.map((p) => (p.id === id ? provider : p)),
        })
      }
    }
    return result
  },
}))
