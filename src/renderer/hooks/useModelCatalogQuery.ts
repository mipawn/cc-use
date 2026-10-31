/** Independent provider queries. Saved model catalogs belong to the domain store. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GatewayConnectionConfig } from '@shared/types'
import { getApi } from '../api'
import type { ClientCatalog } from '../utils/modelMapping'

export type ModelQueryAuthScheme = GatewayConnectionConfig['authScheme']
export type ModelCatalogQueryStatus =
  | 'idle'
  | 'missingCredential'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
export interface ModelQueryProvider {
  id?: string | null
  baseUrl?: string | null
  httpProxy?: string | null
  requestHeaders?: string | null
}
export interface ModelCatalogQueryInput {
  provider?: ModelQueryProvider | null
  providerId?: string
  apiKeyId?: string
  /** Used only as a credential-version fingerprint. Never sent or cached in plaintext. */
  keyValue: string
  connectionConfig: GatewayConnectionConfig
  enabled?: boolean
}
export interface ModelQueryRoute {
  baseUrl: string
  authScheme: ModelQueryAuthScheme
}
export interface ModelCatalogQueryResult {
  status: ModelCatalogQueryStatus
  identity: string
  routeIdentity: string
  route: ModelQueryRoute
  revision: number
  catalog?: ClientCatalog
  error?: string
  stale: boolean
  userAgent: string
  userAgentReady: boolean
  setUserAgent: (value: string) => void
  applyUserAgent: (value: string) => void
  query: (options?: { force?: boolean }) => void
  canQuery: boolean
}
interface QueryState {
  identity: string
  revision: number
  status: ModelCatalogQueryStatus
  catalog?: ClientCatalog
  error?: string
}
const CACHE_LIMIT = 32
const CACHE_TTL_MS = 5 * 60 * 1000
const catalogCache = new Map<string, { catalog: ClientCatalog; at: number }>()
const inflightQueries = new Map<string, Promise<ClientCatalog>>()
export function modelQueryFingerprint(value: string): string {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}
export function resolveModelQueryRoute(
  input: Pick<ModelCatalogQueryInput, 'provider' | 'connectionConfig'>,
): ModelQueryRoute {
  return {
    baseUrl: input.connectionConfig.baseUrl?.trim() || input.provider?.baseUrl?.trim() || '',
    authScheme: input.connectionConfig.authScheme,
  }
}
export function modelCatalogRouteIdentity(input: Omit<ModelCatalogQueryInput, 'enabled'>): string {
  const route = resolveModelQueryRoute(input)
  return JSON.stringify([
    input.providerId ?? input.provider?.id ?? '',
    input.apiKeyId ?? '',
    route.baseUrl,
    route.authScheme,
    modelQueryFingerprint(input.keyValue.trim()),
    modelQueryFingerprint(
      `${input.provider?.httpProxy ?? ''}\u0000${input.provider?.requestHeaders ?? ''}`,
    ),
  ])
}
export function modelCatalogIdentity(
  input: Omit<ModelCatalogQueryInput, 'enabled'>,
  userAgent: string,
): string {
  return JSON.stringify([modelCatalogRouteIdentity(input), userAgent.trim()])
}
export function readCachedModelCatalog(
  identity: string,
  now = Date.now(),
): ClientCatalog | undefined {
  const entry = catalogCache.get(identity)
  if (!entry) return undefined
  if (now - entry.at > CACHE_TTL_MS) {
    catalogCache.delete(identity)
    return undefined
  }
  catalogCache.delete(identity)
  catalogCache.set(identity, entry)
  return entry.catalog
}
export function writeCachedModelCatalog(
  identity: string,
  catalog: ClientCatalog,
  now = Date.now(),
): void {
  catalogCache.delete(identity)
  catalogCache.set(identity, { catalog, at: now })
  while (catalogCache.size > CACHE_LIMIT) {
    const oldest = catalogCache.keys().next().value
    if (oldest === undefined) break
    catalogCache.delete(oldest)
  }
}
export function clearModelCatalogQueryCache(): void {
  catalogCache.clear()
  inflightQueries.clear()
}
export function modelCatalogCacheSize(): number {
  return catalogCache.size
}

