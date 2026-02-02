import { create } from 'zustand'
import type { ApiKey } from '@shared/types'

interface ApiKeyState {
  apiKeys: Record<string, ApiKey[]>
  loading: Record<string, boolean>
  fetchApiKeys: (providerId: string) => Promise<void>
  createApiKey: (input: Parameters<typeof window.api.apiKey.create>[0]) => Promise<ApiKey>
  updateApiKey: (input: Parameters<typeof window.api.apiKey.update>[0]) => Promise<ApiKey>
  deleteApiKey: (providerId: string, id: string) => Promise<void>
  reorderApiKeys: (providerId: string, keyIds: string[]) => Promise<void>
}

export const useApiKeyStore = create<ApiKeyState>((set, get) => ({
  apiKeys: {},
  loading: {},

  fetchApiKeys: async (providerId) => {
    set({ loading: { ...get().loading, [providerId]: true } })
    try {
      const keys = await window.api.apiKey.list(providerId)
      set({
        apiKeys: { ...get().apiKeys, [providerId]: keys },
        loading: { ...get().loading, [providerId]: false },
      })
    } catch (error) {
      set({ loading: { ...get().loading, [providerId]: false } })
      throw error
    }
  },

  createApiKey: async (input) => {
    const apiKey = await window.api.apiKey.create(input)
    const currentKeys = get().apiKeys[input.providerId] || []
    set({
      apiKeys: {
        ...get().apiKeys,
        [input.providerId]: [...currentKeys, apiKey],
      },
    })
    return apiKey
  },

  updateApiKey: async (input) => {
    const apiKey = await window.api.apiKey.update(input)
    const providerId = apiKey.providerId
    set({
      apiKeys: {
        ...get().apiKeys,
        [providerId]: get().apiKeys[providerId].map((k) =>
          k.id === apiKey.id ? apiKey : k
        ),
      },
    })
    return apiKey
  },

  deleteApiKey: async (providerId, id) => {
    await window.api.apiKey.delete(id)
    set({
      apiKeys: {
        ...get().apiKeys,
        [providerId]: get().apiKeys[providerId].filter((k) => k.id !== id),
      },
    })
  },

  reorderApiKeys: async (providerId, keyIds) => {
    const keys = await window.api.apiKey.reorder(providerId, keyIds)
    set({
      apiKeys: {
        ...get().apiKeys,
        [providerId]: keys,
      },
    })
  },
}))
