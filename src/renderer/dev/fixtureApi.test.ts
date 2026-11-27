import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectiveQuery, providerQueryMissingCredential } from '../utils/accountQuery'
import { createFixtureApi } from './fixtureApi'
import { parseScenario, scenarios, type FixtureScenario } from './fixtureSupport'

const now = new Date(2026, 10, 15, 16)
const fixture = (scenario: FixtureScenario = 'default') => createFixtureApi({ scenario, now })

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('fixture API gate', () => {
  it.each([
    [false, '1', false],
    [true, undefined, false],
    [true, '0', false],
    [true, '1', true],
  ] as const)('requires DEV=%s and flag=%s (enabled=%s)', async (dev, flag, enabled) => {
    vi.stubEnv('DEV', dev)
    vi.stubEnv('VITE_CC_USE_FIXTURE', flag)
    vi.resetModules()
    expect((await import('./mode')).isFixtureMode).toBe(enabled)
    const { getApi, installDevFixtureApi } = await import('../api')
    const local = fixture()
    if (!enabled) {
      expect(() => installDevFixtureApi(local.api)).toThrow('requires DEV')
      return
    }
    expect(() => getApi()).toThrow('before fixture bootstrap')
    installDevFixtureApi(local.api)
    expect(getApi()).toBe(local.api)
    expect(await getApi().provider.list()).toHaveLength(4)
    expect(() => getApi().proxy.restart()).toThrow('Unimplemented API: proxy.restart')
    expect(local.diagnostics.violations).toHaveLength(1)
  })
})

