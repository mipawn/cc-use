import { create } from 'zustand'
import type { Provider } from '@shared/types'
import { getApi } from '../api'

interface ProviderState {
  providers: Provider[]
  loading: boolean
  error: string | null
  fetchProviders: () => Promise<void>
  upsertProvider: (provider: Provider) => void
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
      const providers = await getApi().provider.list()
      set({ providers, loading: false })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch providers',
        loading: false,
      })
    }
  },

  upsertProvider: (provider) => {
    const existing = get().providers
    const idx = existing.findIndex((p) => p.id === provider.id)
    if (idx === -1) {
      set({ providers: [...existing, provider] })
      return
    }
    set({ providers: existing.map((p) => (p.id === provider.id ? provider : p)) })
  },

  createProvider: async (input) => {
    const provider = await getApi().provider.create(input)
    set({ providers: [...get().providers, provider] })
    return provider
  },

  updateProvider: async (input) => {
    const provider = await getApi().provider.update(input)
    set({
      providers: get().providers.map((p) => (p.id === provider.id ? provider : p)),
    })
    return provider
  },

  deleteProvider: async (id) => {
    await getApi().provider.delete(id)
    set({ providers: get().providers.filter((p) => p.id !== id) })
  },

  refreshBalance: async (id) => {
    const result = await getApi().balance.refresh(id)
    if (result.balance !== null) {
      const provider = await getApi().provider.get(id)
      if (provider) {
        get().upsertProvider(provider)
      }
    }
    return result
  },
}))