export function useModelCatalogQuery(input: ModelCatalogQueryInput): ModelCatalogQueryResult {
  const { provider, providerId, apiKeyId, keyValue, connectionConfig, enabled = true } = input
  const [state, setState] = useState<QueryState>({ identity: '', revision: 0, status: 'idle' })
  const [userAgent, setUserAgentState] = useState(connectionConfig.userAgent ?? '')
  const identity = modelCatalogIdentity(input, userAgent)
  const identityRef = useRef(identity)
  identityRef.current = identity
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const aliveRef = useRef(true)
  const revisionRef = useRef(0)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      revisionRef.current += 1
    }
  }, [])
  const run = useCallback(
    (agent: string, force: boolean) => {
      if (!enabled || !providerId || !apiKeyId || !keyValue.trim()) return
      const requestInput = { provider, providerId, apiKeyId, keyValue, connectionConfig }
      const requestIdentity = modelCatalogIdentity(requestInput, agent)
      identityRef.current = requestIdentity
      const revision = ++revisionRef.current
      const cached = force ? undefined : readCachedModelCatalog(requestIdentity)
      if (cached) {
        setState({
          identity: requestIdentity,
          revision,
          status: cached.models.length ? 'ready' : 'empty',
          catalog: cached,
        })
        return
      }
      setState((previous) => ({
        identity: requestIdentity,
        revision,
        status: 'loading',
        catalog: previous.identity === requestIdentity ? previous.catalog : undefined,
      }))
      let pending = force ? undefined : inflightQueries.get(requestIdentity)
      if (!pending) {
        pending = getApi().provider.queryModels({
          providerId,
          apiKeyId,
          connectionConfig: {
            ...connectionConfig,
            baseUrl: connectionConfig.baseUrl?.trim() || null,
            userAgent: agent.trim() || null,
          },
        })
        if (!force) {
          inflightQueries.set(requestIdentity, pending)
          const settle = () => {
            if (inflightQueries.get(requestIdentity) === pending)
              inflightQueries.delete(requestIdentity)
          }
          void pending.then(settle, settle)
        }
      }
      const current = () =>
        aliveRef.current &&
        enabledRef.current &&
        revisionRef.current === revision &&
        identityRef.current === requestIdentity
      void pending.then(
        (catalog) => {
          if (!current()) return
          if (catalog.error) {
            setState((previous) => ({
              identity: requestIdentity,
              revision,
              status: 'error',
              error: catalog.error,
              catalog: catalog.models.length
                ? catalog
                : previous.identity === requestIdentity
                  ? previous.catalog
                  : undefined,
            }))
            return
          }
          writeCachedModelCatalog(requestIdentity, catalog)
          setState({
            identity: requestIdentity,
            revision,
            status: catalog.models.length ? 'ready' : 'empty',
            catalog,
          })
        },
        (error: unknown) => {
          if (!current()) return
          setState((previous) => ({
            identity: requestIdentity,
            revision,
            status: 'error',
            error: String(error),
            catalog: previous.identity === requestIdentity ? previous.catalog : undefined,
          }))
        },
      )
    },
    [enabled, provider, providerId, apiKeyId, keyValue, connectionConfig],
  )
  const setUserAgent = useCallback(
    (value: string) => {
      setUserAgentState(value)
      identityRef.current = modelCatalogIdentity(input, value)
    },
    [input],
  )
  const applyUserAgent = useCallback(
    (value: string) => {
      setUserAgentState(value)
      run(value, true)
    },
    [run],
  )
  const query = useCallback(
    (options?: { force?: boolean }) => run(userAgent, options?.force ?? false),
    [run, userAgent],
  )
  const canQuery = Boolean(enabled && providerId && apiKeyId && keyValue.trim())
  const status = !enabled
    ? 'idle'
    : !canQuery
      ? 'missingCredential'
      : state.identity === identity
        ? state.status
        : 'idle'
  const catalog = state.identity === identity ? state.catalog : undefined
  return {
    status,
    identity,
    routeIdentity: modelCatalogRouteIdentity(input),
    route: resolveModelQueryRoute(input),
    revision: state.identity === identity ? state.revision : 0,
    catalog,
    error: state.identity === identity ? state.error : undefined,
    stale: status === 'error' && Boolean(catalog),
    userAgent,
    userAgentReady: true,
    setUserAgent,
    applyUserAgent,
    query,
    canQuery,
  }
}
