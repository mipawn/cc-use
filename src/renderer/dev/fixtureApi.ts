import type { Api } from '../api/types'
import type {
  ClientKind,
  ConsoleEvent,
  ConsoleLogPage,
  DesktopClientKind,
  DesktopOperationResult,
  ProviderModelCatalog,
  RequestLogFilter,
  RecentRequestLogDisplay,
  StatsTimeRange,
  ProxySession,
} from '@shared/types'
import {
  clone,
  createDiagnostics,
  strictNamespace,
  utcTimestamp,
  type FixtureDiagnostics,
  type FixtureScenario,
} from './fixtureSupport'
import {
  fixtureModels,
  fixtureQueryScripts,
  makeClientProfile,
  makeKey,
  makeProvider,
  seedFixture,
} from './fixtureData'
import {
  dailyTrend,
  filterLedger,
  resourceStatistics,
  statistics,
  totalTokens,
} from './fixtureLedger'

type ImplementedApi = { [K in keyof Api]?: Partial<Api[K]> }
export interface FixtureOptions {
  scenario?: FixtureScenario
  now?: Date
  diagnostics?: FixtureDiagnostics
}

/** Every invocation is local. No transport dependency is imported anywhere in this module. */
export function createFixtureApi(options: FixtureOptions = {}) {
  const scenario = options.scenario ?? 'default'
  const now = new Date(options.now ?? new Date())
  const diagnostics = options.diagnostics ?? createDiagnostics()
  const state = seedFixture(scenario, now)
  let sequence = 0
  let generation = 1
  let detailMode = false
  let autoLaunch = false
  let shortcut = 'CommandOrControl+Shift+U'
  let running = true
  const stamp = () => utcTimestamp(now)
  // Desktop facts are RFC3339 operation times, not frozen timezone-less ledger dates.
  const desktopStamp = () => new Date(options.now ?? new Date()).toISOString()
  const nextId = (prefix: string) => `fixture-${prefix}-${++sequence}`
  const listeners = new Set<(event: ConsoleEvent) => void>()
  const statusListeners = new Set<Parameters<Api['proxy']['onStatusChanged']>[0]>()
  const sessions: ProxySession[] = []
  const userAgents: string[] = ['cc-use-fixture']
  const preferences = new Map<string, string>()
  const catalogs = new Map<string, ProviderModelCatalog>(
    state.providers.map((provider) => [
      provider.id,
      { models: clone(fixtureModels), revision: 1, updatedAt: stamp() },
    ]),
  )
  const fail = (operation: string): never => {
    throw new Error(`[fixture:${scenario}] ${operation} failed (synthetic, no external request)`)
  }
  const read = (operation: string) => {
    if (scenario === 'error') fail(operation)
  }
  const mutation = (operation: string) => {
    if (scenario === 'failed' || scenario === 'error') fail(operation)
  }
  const provider = (id: string) => {
    const result = state.providers.find((item) => item.id === id)
    if (!result) throw new Error('[fixture] Provider scope unavailable / 范围失效')
    return result
  }
  const key = (id: string) => {
    const result = state.keys.find((item) => item.id === id)
    if (!result) throw new Error('[fixture] Key scope unavailable / 范围失效')
    return result
  }
  const clientProfile = (id: string) => {
    const result = state.clientProfiles.find((item) => item.id === id)
    if (!result) throw new Error('[fixture] Client profile not found')
    return result
  }
  const route = (
    providerId: string,
    apiKeyId: string,
    client?: ClientKind,
    bypassLegacyTypeCheck = false,
  ) => {
    const p = provider(providerId)
    const k = key(apiKeyId)
    if (
      k.providerId !== p.id ||
      !p.isActive ||
      !k.isActive ||
      k.isExhausted ||
      (!bypassLegacyTypeCheck && client && !k.types.includes(client))
    )
      throw new Error('[fixture] Route unavailable or incompatible')
    return { p, k }
  }
  const scoped = (range: StatsTimeRange, filter: RequestLogFilter = {}) => {
    read('requestLog')
    if (filter.providerId) provider(filter.providerId)
    if (filter.apiKeyId) key(filter.apiKeyId)
    if (filter.instanceId && !state.instances.some((item) => item.id === filter.instanceId))
      throw new Error('[fixture] Instance history scope unavailable / 范围失效')
    return filterLedger(state.ledger, range, now, filter)
  }
  const consolePage = (records: typeof state.history, limit = 500): ConsoleLogPage => {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('[fixture] Invalid console limit')
    return clone({
      generation: `fixture-generation-${generation}`,
      records: records.slice(-limit),
      truncated: records.length > limit,
      retention: {
        retentionStartDate: state.retentionStartDate,
        capacityEvicted: false,
        trimmed: false,
        corrupted: 0,
        limited: records.length > limit,
      },
    })
  }
  const desktopOperation = (
    client: DesktopClientKind,
    target: { providerId: string; apiKeyId: string; profileId?: string } | null,
  ): DesktopOperationResult => {
    mutation('desktop operation')
    const current = state.desktops[client]
    if (!current) throw new Error('[fixture] Unknown desktop client')
    if (target) {
      if (target.profileId) {
        const profile = clientProfile(target.profileId)
        if (profile.clientKind !== client) {
          throw new Error('[fixture] Profile client kind mismatch')
        }
        route(target.providerId, target.apiKeyId, client, true)
      } else {
        route(target.providerId, target.apiKeyId, client)
      }
    }
    const restoring = target === null
    const routeChanged = JSON.stringify(current.route) !== JSON.stringify(target)
    const configChanged =
      scenario === 'partial'
        ? false
        : restoring ||
          scenario === 'configChanged' ||
          (scenario !== 'routeOnly' && current.status !== 'taken_over')
    current.route = target
    current.status = restoring ? 'official' : 'taken_over'
    if (configChanged)
      current.lastConfigChange = {
        action: restoring ? 'restore' : 'takeover',
        source: 'user',
        changedAt: desktopStamp(),
        version: (current.lastConfigChange?.version ?? 0) + 1,
      }
    current.warning =
      scenario === 'partial'
        ? 'Fixture: route changed, configuration write failed. Retry or restore. / 线路已变更，配置写入失败；请重试或恢复。'
        : null
    current.syncFailure =
      scenario === 'partial'
        ? { source: 'user', occurredAt: desktopStamp(), message: current.warning! }
        : null
    return clone({
      clientKind: client,
      action: restoring ? 'restore' : configChanged ? 'takeover' : 'switch_route',
      completion: scenario === 'partial' ? 'partial' : 'complete',
      routeChanged,
      configChanged,
      modelCount: restoring ? null : fixtureModels.length,
      nextAction: configChanged ? 'reopen_client' : 'none',
      updatedAt: desktopStamp(),
      warning: current.warning,
      state: current,
    })
  }
  const implementation = {
    provider: {
      list: async () => {
        read('provider.list')
        return clone(state.providers)
      },
      get: async (id) => {
        read('provider.get')
        return clone(state.providers.find((p) => p.id === id) ?? null)
      },
      create: async (input) => {
        mutation('provider.create')
        // Native creation owns identity, even when a form includes id: undefined.
        const id = nextId('provider')
        const p = makeProvider(id, input.name, { ...clone(input), id })
        state.providers.push(p)
        catalogs.set(p.id, { models: [], revision: 0, updatedAt: null })
        return clone(p)
      },
      update: async (input) => {
        mutation('provider.update')
        const p = provider(input.id)
        Object.assign(p, clone(input))
        return clone(p)
      },
      delete: async (id) => {
        mutation('provider.delete')
        provider(id)
        state.providers = state.providers.filter((p) => p.id !== id)
        state.keys = state.keys.filter((k) => k.providerId !== id)
        state.clientProfiles = state.clientProfiles.filter((cp) => cp.providerId !== id)
      },
      reorder: async (ids) => {
        mutation('provider.reorder')
        ids.forEach((id, sortOrder) => {
          provider(id).sortOrder = sortOrder
        })
        state.providers.sort((a, b) => a.sortOrder - b.sortOrder)
        return clone(state.providers)
      },
      modelList: async (id, keyId) => {
        read('provider.modelList')
        route(id, keyId)
        return clone((catalogs.get(id)?.models ?? []).map((model) => model.id))
      },
      modelCatalog: async (id, keyId, client) => {
        read('provider.modelCatalog')
        route(id, keyId, client)
        return { models: clone(catalogs.get(id)!.models), fromCache: true, fetchedAt: stamp() }
      },
      modelCatalogPreview: async (input) => {
        read('provider.modelCatalogPreview')
        provider(input.providerId)
        return {
          models: clone(catalogs.get(input.providerId)!.models),
          fromCache: true,
          fetchedAt: stamp(),
        }
      },
      getModelCatalog: async (id) => {
        read('provider.getModelCatalog')
        provider(id)
        return clone(catalogs.get(id)!)
      },
      saveModelCatalog: async (id, models, revision) => {
        mutation('provider.saveModelCatalog')
        provider(id)
        if (catalogs.get(id)!.revision !== revision)
          throw new Error('[fixture] Model catalog revision conflict')
        const catalog = { models: clone(models), revision: revision + 1, updatedAt: stamp() }
        catalogs.set(id, catalog)
        return clone(catalog)
      },
      queryModels: async (input) => {
        read('provider.queryModels')
        route(input.providerId, input.apiKeyId)
        return { models: clone(fixtureModels), fromCache: false, fetchedAt: stamp() }
      },
      presets: async () => [
        {
          id: 'custom',
          defaultName: 'Fixture provider',
          baseUrl: 'https://provider.fixture.invalid',
          icon: 'codex',
          requiresSiteAddress: false,
          needsAccountCredential: false,
          queryScope: 'key',
          walletBalanceType: 'none',
          walletBalanceUrl: null,
          walletBalanceHeaders: null,
          usageType: 'none',
          usageUrl: null,
          usageHeaders: null,
          walletBalanceScript: null,
          requestAdapter: '',
          defaultKeyConfig: {},
        },
      ],
    },
    apiKey: {
      list: async (id) => {
        read('apiKey.list')
        provider(id)
        return clone(state.keys.filter((k) => k.providerId === id))
      },
      retiredMappingReport: async () => [],
      create: async (input) => {
        mutation('apiKey.create')
        provider(input.providerId)
        const id = nextId('key')
        const k = makeKey(id, input.providerId, input.alias ?? 'Fixture key', {
          ...clone(input),
          id,
        })
        state.keys.push(k)
        return clone(k)
      },
      update: async (input) => {
        mutation('apiKey.update')
        const k = key(input.id)
        Object.assign(k, clone(input))
        if (scenario === 'partial')
          for (const desktop of Object.values(state.desktops)) {
            if (desktop.route?.apiKeyId === k.id)
              desktop.syncFailure = {
                source: 'key_edit',
                occurredAt: desktopStamp(),
                message:
                  'Fixture key saved; desktop profile synchronization failed / 密钥已保存，配置同步失败',
              }
          }
        return clone(k)
      },
      delete: async (id) => {
        mutation('apiKey.delete')
        key(id)
        state.keys = state.keys.filter((k) => k.id !== id)
        state.clientProfiles = state.clientProfiles.filter((cp) => cp.apiKeyId !== id)
      },
      reorder: async (providerId, ids) => {
        mutation('apiKey.reorder')
        provider(providerId)
        ids.forEach((id, priority) => {
          const k = key(id)
          if (k.providerId !== providerId) throw new Error('[fixture] Key owner mismatch')
          k.priority = priority
        })
        state.keys.sort((a, b) => a.priority - b.priority)
        return clone(state.keys.filter((k) => k.providerId === providerId))
      },
    },
    clientProfile: {
      list: async (clientKind) => {
        read('clientProfile.list')
        const items = clientKind
          ? state.clientProfiles.filter((item) => item.clientKind === clientKind)
          : state.clientProfiles
        return clone([...items].sort((a, b) => a.sortOrder - b.sortOrder))
      },
      get: async (id) => {
        read('clientProfile.get')
        return clone(state.clientProfiles.find((item) => item.id === id) ?? null)
      },
      create: async (input) => {
        mutation('clientProfile.create')
        const p = provider(input.providerId)
        const k = key(input.apiKeyId)
        if (k.providerId !== p.id) throw new Error('[fixture] Key owner mismatch')
        const id = nextId('profile')
        const siblings = state.clientProfiles.filter((item) => item.clientKind === input.clientKind)
        const shouldBeDefault = input.isDefault ?? siblings.length === 0
        if (shouldBeDefault) {
          for (const sibling of siblings) sibling.isDefault = false
        }
        const created = makeClientProfile(
          id,
          input.name,
          input.clientKind,
          input.providerId,
          input.apiKeyId,
          stamp(),
          {
            isDefault: shouldBeDefault,
            sortOrder: siblings.length,
            modelConfig: input.modelConfig ?? null,
            connectionConfig: input.connectionConfig ? clone(input.connectionConfig) : null,
            launchEnv: input.launchEnv ? clone(input.launchEnv) : null,
          },
        )
        state.clientProfiles.push(created)
        return clone(created)
      },
      update: async (input) => {
        mutation('clientProfile.update')
        const target = clientProfile(input.id)
        const nextProviderId = input.providerId ?? target.providerId
        const nextKeyId = input.apiKeyId ?? target.apiKeyId
        if (nextProviderId !== target.providerId || nextKeyId !== target.apiKeyId) {
          const p = provider(nextProviderId)
          const k = key(nextKeyId)
          if (k.providerId !== p.id) throw new Error('[fixture] Key owner mismatch')
        }
        if (input.isDefault === true) {
          for (const sibling of state.clientProfiles) {
            if (sibling.clientKind === target.clientKind && sibling.id !== target.id) {
              sibling.isDefault = false
            }
          }
        }
        const routeChanged =
          nextProviderId !== target.providerId || nextKeyId !== target.apiKeyId
        Object.assign(target, clone(input), { updatedAt: stamp() })
        if (routeChanged) {
          for (const desktop of Object.values(state.desktops)) {
            if (desktop.route?.profileId === target.id) {
              desktop.route = {
                providerId: target.providerId,
                apiKeyId: target.apiKeyId,
                profileId: target.id,
              }
            }
          }
          for (const inst of state.instances) {
            if (
              inst.clientProfileId === target.id &&
              ['launching', 'running', 'stale'].includes(inst.status)
            ) {
              inst.providerId = target.providerId
              inst.apiKeyId = target.apiKeyId
            }
          }
        }
        if (scenario === 'partial') {
          for (const desktop of Object.values(state.desktops)) {
            if (desktop.route?.profileId === target.id) {
              desktop.syncFailure = {
                source: 'key_edit',
                occurredAt: desktopStamp(),
                message:
                  'Fixture profile saved; desktop configuration sync failed / 方案已保存，配置同步失败',
              }
            }
          }
        }
        return clone(target)
      },
      delete: async (id) => {
        mutation('clientProfile.delete')
        clientProfile(id)
        const before = state.clientProfiles.length
        state.clientProfiles = state.clientProfiles.filter((item) => item.id !== id)
        return state.clientProfiles.length !== before
      },
      reorder: async (clientKind, ids) => {
        mutation('clientProfile.reorder')
        ids.forEach((id, sortOrder) => {
          const item = clientProfile(id)
          if (item.clientKind !== clientKind) throw new Error('[fixture] Profile kind mismatch')
          item.sortOrder = sortOrder
        })
      },
    },
    userAgent: {
      list: async () => [...userAgents],
      save: async (value) => {
        if (!userAgents.includes(value)) userAgents.push(value)
        return [...userAgents]
      },
      delete: async (value) => {
        const index = userAgents.indexOf(value)
        if (index >= 0) userAgents.splice(index, 1)
        return [...userAgents]
      },
      getQueryPreference: async (p, client) => preferences.get(`${p}:${client}`) ?? null,
      saveQueryPreference: async (p, client, value) => {
        preferences.set(`${p}:${client}`, value)
      },
    },
    balance: {
      schemes: async (scope) =>
        (['account', 'key'] as const)
          .filter((s) => !scope || scope === s)
          .map((s) => ({
            id: `fixture-${s}`,
            scope: s,
            labelKey: 'Fixture quota',
            descriptionKey: 'In-memory quota only',
            credentialRequirements: s === 'key' ? ['apiKey' as const] : ['accessToken' as const],
            supportsWindows: s === 'account',
            script: fixtureQueryScripts[s],
          })),
      checkScript: async () => ({
        url: 'https://query.fixture.invalid',
        method: 'GET',
        headers: {},
      }),
      testDraft: async (input) =>
        scenario === 'quotaError'
          ? {
              scope: input.scope,
              usage: null,
              error: 'Synthetic quota query failure',
              isValid: false,
              invalidMessage: null,
            }
          : {
              scope: input.scope,
              usage: { unit: 'CNY', remaining: 128.5 },
              isValid: true,
              invalidMessage: null,
              error: null,
            },
      refresh: async (id) => {
        const p = provider(id)
        if (p.queryScope !== 'account')
          throw new Error('[fixture] Account query unavailable for key-owned quota')
        const error =
          scenario === 'quotaError' || scenario === 'error'
            ? 'Synthetic quota query failed; previous cache retained'
            : null
        if (!error) p.lastBalanceCheckedAt = stamp()
        return {
          balance: p.cachedWalletBalance,
          total: p.cachedUsage?.total ?? null,
          used: p.cachedUsage?.used ?? null,
          unlimited: false,
          currency: p.cachedWalletBalanceCurrency,
          windows: clone(p.cachedUsage?.windows ?? []),
          isValid: !error,
          invalidMessage: null,
          error,
        }
      },
    },
    keyUsage: {
      refresh: async (id) => {
        const k = key(id)
        if (provider(k.providerId).queryScope !== 'key')
          throw new Error('[fixture] Quota belongs to the account, not this key')
        const error =
          scenario === 'quotaError' || scenario === 'error'
            ? 'Synthetic quota query failed; previous cache retained'
            : null
        if (!error) k.lastUsageCheckedAt = stamp()
        return { usage: clone(k.cachedUsage), error, isValid: !error, invalidMessage: null }
      },
    },
    settings: {
      get: async () => clone(state.settings),
      update: async (updates) => {
        mutation('settings.update')
        Object.assign(state.settings, clone(updates))
        return clone(state.settings)
      },
    },
    proxy: {
      status: async () => ({
        isRunning: running,
        port: state.settings.proxyPort,
        requestCount: state.ledger.length,
        lastError: null,
      }),
      onStatusChanged: (callback) => {
        statusListeners.add(callback)
        return () => {
          statusListeners.delete(callback)
        }
      },
      getDetailMode: async () => detailMode,
      setDetailMode: async (enabled) => {
        detailMode = enabled
      },
      lanAddresses: async () => {
        const scope = state.settings.proxyListenScope ?? 'loopback'
        return {
          scope,
          port: state.settings.proxyPort,
          addresses:
            scope === 'lan'
              ? [
                  {
                    ip: '192.0.2.10',
                    url: `http://192.0.2.10:${state.settings.proxyPort}`,
                    interface: 'en0',
                  },
                ]
              : [],
        }
      },
    },
    managedInstances: {
      list: async (client) => {
        read('managedInstances.list')
        return clone(
          client
            ? state.instances
                .filter(
                  (item) => (item.cliType === 'claude' ? 'claude_code' : item.cliType) === client,
                )
                .sort((a, b) => b.launchedAt.localeCompare(a.launchedAt))
                .slice(0, 100)
            : state.instances.filter((item) =>
                ['launching', 'running', 'stale'].includes(item.status),
              ),
        )
      },
      get: async (id) => {
        read('managedInstances.get')
        return clone(state.instances.find((item) => item.id === id) ?? null)
      },
      updateAssignment: async (input) => {
        mutation('managedInstances.updateAssignment')
        const item = state.instances.find((instance) => instance.id === input.id)
        if (!item || !['launching', 'running', 'stale'].includes(item.status))
          throw new Error('[fixture] Instance stopped or missing')
        if (input.clientProfileId) {
          clientProfile(input.clientProfileId)
        }
        route(
          input.providerId,
          input.apiKeyId,
          (item.cliType === 'claude' ? 'claude_code' : item.cliType) as ClientKind,
          Boolean(input.clientProfileId),
        )
        Object.assign(item, clone(input))
        return clone(item)
      },
      cleanup: async (client) => {
        mutation('managedInstances.cleanup')
        const before = state.instances.length
        state.instances = state.instances.filter(
          (item) =>
            (item.cliType === 'claude' ? 'claude_code' : item.cliType) !== client ||
            ['launching', 'running', 'stale'].includes(item.status),
        )
        return before - state.instances.length
      },
    },
    desktopConnection: {
      state: async (client) => {
        read('desktopConnection.state')
        if (!state.desktops[client]) throw new Error('[fixture] Unknown desktop client')
        return clone(state.desktops[client])
      },
      apply: async (client, providerId, apiKeyId, clientProfileId) =>
        desktopOperation(
          client,
          clientProfileId ? { providerId, apiKeyId, profileId: clientProfileId } : { providerId, apiKeyId },
        ),
      restore: async (client) => desktopOperation(client, null),
    },
    configTakeover: {
      readCodex: async () =>
        '# SYNTHETIC fixture only\nmodel_provider = "fixture"\nbase_url = "https://preview.fixture.invalid"',
      readClaudeDesktop: async () =>
        JSON.stringify(
          { fixture: true, route: 'https://preview.fixture.invalid', credential: '[REDACTED]' },
          null,
          2,
        ),
    },
    gateway: {
      list: async () => {
        read('gateway.list')
        return clone(state.gateways)
      },
      create: async (name, providerId, apiKeyId, connectionConfig) => {
        mutation('gateway.create')
        const { p, k } = route(providerId, apiKeyId)
        const gateway = {
          sessionToken: nextId('gateway'),
          displayName: name,
          providerId,
          providerName: p.name,
          apiKeyId,
          keyAlias: k.alias,
          isActive: true,
          createdAt: stamp(),
          lastSeenAt: stamp(),
          connectionConfig: clone(connectionConfig ?? { authScheme: 'bearer' as const }),
        }
        state.gateways.push(gateway)
        return clone(gateway)
      },
      update: async (token, changes) => {
        mutation('gateway.update')
        const gateway = state.gateways.find((item) => item.sessionToken === token)
        if (!gateway) throw new Error('[fixture] Gateway not found')
        const { p, k } = route(
          changes.providerId ?? gateway.providerId,
          changes.apiKeyId ?? gateway.apiKeyId,
        )
        const { name, ...rest } = clone(changes)
        Object.assign(
          gateway,
          rest,
          { providerName: p.name, keyAlias: k.alias },
          name !== undefined ? { displayName: name } : {},
        )
        return clone(gateway)
      },
      delete: async (token) => {
        mutation('gateway.delete')
        const before = state.gateways.length
        state.gateways = state.gateways.filter((item) => item.sessionToken !== token)
        return before !== state.gateways.length
      },
    },
    session: {
      list: async () => clone(sessions),
      get: async (token) => clone(sessions.find((s) => s.sessionToken === token) ?? null),
    },
    sessions: {
      scanSessions: async () =>
        scenario === 'empty'
          ? []
          : [
              {
                sessionId: 'fixture-claude-session',
                projectPath: '/fixture/workspaces/cc-use',
                jsonlSize: 1024,
                dirSize: 1024,
                totalSize: 2048,
                lastModified: now.getTime(),
                messageCount: 12,
                firstMessage: 'Fixture: review GUI navigation',
              },
            ],
    },
    console: {
      onEvent: (callback) => {
        listeners.add(callback)
        return () => {
          listeners.delete(callback)
        }
      },
      readRecent: async (sources, limit) => {
        read('console.readRecent')
        if (scenario === 'consoleError') fail('console.readRecent')
        return consolePage(
          state.history.filter((record) => sources.includes(record.source)),
          limit,
        )
      },
      readRequest: async (requestId, limit) => {
        read('console.readRequest')
        if (scenario === 'consoleError') fail('console.readRequest')
        return consolePage(
          state.history.filter(
            (record) => record.event.category === 'request' && record.event.requestId === requestId,
          ),
          limit,
        )
      },
      logStatus: async () => ({
        dropped: 0,
        app: { available: true, dropped: 0, writeFailed: 0, trimmed: 0, capacityEvicted: false },
        daemon: { available: true, dropped: 0, writeFailed: 0, trimmed: 0, capacityEvicted: false },
      }),
      clearHistory: async () => {
        generation++
        const partial = scenario === 'partial'
        state.history = partial ? state.history.filter((record) => record.source === 'daemon') : []
        return { ok: !partial, app: true, daemon: !partial }
      },
      // Deliberate tripwire: fixture boot must not install the persistence bridge.
      appendRendererLogs: async () =>
        diagnostics.reject('Renderer console persistence bridge must be disabled'),
    },
    requestLog: {
      getOverview: async () => {
        const s = statistics(scoped('today')).summary
        return {
          todayTokens: s.totalTokens,
          todayRequests: s.totalRequests,
          todayFailedRequests: s.failedRequests,
        }
      },
      getStatistics: async (range, filter) => statistics(scoped(range, filter)),
      getResourceStatistics: async (range, providerId, apiKeyId) =>
        resourceStatistics(scoped(range, { providerId, apiKeyId })),
      getRecentPaginated: async (range, page = 1, pageSize = 20, filter) => {
        if (
          !Number.isInteger(page) ||
          page < 1 ||
          !Number.isInteger(pageSize) ||
          pageSize < 1 ||
          pageSize > 200
        )
          throw new Error('[fixture] Invalid pagination')
        const rows = scoped(range, filter)
        return {
          items: clone(
            rows.slice((page - 1) * pageSize, page * pageSize).map((row) => {
              const display: RecentRequestLogDisplay & Partial<typeof row> = { ...row }
              delete display.providerId
              delete display.apiKeyId
              delete display.instanceId
              return display
            }),
          ),
          total: rows.length,
          page,
          pageSize,
        }
      },
      getMonthlyTrend: async (year, month) => {
        if (
          !Number.isInteger(year) ||
          year < 1970 ||
          !Number.isInteger(month) ||
          month < 1 ||
          month > 12
        )
          throw new Error('[fixture] Invalid month')
        const from = `${year}-${String(month).padStart(2, '0')}-01`
        const to = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`
        return dailyTrend(scoped(`custom:${from}:${to}`))
      },
      getDailyTrend: async (days = 30) => {
        read('requestLog.getDailyTrend')
        return dailyTrend(state.ledger).slice(-days)
      },
      getKeyTokenStats: async () =>
        state.keys.map((k) => ({
          keyId: k.id,
          todayTokens: scoped('today', { apiKeyId: k.id }).reduce(
            (n, row) => n + totalTokens(row),
            0,
          ),
          totalTokens: scoped('all', { apiKeyId: k.id }).reduce(
            (n, row) => n + totalTokens(row),
            0,
          ),
        })),
      getGatewayMetrics: async () => ({
        windows: (['hour', 'day', 'week'] as const).map((window) => ({
          window,
          totalRequests: 70,
          successfulRequests: 62,
          upstreamErrors: 8,
          rejectedRequests: 0,
          activeProviders: 2,
          avgLatencyMs: 1200,
          p95LatencyMs: 1500,
          lastRequestAt: stamp(),
        })),
      }),
      getProviderGatewayMetrics: async () =>
        state.providers.map((p) => ({
          providerName: p.name,
          totalRequests: 35,
          successfulRequests: 31,
          upstreamErrors: 4,
          avgLatencyMs: 1200,
          lastRequestAt: stamp(),
        })),
    },
    cliTool: {
      status: async () => ({
        available: true,
        bundledPath: '/fixture/cc-use',
        installed: true,
        managed: true,
        current: true,
        target: '/fixture/bin/cc-use',
      }),
      statuslineStatus: async () => ({ state: 'notConfigured' }),
    },
    app: {
      getVersion: async () => '3.19.0-fixture',
      checkUpdate: async () => ({ available: false }),
    },
    system: {
      getPlatform: async () => 'darwin',
      openExternal: async () => diagnostics.reject('External opening is disabled'),
      selectFolder: async () => diagnostics.reject('Native folder dialog is disabled'),
    },
    systemExt: {
      autoLaunchIsEnabled: async () => autoLaunch,
      autoLaunchSetEnabled: async (enabled) => {
        autoLaunch = enabled
        return enabled
      },
      showWindowGetShortcut: async () => shortcut,
      showWindowSetShortcut: async (value) => {
        shortcut = value
        return value
      },
    },
    icon: {
      list: async () => ({ preset: ['codex', 'claude'], uploaded: [] }),
      read: async () => 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E',
    },
    importExport: { checkElectronMigration: async () => ({ needed: false, electronDbPath: '' }) },
    terminal: {
      getLaunchPreview: async (input) => {
        read('terminal.getLaunchPreview')
        if (input.projectId) throw new Error('[fixture] Project launch previews are unavailable')
        if (!input.apiKeyId) throw new Error('[fixture] API key is required')
        const k = key(input.apiKeyId)
        if (input.providerId && input.providerId !== k.providerId)
          throw new Error('[fixture] Key owner mismatch')
        if (input.clientProfileId) {
          clientProfile(input.clientProfileId)
        }
        if (!['claude_code', 'claude', 'grok'].includes(input.cliType))
          throw new Error('[fixture] Unsupported terminal client')
        // Display-only placeholders: never merge credentials, paths or executable config.
        const env: Record<string, string> =
          input.cliType === 'grok'
            ? { CC_USE_GROK_TOKEN: 'fixture-not-a-secret-preview-token' }
            : {
                ANTHROPIC_BASE_URL: 'https://gateway.fixture.invalid',
                ANTHROPIC_AUTH_TOKEN: 'fixture-not-a-secret-preview-token',
              }
        return {
          cliType: input.cliType,
          env,
          command: '# Fixture preview only / 仅合成预览，不执行命令',
          prelaunchCommand: null,
        }
      },
    },
    // Existing launch/file/process operations are intentionally NOT implemented.
    // Their namespace exists only to produce a precise, fail-closed error.
    project: {},
    codexApp: {},
    usageLog: {},
  } satisfies ImplementedApi

  // The only assertion: Partial<Api> is exposed as Api behind strict proxies.
  // A missing namespace or method throws before any real API can be reached.
  const wrapped = Object.fromEntries(
    Object.entries(implementation).map(([namespace, methods]) => [
      namespace,
      strictNamespace(
        Object.fromEntries(
          Object.entries(methods).map(([name, fn]) => [
            name,
            (...args: unknown[]) => {
              diagnostics.calls.push(`${namespace}.${name}`)
              return (fn as (...parameters: unknown[]) => unknown)(...args)
            },
          ]),
        ),
        namespace,
        diagnostics,
      ),
    ]),
  )
  const api = strictNamespace(wrapped, 'api', diagnostics) as unknown as Api
  return {
    api,
    scenario,
    diagnostics,
    emit(event: ConsoleEvent) {
      for (const listener of listeners) listener(clone(event))
    },
    setRunning(value: boolean) {
      running = value
      for (const callback of statusListeners)
        callback({ isRunning: value, port: state.settings.proxyPort, source: 'fixture' })
    },
  }
}
