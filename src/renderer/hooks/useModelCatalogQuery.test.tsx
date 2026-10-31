// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ClientCatalog } from '../utils/modelMapping'
import {
  clearModelCatalogQueryCache,
  modelCatalogCacheSize,
  modelCatalogIdentity,
  modelCatalogRouteIdentity,
  readCachedModelCatalog,
  useModelCatalogQuery,
  writeCachedModelCatalog,
  type ModelCatalogQueryInput,
  type ModelCatalogQueryResult,
} from './useModelCatalogQuery'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const apiMock = vi.hoisted(() => ({
  preview: vi.fn(),
  getQueryPreference: vi.fn(async () => null as string | null),
  saveQueryPreference: vi.fn(async () => {}),
}))

vi.mock('../api', () => ({
  getApi: () => ({
    provider: { queryModels: apiMock.preview },
    userAgent: {
      getQueryPreference: apiMock.getQueryPreference,
      saveQueryPreference: apiMock.saveQueryPreference,
    },
  }),
}))

const provider = {
  id: 'provider-1',
  baseUrl: 'https://provider.example/v1',
  httpProxy: null,
  requestHeaders: null,
}

const baseInput: ModelCatalogQueryInput = {
  provider,
  providerId: 'provider-1',
  apiKeyId: 'key-1',
  keyValue: 'sk-draft-credential',
  connectionConfig: { baseUrl: 'https://claude.example/anthropic', authScheme: 'bearer' },
}