describe('strict local fixture API', () => {
  it('rejects unknown namespaces/methods, inherited escapes, and renderer persistence', async () => {
    const { api, diagnostics } = fixture()
    expect(() => Reflect.get(api, 'unmapped')).toThrow('Unimplemented API: api.unmapped')
    expect(() => Reflect.get(api.provider, 'toString')).toThrow(
      'Unimplemented API: provider.toString',
    )
    expect(() => api.terminal.launch('never')).toThrow('Unimplemented API: terminal.launch')
    await expect(api.console.appendRendererLogs([])).rejects.toThrow(
      'persistence bridge must be disabled',
    )
    expect(diagnostics.violations).toHaveLength(4)
  })

  it.each(['claude_code', 'claude', 'grok'] as const)(
    'provides a fully synthetic read-only %s preview for the key editor',
    async (cliType) => {
      const { api, diagnostics } = fixture('partial')
      await api.apiKey.update({
        id: 'key-usd',
        value: 'private-key-marker',
        config: { PRIVATE_ENV: 'private-env-marker', prelaunchCommand: 'do-not-execute' },
      })
      await api.settings.update({ claudeConfig: { PRIVATE_GLOBAL: 'private-global-marker' } })
      const before = {
        keys: await api.apiKey.list('provider-usd'),
        settings: await api.settings.get(),
        instances: await api.managedInstances.list(),
        sessions: await api.session.list(),
        desktop: await api.desktopConnection.state('codex'),
      }
      const expected = {
        cliType,
        command: '# Fixture preview only / 仅合成预览，不执行命令',
        prelaunchCommand: null,
        env:
          cliType === 'grok'
            ? { CC_USE_GROK_TOKEN: 'fixture-not-a-secret-preview-token' }
            : {
                ANTHROPIC_BASE_URL: 'https://gateway.fixture.invalid',
                ANTHROPIC_AUTH_TOKEN: 'fixture-not-a-secret-preview-token',
              },
      }
      const preview = await api.terminal.getLaunchPreview({
        providerId: 'provider-usd',
        apiKeyId: 'key-usd',
        cliType,
      })
      expect(preview).toEqual(expected)
      preview.env.PRIVATE_ENV = 'outside-mutation'
      // Key detail callers omit providerId; disabled/exhausted keys remain editable.
      for (const apiKeyId of ['key-usd', 'key-disabled', 'key-exhausted']) {
        expect(await api.terminal.getLaunchPreview({ apiKeyId, cliType })).toEqual(expected)
      }
      // The other mount-time readers used by KeyEditModal and its nested editors.
      expect(await api.apiKey.retiredMappingReport()).toEqual([])
      expect(await api.balance.schemes('key')).toEqual([
        expect.objectContaining({ id: 'fixture-key', scope: 'key' }),
      ])
      expect((await api.provider.getModelCatalog('provider-usd')).models.length).toBeGreaterThan(0)
      expect(await api.userAgent.list()).toEqual(['cc-use-fixture'])
      expect({
        keys: await api.apiKey.list('provider-usd'),
        settings: await api.settings.get(),
        instances: await api.managedInstances.list(),
        sessions: await api.session.list(),
        desktop: await api.desktopConnection.state('codex'),
      }).toEqual(before)
      expect(diagnostics.violations).toEqual([])
    },
  )

  it('rejects invalid preview scopes and still blocks terminal side effects', async () => {
    const { api, diagnostics } = fixture('partial')
    await expect(api.terminal.getLaunchPreview({ cliType: 'claude_code' })).rejects.toThrow(
      'API key is required',
    )
    await expect(
      api.terminal.getLaunchPreview({ apiKeyId: 'missing', cliType: 'claude_code' }),
    ).rejects.toThrow('Key scope unavailable')
    await expect(
      api.terminal.getLaunchPreview({
        providerId: 'provider-account',
        apiKeyId: 'key-usd',
        cliType: 'claude_code',
      }),
    ).rejects.toThrow('Key owner mismatch')
    await expect(
      api.terminal.getLaunchPreview({
        projectId: 'unsupported-project',
        apiKeyId: 'key-usd',
        cliType: 'claude_code',
      }),
    ).rejects.toThrow('Project launch previews are unavailable')
    await expect(
      api.terminal.getLaunchPreview({ apiKeyId: 'key-usd', cliType: 'codex' }),
    ).rejects.toThrow('Unsupported terminal client')
    await expect(
      fixture('error').api.terminal.getLaunchPreview({
        apiKeyId: 'key-usd',
        cliType: 'claude_code',
      }),
    ).rejects.toThrow('[fixture:error] terminal.getLaunchPreview')
    expect(diagnostics.violations).toEqual([])
    expect(() => api.terminal.launch('unsupported-project')).toThrow(
      'Unimplemented API: terminal.launch',
    )
    expect(() => api.terminal.launchWithPath('/fixture/never-open')).toThrow(
      'Unimplemented API: terminal.launchWithPath',
    )
    expect(() => api.terminal.prepareGrokConfig('key-usd')).toThrow(
      'Unimplemented API: terminal.prepareGrokConfig',
    )
    expect(diagnostics.violations).toHaveLength(3)
  })

  it('clones all data and keeps settings/provider/key/route mutations per fixture', async () => {
    const first = fixture().api
    const second = fixture().api
    const providers = await first.provider.list()
    providers[0].name = 'outside mutation'
    expect((await first.provider.list())[0].name).not.toBe('outside mutation')
    await first.provider.update({ id: 'provider-usd', name: 'Edited locally' })
    await first.apiKey.update({ id: 'key-usd', alias: 'Local key' })
    await first.settings.update({ proxyPort: 19000 })
    await first.managedInstances.updateAssignment({
      id: 'instance-1',
      providerId: 'provider-account',
      apiKeyId: 'key-account',
    })
    expect((await first.provider.get('provider-usd'))?.name).toBe('Edited locally')
    expect((await first.settings.get()).proxyPort).toBe(19000)
    expect((await second.provider.get('provider-usd'))?.name).not.toBe('Edited locally')
    expect((await second.settings.get()).proxyPort).toBe(12345)
    expect((await second.managedInstances.get('instance-1'))?.apiKeyId).toBe('key-usd')
  })

  it('supports empty-resource creation without any shared or real state', async () => {
    const { api } = fixture('empty')
    expect(await api.provider.list()).toEqual([])
    expect(await api.gateway.list()).toEqual([])
    expect(await api.managedInstances.list()).toEqual([])
    expect(await api.requestLog.getOverview()).toEqual({
      todayTokens: 0,
      todayRequests: 0,
      todayFailedRequests: 0,
    })
    const provider = await api.provider.create({
      name: 'Synthetic new provider',
      baseUrl: 'https://new.fixture.invalid',
    })
    const key = await api.apiKey.create({
      providerId: provider.id,
      value: 'fixture-not-a-secret',
      types: ['codex'],
    })
    expect((await api.desktopConnection.apply('codex', provider.id, key.id)).configChanged).toBe(
      true,
    )
    expect(await fixture('empty').api.provider.list()).toEqual([])
  })

  it.each([undefined, 'stale-form-id'])(
    'assigns stable server IDs to form-shaped creates with incoming id=%s',
    async (incomingId) => {
      const { api, diagnostics } = fixture('empty')
      // ProviderModal emits id: undefined on create; structural typing does not strip it.
      const providerInput = {
        id: incomingId,
        name: 'Created through the route picker',
        baseUrl: 'https://new.fixture.invalid',
        icon: undefined,
        walletBalanceScript: undefined,
        queryConfig: undefined,
        defaultKeyConfig: undefined,
        isActive: true,
      }
      const provider = await api.provider.create(providerInput)
      expect(provider.id).toMatch(/^fixture-provider-\d+$/)
      expect(provider.id).not.toBe(incomingId)
      expect((await api.provider.get(provider.id))?.id).toBe(provider.id)
      expect(await api.provider.list()).toEqual([provider])
      expect(await api.provider.getModelCatalog(provider.id)).toEqual({
        models: [],
        revision: 0,
        updatedAt: null,
      })
      expect((await api.provider.create(providerInput)).id).not.toBe(provider.id)

      const keyInput = {
        id: incomingId,
        providerId: provider.id,
        value: 'fixture-not-a-secret',
        types: ['codex' as const],
      }
      const key = await api.apiKey.create(keyInput)
      expect(key.id).toMatch(/^fixture-key-\d+$/)
      expect(key.id).not.toBe(incomingId)
      expect(await api.apiKey.list(provider.id)).toEqual([key])
      expect((await api.apiKey.create(keyInput)).id).not.toBe(key.id)
      expect(await api.desktopConnection.apply('codex', provider.id, key.id)).toMatchObject({
        completion: 'complete',
        configChanged: true,
        state: { route: { providerId: provider.id, apiKeyId: key.id } },
      })
      expect((await api.desktopConnection.state('codex')).route).toEqual({
        providerId: provider.id,
        apiKeyId: key.id,
      })
      const gateway = await api.gateway.create('Created gateway', provider.id, key.id)
      expect(gateway.sessionToken).toMatch(/^fixture-gateway-\d+$/)
      expect(await api.gateway.list()).toEqual([gateway])
      expect(diagnostics.violations).toEqual([])
    },
  )

  it('does not silently turn synthetic read/mutation errors into empty success', async () => {
    const { api, diagnostics } = fixture('error')
    await expect(api.provider.list()).rejects.toThrow('[fixture:error]')
    await expect(api.requestLog.getOverview()).rejects.toThrow('[fixture:error]')
    await expect(api.requestLog.syncAntigravity()).rejects.toThrow('[fixture:error]')
    await expect(api.desktopConnection.restore('codex')).rejects.toThrow('[fixture:error]')
    expect(diagnostics.violations).toEqual([])
  })

  it('merges both Antigravity sources and scopes performance summaries by source', async () => {
    const { api, emitAntigravityUpdated } = fixture()
    // Unfiltered scope mixes proxy latency with Antigravity generation time.
    const mixed = await api.requestLog.getStatistics('week')
    expect(mixed.summary.performanceMixedSources).toBe(true)
    expect(mixed.summary.avgLatencyMs).toBeNull()
    expect(mixed.summary.avgFirstTokenMs).toBeNull()
    expect(mixed.summary.avgOutputTokensPerSecond).toBeNull()

    // One source family keeps its own exact averages.
    for (const source of ['proxy', 'antigravity_desktop', 'antigravity_cli'] as const) {
      const scoped = await api.requestLog.getStatistics('week', { source })
      expect(scoped.summary.performanceMixedSources).toBe(false)
      expect(scoped.summary.avgLatencyMs).not.toBeNull()
      expect(scoped.summary.avgFirstTokenMs).not.toBeNull()
      expect(scoped.summary.avgOutputTokensPerSecond).not.toBeNull()
    }

    const cli = await api.requestLog.getRecentPaginated('week', 1, 100, {
      source: 'antigravity_cli',
    })
    expect(cli.total).toBeGreaterThan(0)
    expect(cli.items.every((row) => row.source === 'antigravity_cli')).toBe(true)
    expect(cli.items.every((row) => row.thinkingTokens != null && row.responseTokens != null)).toBe(
      true,
    )
    const proxy = await api.requestLog.getRecentPaginated('week', 1, 100, { source: 'proxy' })
    expect(proxy.items.every((row) => row.source === 'proxy')).toBe(true)
    await expect(
      api.requestLog.getStatistics('week', { source: 'unknown' as never }),
    ).rejects.toThrow('Invalid ledger source')

    // The two bridge methods exist in fixture mode: a no-op scan plus a listener.
    expect(await api.requestLog.syncAntigravity()).toEqual({
      scannedFiles: 2,
      updatedConversations: 0,
      removedFiles: 0,
    })
    const listener = vi.fn()
    const dispose = api.requestLog.onAntigravityUpdated(listener)
    emitAntigravityUpdated({ scannedFiles: 3, updatedConversations: 1, removedFiles: 0 })
    expect(listener).toHaveBeenCalledWith({
      scannedFiles: 3,
      updatedConversations: 1,
      removedFiles: 0,
    })
    dispose()
    emitAntigravityUpdated({ scannedFiles: 4, updatedConversations: 2, removedFiles: 0 })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('exercises typed route-only, config-write, restore and partial desktop outcomes', async () => {
    const { api } = fixture('routeOnly')
    const before = await api.desktopConnection.state('codex')
    const result = await api.desktopConnection.apply('codex', 'provider-account', 'key-account')
    expect(result).toMatchObject({
      action: 'switch_route',
      routeChanged: true,
      configChanged: false,
      nextAction: 'none',
    })
    expect(result.state.lastConfigChange).toEqual(before.lastConfigChange)
    const changed = await fixture('configChanged').api.desktopConnection.apply(
      'codex',
      'provider-account',
      'key-account',
    )
    expect(changed).toMatchObject({
      completion: 'complete',
      configChanged: true,
      nextAction: 'reopen_client',
    })
    expect(await api.desktopConnection.restore('codex')).toMatchObject({
      action: 'restore',
      configChanged: true,
      nextAction: 'reopen_client',
      state: { status: 'official' },
    })
    const partial = fixture('partial').api
    expect(
      await partial.desktopConnection.apply('codex', 'provider-account', 'key-account'),
    ).toMatchObject({
      completion: 'partial',
      routeChanged: true,
      configChanged: false,
      state: { syncFailure: { source: 'user' } },
    })
    await partial.apiKey.update({ id: 'key-usd', alias: 'Saved successfully' })
    expect((await partial.apiKey.list('provider-usd'))[0].alias).toBe('Saved successfully')
    expect((await partial.desktopConnection.state('claude_desktop')).syncFailure?.source).toBe(
      'key_edit',
    )
  })

  it('preserves gateway connection config and validates route eligibility', async () => {
    const { api } = fixture()
    const before = (await api.gateway.list())[0]
    const after = await api.gateway.update(before.sessionToken, {
      providerId: 'provider-account',
      apiKeyId: 'key-account',
    })
    expect(after.connectionConfig).toEqual(before.connectionConfig)
    await expect(
      api.desktopConnection.apply('codex', 'provider-usd', 'key-exhausted'),
    ).rejects.toThrow('incompatible')
    await expect(
      api.managedInstances.updateAssignment({
        id: 'instance-1',
        providerId: 'provider-tokens',
        apiKeyId: 'key-unknown',
      }),
    ).rejects.toThrow('incompatible')
  })

  it('provides a full year, scoped pre-pagination totals and distinct failed/usage populations', async () => {
    const { api } = fixture()
    expect(await api.requestLog.getDailyTrend(365)).toHaveLength(365)
    const scope = { providerId: 'provider-usd' }
    const first = await api.requestLog.getRecentPaginated('today', 1, 20, scope)
    const second = await api.requestLog.getRecentPaginated('today', 2, 20, scope)
    expect(first.total).toBe(35)
    expect(first.items).toHaveLength(20)
    expect(second.items).toHaveLength(15)
    expect(
      [...first.items, ...second.items].every(
        (row) => row.providerName === 'Aurora · USD 密钥额度',
      ),
    ).toBe(true)
    const usage = await api.requestLog.getRecentPaginated('today', 1, 100, {
      population: 'with_usage',
    })
    const failed = await api.requestLog.getRecentPaginated('today', 1, 100, { outcome: 'failed' })
    const overview = await api.requestLog.getOverview()
    expect(usage.total + failed.total).toBe(74)
    expect(overview.todayRequests).toBe(usage.total)
    expect(overview.todayFailedRequests).toBe(failed.total)
    await api.provider.delete('provider-usd')
    await expect(api.requestLog.getRecentPaginated('today', 1, 20, scope)).rejects.toThrow(
      'scope unavailable',
    )
    await expect(api.requestLog.getStatistics('custom:2026-02-30:2026-03-01')).rejects.toThrow(
      'Invalid date',
    )
  })

  it('separates complete active instances from client-limited history', async () => {
    const { api } = fixture()
    const active = await api.managedInstances.list()
    expect(active).toHaveLength(7)
    expect(active.some((item) => item.cliType === 'claude')).toBe(true)
    expect(active.some((item) => item.status === 'stale')).toBe(true)
    expect(
      (await api.managedInstances.list('claude_code')).some((item) => item.status === 'stopped'),
    ).toBe(true)
  })

  it('keeps exact retained request projection beyond the 500-event buffer and clears generation', async () => {
    const { api, emit } = fixture()
    const recent = await api.console.readRecent(['app', 'daemon'], 500)
    expect(recent.records).toHaveLength(500)
    expect(recent.records.some((record) => record.event.category === 'request')).toBe(false)
    const exact = await api.console.readRequest('request-1', 500)
    expect(exact.records).toHaveLength(1)
    const listener = vi.fn()
    const unlisten = api.console.onEvent(listener)
    emit(exact.records[0].event)
    expect(listener).toHaveBeenCalledOnce()
    unlisten()
    emit(exact.records[0].event)
    expect(listener).toHaveBeenCalledOnce()
    await api.console.clearHistory()
    const cleared = await api.console.readRequest('request-1')
    expect(cleared.records).toEqual([])
    expect(cleared.generation).not.toBe(exact.generation)
  })

  it.each([false, true])(
    'timestamps Desktop facts as RFC3339 with pinned clock=%s',
    async (pinned) => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(now)
        const { api } = createFixtureApi({ scenario: 'partial', ...(pinned ? { now } : {}) })
        expect((await api.desktopConnection.state('codex')).lastConfigChange?.changedAt).toBe(
          now.toISOString(),
        )
        const later = new Date(now.getTime() + 65_000)
        vi.setSystemTime(later)
        const expected = (pinned ? now : later).toISOString()
        await api.apiKey.update({ id: 'key-usd', alias: 'Saved after preview startup' })
        const failure = (await api.desktopConnection.state('codex')).syncFailure!
        expect(failure.source).toBe('key_edit')
        expect(failure.occurredAt).toBe(expected)
        expect(Date.parse(failure.occurredAt)).toBe((pinned ? now : later).getTime())
        const result = await api.desktopConnection.apply('codex', 'provider-usd', 'key-fixed')
        expect(result.updatedAt).toBe(expected)
        expect(result.state.syncFailure?.occurredAt).toBe(expected)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it.each(['default', 'partial', 'quotaError'] as const)(
    'keeps enabled queries valid for untouched key/provider edits in %s',
    async (scenario) => {
      const { api, diagnostics } = fixture(scenario)
      const providers = await api.provider.list()
      const keys = (await Promise.all(providers.map((p) => api.apiKey.list(p.id)))).flat()
      const accountQueries = providers.filter(
        (p) => effectiveQuery(p.queryConfig, p.walletBalanceScript)?.enabled,
      )
      const keyQueries = keys.filter((k) => effectiveQuery(k.queryConfig, k.usageScript)?.enabled)
      expect(accountQueries).toHaveLength(1)
      expect(keyQueries).toHaveLength(1)

      for (const provider of accountQueries) {
        const scheme = (await api.balance.schemes('account')).find(
          (s) => s.id === provider.queryConfig?.schemeId,
        )
        expect(scheme).toBeDefined()
        expect(provider.walletBalanceScript?.trim()).toBeTruthy()
        expect(provider.walletBalanceScript).toBe(scheme?.script)
        expect(providerQueryMissingCredential(provider, keys)).toBeNull()
        await api.balance.checkScript(provider.walletBalanceScript!, provider.baseUrl)
        const saved = await api.provider.update({
          id: provider.id,
          name: 'Edited account name only',
          walletBalanceScript: provider.walletBalanceScript!,
          queryConfig: provider.queryConfig!,
        })
        expect(saved).toMatchObject({
          name: 'Edited account name only',
          queryConfig: provider.queryConfig,
          walletBalanceScript: provider.walletBalanceScript,
        })
      }
      for (const key of keyQueries) {
        const scheme = (await api.balance.schemes('key')).find(
          (s) => s.id === key.queryConfig?.schemeId,
        )
        expect(scheme).toBeDefined()
        // KeyEditModal blocks enabled + empty text before it can call apiKey.update.
        const script = key.usageScript?.trim() ?? ''
        expect(script).not.toBe('')
        expect(script).toBe(scheme?.script)
        await api.balance.checkScript(script, 'https://provider.fixture.invalid/v1')
        const saved = await api.apiKey.update({
          id: key.id,
          alias: 'Edited alias only',
          usageScript: script,
          queryConfig: key.queryConfig!,
        })
        expect(saved).toMatchObject({
          alias: 'Edited alias only',
          queryConfig: key.queryConfig,
          usageScript: key.usageScript,
          cachedUsage: key.cachedUsage,
        })
      }
      if (scenario === 'quotaError') {
        expect(await api.keyUsage.refresh('key-usd')).toMatchObject({
          error: expect.any(String),
          usage: keyQueries[0].cachedUsage,
        })
        expect((await api.balance.refresh('provider-account')).error).toEqual(expect.any(String))
        expect((await api.provider.get('provider-account'))?.cachedUsage).toEqual(
          accountQueries[0].cachedUsage,
        )
      }
      if (scenario === 'partial') {
        expect((await api.desktopConnection.state('codex')).syncFailure?.source).toBe('key_edit')
      }
      expect(diagnostics.calls).toContain('apiKey.update')
      expect(diagnostics.violations).toEqual([])
    },
  )

  it('ships isolated request/extractor scheme scripts without executing queries', async () => {
    const { api } = fixture()
    const schemes = await api.balance.schemes()
    expect(schemes).toHaveLength(2)
    for (const scheme of schemes) {
      // Evaluate only bundled synthetic text, in a VM with no I/O capabilities.
      const definition = runInNewContext(scheme.script, {}, { timeout: 100 })
      const credential = scheme.scope === 'key' ? 'apiKey' : 'accessToken'
      expect(definition.request).toEqual({
        url: `https://query.fixture.invalid/${scheme.scope}`,
        method: 'GET',
        headers: { Authorization: `Bearer {{${credential}}}` },
      })
      expect(typeof definition.extractor).toBe('function')
      const usage = { unit: 'USD', remaining: 71.75 }
      expect(definition.extractor(usage)).toEqual(usage)
      expect(scheme.credentialRequirements).toEqual([credential])
      expect(scheme.supportsWindows).toBe(scheme.scope === 'account')
    }
    const original = schemes[0].script
    schemes[0].script = 'outside mutation'
    expect((await api.balance.schemes())[0].script).toBe(original)
  })

  it('includes multi-window account quotas, unknown/stale snapshots and query failures', async () => {
    const { api } = fixture('stale')
    const account = await api.provider.get('provider-account')
    expect(account?.queryScope).toBe('account')
    expect(account?.cachedUsage?.windows).toHaveLength(3)
    expect(account?.lastBalanceCheckedAt).toBe(
      new Date(now.getTime() - 5 * 86_400_000).toISOString().slice(0, 19).replace('T', ' '),
    )
    expect(
      (await api.apiKey.list('provider-tokens')).find((key) => key.id === 'key-unknown')
        ?.cachedUsage,
    ).toBeNull()
    await expect(api.keyUsage.refresh('key-account')).rejects.toThrow('belongs to the account')
    expect((await fixture('quotaError').api.keyUsage.refresh('key-usd')).error).toContain(
      'previous cache retained',
    )
  })

  it('accepts only documented scenarios', () => {
    for (const scenario of scenarios) expect(parseScenario(`?scenario=${scenario}`)).toBe(scenario)
    expect(parseScenario('')).toBe('default')
    expect(() => parseScenario('?scenario=typo')).toThrow('Unknown scenario')
  })
})
