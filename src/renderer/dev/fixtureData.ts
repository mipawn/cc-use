import type {
  ApiKey,
  ClientModel,
  ConsoleLogRecordRef,
  DesktopConnectionState,
  DesktopClientKind,
  Gateway,
  GlobalSettings,
  ManagedInstance,
  Provider,
  RecentRequestLogDisplay,
} from '@shared/types'
import { localDay, utcTimestamp, type FixtureScenario } from './fixtureSupport'

// Persist exactly the catalogue text: enabled queries require a real script document.
// These inert request definitions are only displayed; fixture query APIs never send them.
export const fixtureQueryScripts = {
  account: `({
  request: {
    url: "https://query.fixture.invalid/account",
    method: "GET",
    headers: { Authorization: "Bearer {{accessToken}}" }
  },
  extractor: function (response) { return response }
})`,
  key: `({
  request: {
    url: "https://query.fixture.invalid/key",
    method: "GET",
    headers: { Authorization: "Bearer {{apiKey}}" }
  },
  extractor: function (response) { return response }
})`,
}

export const fixtureModels: ClientModel[] = [
  { id: 'claude-sonnet-5', displayName: 'Claude Sonnet · fixture', supports1m: true },
  { id: 'gpt-fixture', displayName: 'GPT · fixture' },
  { id: 'grok-fixture', displayName: 'Grok · fixture' },
]
export function makeProvider(id: string, name: string, extra: Partial<Provider> = {}): Provider {
  return {
    id,
    name,
    baseUrl: 'https://provider.fixture.invalid/v1',
    httpProxy: null,
    website: null,
    remark: 'Synthetic preview only / 仅合成数据',
    token: null,
    icon: null,
    walletBalanceType: 'none',
    walletBalanceUrl: null,
    walletBalancePath: null,
    walletBalanceHeaders: null,
    walletBalanceUserId: null,
    cachedWalletBalance: null,
    cachedWalletBalanceCurrency: null,
    lastBalanceCheckedAt: null,
    usageType: 'none',
    usageUrl: null,
    usagePath: null,
    usageHeaders: null,
    cachedUsage: null,
    lastUsageCheckedAt: null,
    isActive: true,
    sortOrder: 0,
    presetId: 'custom',
    defaultKeyConfig: null,
    requestAdapter: '',
    responsesRectifier: false,
    walletBalanceScript: null,
    requestHeaders: null,
    queryConfig: null,
    queryScope: 'key',
    ...extra,
  }
}
export function makeKey(
  id: string,
  providerId: string,
  alias: string,
  extra: Partial<ApiKey> = {},
): ApiKey {
  return {
    id,
    providerId,
    alias,
    value: `fixture-not-a-secret-${id}`,
    types: ['claude_code', 'grok', 'codex', 'claude_desktop'],
    priority: 0,
    isExhausted: false,
    isActive: true,
    usageType: 'none',
    usageUrl: null,
    usagePath: null,
    usageHeaders: null,
    usageScript: null,
    queryConfig: null,
    cachedUsage: null,
    lastUsageCheckedAt: null,
    modelMapping: null,
    cooldownUntil: null,
    lastErrorAt: null,
    lastErrorKind: null,
    consecutiveErrors: 0,
    ...extra,
  }
}
export interface LedgerRow extends RecentRequestLogDisplay {
  providerId: string
  apiKeyId: string
  instanceId: string
}
export function seedFixture(scenario: FixtureScenario, now: Date) {
  const stamp = utcTimestamp(now)
  const stale = utcTimestamp(new Date(now.getTime() - 5 * 86_400_000))
  const quotaStamp = scenario === 'stale' ? stale : stamp
  const providers: Provider[] = [
    makeProvider('provider-usd', 'Aurora · USD 密钥额度', { sortOrder: 0 }),
    makeProvider('provider-account', '共享账户 · CNY 多窗口', {
      queryScope: 'account',
      sortOrder: 1,
      walletBalanceType: 'custom',
      walletBalanceScript: fixtureQueryScripts.account,
      token: 'fixture-not-a-secret-account-token',
      cachedWalletBalance: 128.5,
      cachedWalletBalanceCurrency: 'CNY',
      lastBalanceCheckedAt: quotaStamp,
      queryConfig: { enabled: true, schemeId: 'fixture-account' },
      cachedUsage: {
        unit: 'CNY',
        remaining: 128.5,
        windows: [
          { id: '5h', label: '5 hours', usedPercent: 63, resetsAt: stamp, status: 'active' },
          { id: 'week', label: 'Weekly', usedPercent: 22, resetsAt: null, status: 'active' },
          { id: 'month', label: 'Monthly', usedPercent: null, resetsAt: null, status: null },
        ],
      },
      lastUsageCheckedAt: quotaStamp,
    }),
    makeProvider(
      'provider-tokens',
      'Token 计量 / 极长供应商名称用于紧凑窗口验证 Long provider name',
      { sortOrder: 2 },
    ),
    makeProvider('provider-disabled', '停用供应商', { isActive: false, sortOrder: 3 }),
  ]
  const keys: ApiKey[] = [
    makeKey('key-usd', 'provider-usd', '工作主线路', {
      cachedUsage: { unit: 'USD', total: 100, used: 28.25, remaining: 71.75 },
      lastUsageCheckedAt: quotaStamp,
      usageType: 'custom',
      usageScript: fixtureQueryScripts.key,
      queryConfig: { enabled: true, schemeId: 'fixture-key' },
    }),
    makeKey('key-fixed', 'provider-usd', '固定上游模型', {
      modelMapping: JSON.stringify({
        version: 2,
        clients: {
          codex: {
            catalog: {
              mode: 'custom',
              models: [{ id: 'friendly-model', displayName: 'Friendly model' }],
            },
            forward: { mode: 'fixed', model: 'gpt-fixture' },
          },
        },
      }),
    }),
    makeKey('key-account', 'provider-account', '共享账户额度（非独立额度）'),
    makeKey('key-tokens', 'provider-tokens', 'Token 包', {
      cachedUsage: { unit: 'tokens', total: 1_000_000, used: 450_000, remaining: 550_000 },
      lastUsageCheckedAt: quotaStamp,
    }),
    makeKey('key-unknown', 'provider-tokens', '未知额度 ≠ 0', { types: ['grok'] }),
    makeKey('key-exhausted', 'provider-usd', '额度耗尽', {
      isExhausted: true,
      cachedUsage: { unit: 'USD', total: 10, used: 10, remaining: 0 },
      lastUsageCheckedAt: quotaStamp,
    }),
    makeKey('key-disabled', 'provider-usd', '已停用密钥', { isActive: false }),
    makeKey('key-provider-disabled', 'provider-disabled', '供应商不可用'),
  ]
  const instances: ManagedInstance[] = Array.from({ length: 112 }, (_, i) => ({
    id: `instance-${i + 1}`,
    sessionToken: `fixture-session-${i + 1}`,
    projectId: null,
    providerId: i % 2 ? 'provider-account' : 'provider-usd',
    apiKeyId: i % 2 ? 'key-account' : 'key-usd',
    cliType: i === 0 ? 'claude' : i % 2 ? 'grok' : 'claude_code',
    terminalType: 'terminal',
    projectPath: i < 3 ? '/fixture/workspaces/cc-use' : `/fixture/workspaces/sample-${i + 1}`,
    shellPid: null,
    processPid: null,
    status:
      i === 2 || (scenario === 'stale' && i === 0)
        ? 'stale'
        : i === 3
          ? 'launching'
          : i < 7
            ? 'running'
            : i % 8 === 0
              ? 'failed'
              : 'stopped',
    assignmentSource: 'fixture',
    lastSeenAt: i === 2 ? stale : stamp,
    launchedAt: utcTimestamp(new Date(now.getTime() - (112 - i) * 86_400_000)),
    stoppedAt: i < 7 ? null : stamp,
    stopReason: i < 7 ? null : 'fixture exit',
    exitCode: i < 7 ? null : 0,
  }))
  const gateways: Gateway[] = [
    {
      sessionToken: 'fixture-gateway-token',
      displayName: '本地出口 · 合成数据',
      providerId: 'provider-usd',
      providerName: providers[0].name,
      apiKeyId: 'key-usd',
      keyAlias: keys[0].alias,
      isActive: true,
      createdAt: stamp,
      lastSeenAt: stamp,
      connectionConfig: { authScheme: 'bearer', baseUrl: null, userAgent: 'fixture-gateway' },
      modelPolicy: { mode: 'selected', modelIds: ['claude-sonnet-5', 'legacy-missing-model'] },
    },
  ]
  // Today spans multiple pages; the remaining rows populate two years of heatmaps.
  const ledger: LedgerRow[] = Array.from({ length: 810 }, (_, i): LedgerRow => {
    const date = new Date(now)
    date.setDate(date.getDate() - (i < 70 ? 0 : i - 69))
    date.setHours(12, i % 60, 0, 0)
    const failed = i % 9 === 0
    const providerId = i % 2 ? 'provider-account' : 'provider-usd'
    return {
      id: `log-${i + 1}`,
      requestId: `request-${i + 1}`,
      providerId,
      apiKeyId: i % 2 ? 'key-account' : 'key-usd',
      instanceId: `instance-${(i % 2) + 1}`,
      model: i % 2 ? 'grok-fixture' : 'claude-sonnet-5',
      keyAlias: i % 2 ? keys[2].alias : keys[0].alias,
      providerName: providers[i % 2].name,
      projectName: 'cc-use',
      inputTokens: failed ? 0 : 500 + i * 13,
      outputTokens: failed ? 0 : 120 + i,
      cacheReadTokens: failed ? 0 : (i % 3) * 90,
      cacheCreationTokens: failed ? 0 : 20,
      latencyMs: 1200 + i,
      firstTokenMs: failed ? null : 220,
      outputTokensPerSecond: failed ? null : 45,
      statusCode: failed ? 502 : 200,
      outcome: failed ? 'upstream_error' : 'success',
      errorMessage: failed ? 'Synthetic upstream failure' : null,
      createdAt: utcTimestamp(date),
    }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const history: ConsoleLogRecordRef[] = [
    {
      source: 'daemon',
      epoch: 'fixture',
      seq: 0,
      at: stamp,
      id: 'old-retained-request',
      event: {
        category: 'request',
        requestId: 'request-1',
        timestamp: stamp,
        method: 'POST',
        path: '/v1/messages',
        status: 502,
        latencyMs: 1200,
        upstream: 'https://provider.fixture.invalid/v1/messages',
        model: 'claude-sonnet-5',
        provider: providers[0].name,
        keyAlias: keys[0].alias,
        kind: 'error',
        message: 'Synthetic upstream failure',
      },
    },
    ...Array.from(
      { length: 540 },
      (_, i): ConsoleLogRecordRef => ({
        source: i % 2 ? 'app' : 'daemon',
        epoch: 'fixture',
        seq: i + 1,
        at: stamp,
        id: `fixture-log-${i}`,
        event: {
          category: 'log',
          id: `fixture-log-${i}`,
          timestamp: stamp,
          level: i % 12 === 0 ? 'warn' : 'info',
          source: i % 2 ? 'app' : 'daemon',
          target: 'fixture',
          message: `Synthetic runtime event ${i + 1} / 合成运行日志`,
        },
      }),
    ),
  ]
  const desktops = Object.fromEntries(
    (['codex', 'claude_desktop'] as const).map((clientKind) => {
      const official = scenario === 'official' || scenario === 'empty'
      const state: DesktopConnectionState = {
        clientKind,
        status: official
          ? 'official'
          : scenario === 'notFound'
            ? 'not_found'
            : scenario === 'unknown'
              ? 'unknown'
              : 'taken_over',
        route: official ? null : { providerId: 'provider-usd', apiKeyId: 'key-usd' },
        lastConfigChange: official
          ? null
          : { action: 'takeover', source: 'user', changedAt: now.toISOString(), version: 1 },
        syncFailure: null,
        warning: scenario === 'unknown' ? 'Synthetic state read unavailable' : null,
      }
      return [clientKind, state]
    }),
  ) as Record<DesktopClientKind, DesktopConnectionState>
  const settings: GlobalSettings = {
    defaultProviderType: 'claude_code',
    proxyPort: 12345,
    proxyListenScope: 'loopback',
    defaultTerminalType: 'terminal',
    closeToTray: true,
    daemonEnabled: true,
  }
  return {
    providers: scenario === 'empty' ? [] : providers,
    keys: scenario === 'empty' ? [] : keys,
    instances: scenario === 'empty' ? [] : instances,
    gateways: scenario === 'empty' ? [] : gateways,
    ledger: scenario === 'empty' ? [] : ledger,
    history: scenario === 'empty' || scenario === 'consoleEmpty' ? [] : history,
    desktops,
    settings,
    retentionStartDate: localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2)),
  }
}