const catalog = (ids: string[]): ClientCatalog => ({
  models: ids.map((id) => ({ id, displayName: '' })),
  fromCache: false,
  fetchedAt: '2026-10-28T00:00:00Z',
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

let current: ModelCatalogQueryResult
let container: HTMLDivElement
let root: Root

function Harness({ input }: { input: ModelCatalogQueryInput }) {
  current = useModelCatalogQuery(input)
  return <div>{current.status}</div>
}

async function renderHook(input: ModelCatalogQueryInput) {
  await act(async () => {
    root.render(<Harness input={input} />)
  })
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  apiMock.preview.mockReset()
  apiMock.getQueryPreference.mockReset()
  apiMock.getQueryPreference.mockResolvedValue(null)
  apiMock.saveQueryPreference.mockReset()
  clearModelCatalogQueryCache()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  clearModelCatalogQueryCache()
})

it('asks for nothing without a credential and reports the missing credential', async () => {
  await renderHook({ ...baseInput, keyValue: '  ' })
  await act(async () => current.query())
  await flush()

  expect(current.status).toBe('missingCredential')
  expect(apiMock.preview).not.toHaveBeenCalled()
})

it('reuses candidates for the same identity instead of querying twice', async () => {
  apiMock.preview.mockResolvedValue(catalog(['model-a', 'model-b']))
  await renderHook(baseInput)
  await flush()
  await act(async () => current.query())
  await flush()

  expect(current.status).toBe('ready')
  expect(current.catalog?.models.map(({ id }) => id)).toEqual(['model-a', 'model-b'])
  expect(apiMock.preview).toHaveBeenCalledTimes(1)

  // The other entry mounts a fresh controller for the same effective identity:
  // the process cache answers it, so both entries show the same candidates.
  await act(async () => root.unmount())
  container.remove()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await renderHook(baseInput)
  await flush()
  await act(async () => current.query())
  await flush()

  expect(apiMock.preview).toHaveBeenCalledTimes(1)
  expect(current.catalog?.models.map(({ id }) => id)).toEqual(['model-a', 'model-b'])
})

it('never lets a slow identity A overwrite the newer identity B', async () => {
  const slow = deferred<ClientCatalog>()
  const fast = deferred<ClientCatalog>()
  apiMock.preview.mockImplementation((input: { apiKeyId: string }) =>
    input.apiKeyId === 'key-2' ? fast.promise : slow.promise,
  )

  await renderHook(baseInput)
  await flush()
  await act(async () => current.query())

  const codexInput: ModelCatalogQueryInput = { ...baseInput, apiKeyId: 'key-2' }
  await renderHook(codexInput)
  await flush()
  await act(async () => current.query())

  // Identity changed before B answered: A's candidates are not shown as B's.
  expect(current.status).toBe('loading')

  await act(async () => fast.resolve(catalog(['b-model'])))
  await flush()
  expect(current.status).toBe('ready')
  expect(current.catalog?.models.map(({ id }) => id)).toEqual(['b-model'])

  await act(async () => slow.resolve(catalog(['a-model'])))
  await flush()
  expect(current.catalog?.models.map(({ id }) => id)).toEqual(['b-model'])
})

it('keeps the newest same-identity refresh even when an older one answers later', async () => {
  const first = deferred<ClientCatalog>()
  const second = deferred<ClientCatalog>()
  apiMock.preview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

  await renderHook(baseInput)
  await flush()
  await act(async () => current.query())
  await act(async () => current.query({ force: true }))
  expect(apiMock.preview).toHaveBeenCalledTimes(2)

  await act(async () => second.resolve(catalog(['newest'])))
  await flush()
  expect(current.catalog?.models.map(({ id }) => id)).toEqual(['newest'])

  await act(async () => first.resolve(catalog(['stale'])))
  await flush()
  expect(current.catalog?.models.map(({ id }) => id)).toEqual(['newest'])
})

it('does not let a late error of an old identity replace the newer result', async () => {
  const slow = deferred<ClientCatalog>()
  apiMock.preview.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(catalog(['second']))

  await renderHook(baseInput)
  await flush()
  await act(async () => current.query())

  const otherInput: ModelCatalogQueryInput = {
    ...baseInput,
    connectionConfig: { baseUrl: 'https://other.example/anthropic', authScheme: 'bearer' },
  }
  await renderHook(otherInput)
  await flush()
  await act(async () => current.query())
  await flush()
  expect(current.status).toBe('ready')

  await act(async () => slow.reject(new Error('stale identity failed')))
  await flush()
  expect(current.status).toBe('ready')
  expect(current.catalog?.models.map(({ id }) => id)).toEqual(['second'])
})

it('applies a query UA with the current value, never saves it as a preference', async () => {
  apiMock.preview.mockResolvedValue(catalog(['model-a']))
  await renderHook(baseInput)
  await flush()
  await act(async () => current.query())
  await flush()
  apiMock.preview.mockClear()

  await act(async () => current.applyUserAgent('cc-use-test-ua'))
  await flush()

  expect(apiMock.preview).toHaveBeenCalledTimes(1)
  const request = apiMock.preview.mock.calls[0][0] as Record<string, unknown>
  expect(request.connectionConfig).toEqual({
    ...baseInput.connectionConfig,
    userAgent: 'cc-use-test-ua',
  })
  expect(request).not.toHaveProperty('clientKind')
  expect(request).not.toHaveProperty('keyValue')
  // The query UA stays a query option: it is neither remembered nor written
  // into the connection draft as a forwarded User-Agent.
  expect(apiMock.saveQueryPreference).not.toHaveBeenCalled()
  expect(request).not.toHaveProperty('clientConfigs')
  expect(current.status).toBe('ready')
})

it('keeps the credential, provider headers/proxy and UA out of plaintext identities', () => {
  const identity = modelCatalogIdentity(baseInput, '')
  expect(identity).not.toContain('sk-draft-credential')

  const changedCredential = modelCatalogRouteIdentity({ ...baseInput, keyValue: 'sk-other' })
  expect(changedCredential).not.toBe(modelCatalogRouteIdentity(baseInput))
  expect(
    modelCatalogRouteIdentity({
      ...baseInput,
      provider: { ...provider, httpProxy: 'http://proxy' },
    }),
  ).not.toBe(modelCatalogRouteIdentity(baseInput))
  expect(
    modelCatalogRouteIdentity({
      ...baseInput,
      provider: { ...provider, requestHeaders: '{"X": "1"}' },
    }),
  ).not.toBe(modelCatalogRouteIdentity(baseInput))
  // The route identity is stable across UA edits; the full identity is not.
  expect(modelCatalogRouteIdentity(baseInput)).toBe(modelCatalogRouteIdentity(baseInput))
  expect(modelCatalogIdentity(baseInput, 'ua-a')).not.toBe(modelCatalogIdentity(baseInput, 'ua-b'))
})

it('bounds the candidate cache and expires entries after five minutes', () => {
  for (let index = 0; index < 40; index += 1) {
    writeCachedModelCatalog(`identity-${index}`, catalog([`model-${index}`]), 1_000)
  }
  expect(modelCatalogCacheSize()).toBe(32)
  expect(readCachedModelCatalog('identity-39', 1_000)?.models[0].id).toBe('model-39')
  expect(readCachedModelCatalog('identity-0', 1_000)).toBeUndefined()
  expect(readCachedModelCatalog('identity-39', 1_000 + 5 * 60 * 1000)).toBeDefined()
  expect(readCachedModelCatalog('identity-39', 1_000 + 5 * 60 * 1000 + 1)).toBeUndefined()
})

it('requires a saved Key id even when a draft credential exists', async () => {
  await renderHook({ ...baseInput, apiKeyId: undefined })
  await act(async () => current.query())
  expect(current.status).toBe('missingCredential')
  expect(apiMock.preview).not.toHaveBeenCalled()
})

it('invalidates candidates when credential version or authentication changes', async () => {
  apiMock.preview.mockResolvedValue(catalog(['first']))
  await renderHook(baseInput)
  await act(async () => current.query())
  await flush()
  await renderHook({ ...baseInput, keyValue: 'new-secret' })
  expect(current.status).toBe('idle')
  expect(current.catalog).toBeUndefined()
  await renderHook({ ...baseInput, connectionConfig: { authScheme: 'none' } })
  expect(current.catalog).toBeUndefined()
  expect(current.identity).not.toContain('new-secret')
})

it('retains same-identity successful models after a failed refresh, never across identities', async () => {
  apiMock.preview
    .mockResolvedValueOnce(catalog(['saved-candidate']))
    .mockRejectedValueOnce('offline')
  await renderHook(baseInput)
  await act(async () => current.query())
  await flush()
  await act(async () => current.query({ force: true }))
  await flush()
  expect(current.status).toBe('error')
  expect(current.stale).toBe(true)
  expect(current.catalog?.models[0].id).toBe('saved-candidate')
  await renderHook({ ...baseInput, apiKeyId: 'different' })
  expect(current.catalog).toBeUndefined()
})

it('does not commit a late query after the owner is disabled or unmounted', async () => {
  const pending = deferred<ClientCatalog>()
  apiMock.preview.mockReturnValue(pending.promise)
  await renderHook(baseInput)
  await act(async () => current.query())
  await renderHook({ ...baseInput, enabled: false })
  await act(async () => pending.resolve(catalog(['too-late'])))
  await flush()
  expect(current.status).toBe('idle')
  expect(current.catalog).toBeUndefined()
  expect(modelCatalogCacheSize()).toBe(0)
})
