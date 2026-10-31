import { beforeEach, expect, it, vi } from 'vitest'
import { useProviderModelCatalogStore as store } from './providerModelCatalogStore'

const api = vi.hoisted(() => ({ getModelCatalog: vi.fn(), saveModelCatalog: vi.fn() }))
vi.mock('../api', () => ({ getApi: () => ({ provider: api }) }))

beforeEach(() => {
  vi.clearAllMocks()
  store.setState({ catalogs: {}, loading: {}, errors: {}, requests: {} })
})

it('publishes only explicit saves and isolates provider snapshots', async () => {
  const saved = { models: [{ id: 'a', displayName: 'A' }], revision: 2, updatedAt: null }
  api.getModelCatalog.mockResolvedValue({ models: [], revision: 0, updatedAt: null })
  api.saveModelCatalog.mockResolvedValue(saved)
  await store.getState().fetchCatalog('p2')
  await store.getState().saveCatalog('p1', saved.models, 1)
  expect(api.saveModelCatalog).toHaveBeenCalledWith('p1', saved.models, 1)
  expect(store.getState().catalogs.p1).toEqual(saved)
  expect(store.getState().catalogs.p2.models).toEqual([])
})

it('does not let a late read overwrite a newer explicit save', async () => {
  let resolveRead!: (value: { models: never[]; revision: number; updatedAt: null }) => void
  api.getModelCatalog.mockReturnValue(
    new Promise((resolve) => {
      resolveRead = resolve
    }),
  )
  const read = store.getState().fetchCatalog('p1')
  const saved = { models: [{ id: 'a', displayName: 'A' }], revision: 2, updatedAt: null }
  api.saveModelCatalog.mockResolvedValue(saved)
  await store.getState().saveCatalog('p1', saved.models, 1)
  resolveRead({ models: [], revision: 1, updatedAt: null })
  await read
  expect(store.getState().catalogs.p1).toEqual(saved)
})

it('preserves saved models when a read or concurrent save fails', async () => {
  const saved = { models: [{ id: 'a', displayName: 'A' }], revision: 2, updatedAt: null }
  store.setState({ catalogs: { p1: saved } })
  api.getModelCatalog.mockRejectedValue('offline')
  await expect(store.getState().fetchCatalog('p1')).rejects.toBe('offline')
  expect(store.getState().catalogs.p1).toEqual(saved)
  api.saveModelCatalog.mockRejectedValue('catalog revision conflict')
  await expect(store.getState().saveCatalog('p1', [], 1)).rejects.toBe('catalog revision conflict')
  expect(store.getState().catalogs.p1).toEqual(saved)
  expect(store.getState().errors.p1).toBe('catalog revision conflict')
})

it('publishes a newer saved revision even when a later-started read finished first', async () => {
  const saved = { models: [{ id: 'a', displayName: 'A' }], revision: 2, updatedAt: null }
  let resolveSave!: (value: typeof saved) => void
  api.saveModelCatalog.mockReturnValue(
    new Promise((resolve) => {
      resolveSave = resolve
    }),
  )
  const save = store.getState().saveCatalog('p1', saved.models, 1)
  api.getModelCatalog.mockResolvedValue({ models: [], revision: 1, updatedAt: null })
  await store.getState().fetchCatalog('p1')
  resolveSave(saved)
  await save
  expect(store.getState().catalogs.p1).toEqual(saved)
})
