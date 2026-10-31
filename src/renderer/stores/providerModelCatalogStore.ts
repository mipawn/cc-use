import { create } from 'zustand'
import type { ClientModel, ProviderModelCatalog } from '@shared/types'
import { getApi } from '../api'

interface CatalogState {
  catalogs: Record<string, ProviderModelCatalog>
  loading: Record<string, boolean>
  errors: Record<string, string | null>
  requests: Record<string, number>
  fetchCatalog: (providerId: string) => Promise<ProviderModelCatalog>
  saveCatalog: (
    providerId: string,
    models: ClientModel[],
    revision: number,
  ) => Promise<ProviderModelCatalog>
}

/** Saved snapshots only. Query candidates and editor selections stay local. */
export const useProviderModelCatalogStore = create<CatalogState>((set, get) => {
  const begin = (id: string) => {
    const request = (get().requests[id] ?? 0) + 1
    set((state) => ({
      requests: { ...state.requests, [id]: request },
      loading: { ...state.loading, [id]: true },
      errors: { ...state.errors, [id]: null },
    }))
    return request
  }
  const run = async (id: string, action: () => Promise<ProviderModelCatalog>) => {
    const request = begin(id)
    try {
      const catalog = await action()
      set((state) => ({
        // A later-started read may still return the version preceding an
        // in-flight save. Compare persisted revisions as well as request order.
        catalogs:
          catalog.revision >= (state.catalogs[id]?.revision ?? -1)
            ? { ...state.catalogs, [id]: catalog }
            : state.catalogs,
        loading: state.requests[id] === request ? { ...state.loading, [id]: false } : state.loading,
      }))
      return catalog
    } catch (error) {
      if (get().requests[id] === request) {
        set((state) => ({
          loading: { ...state.loading, [id]: false },
          errors: { ...state.errors, [id]: String(error) },
        }))
      }
      throw error
    }
  }
  return {
    catalogs: {},
    loading: {},
    errors: {},
    requests: {},
    fetchCatalog: (providerId) =>
      run(providerId, () => getApi().provider.getModelCatalog(providerId)),
    saveCatalog: (providerId, models, revision) =>
      run(providerId, () => getApi().provider.saveModelCatalog(providerId, models, revision)),
  }
})
