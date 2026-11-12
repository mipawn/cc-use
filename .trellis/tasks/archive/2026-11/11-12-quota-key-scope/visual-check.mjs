/**
 * Synthetic-data visual verification for the quota key-scope change.
 *
 * Serves the built `dist/` through `vite preview`, stubs Tauri IPC with
 * generated provider/key records (no real credential, database, or network),
 * and captures the screens this change touches. Every non-loopback request is
 * blocked.
 *
 * Usage (from repo root):
 *   pnpm exec vite build
 *   pnpm exec vite preview --port 4173 --strictPort &
 *   node .trellis/tasks/11-12-quota-key-scope/visual-check.mjs
 */
import { chromium } from '/Users/dongzhan/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.mjs'
import { mkdirSync } from 'node:fs'

const BASE = process.env.VISUAL_BASE_URL ?? 'http://127.0.0.1:4173'
const EVIDENCE =
  process.env.VISUAL_EVIDENCE ?? '.trellis/tasks/11-12-quota-key-scope/evidence'
mkdirSync(EVIDENCE, { recursive: true })
/** When set, also refresh the repository's README screenshots here. */
const README_DIR = process.env.VISUAL_README_DIR ?? ''

const GO_SCRIPT = `({
  request: {
    url: "{{baseUrl}}/v1/usage",
    method: "GET",
    headers: { Authorization: "Bearer {{apiKey}}" }
  },
  extractor: function (response) {
    var usage = response.usage
    var ids = Object.keys(usage)
    var windows = []
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i]
      windows.push({ id: id, usedPercent: usage[id].percent, resetsAt: usage[id].resets_at })
    }
    return { windows: windows }
  }
})`

const CC_SCRIPT = `({
  requests: {
    credit: {
      url: "https://api.commandcode.ai/alpha/billing/credits",
      method: "GET",
      headers: { Authorization: "Bearer {{apiKey}}" }
    },
    subscription: {
      url: "https://api.commandcode.ai/alpha/billing/subscriptions",
      method: "GET",
      headers: { Authorization: "Bearer {{apiKey}}" },
      optional: true
    },
    summary: {
      url: "https://api.commandcode.ai/alpha/usage/summary",
      method: "GET",
      headers: { Authorization: "Bearer {{apiKey}}" },
      optional: true
    }
  },
  extractor: function (responses) {
    return { remaining: 1, unit: "credits" }
  }
})`

const KEY_SCRIPT = `({
  request: {
    url: "{{baseUrl}}/api/usage/token/",
    method: "GET",
    headers: { Authorization: "Bearer {{apiKey}}" }
  },
  extractor: function (response) {
    return { remaining: response.data.total_available, unit: "USD" }
  }
})`

const DS_SCRIPT = `({
  request: {
    url: "{{baseUrl}}/api/user/balance",
    method: "GET",
    headers: { Authorization: "Bearer {{apiKey}}" }
  },
  extractor: function (response) { return { remaining: response.balance } }
})`

const NOW = '2026-11-12T12:00:00Z'
const usageWindow = (id, label, percent, resetsAt) => ({
  id,
  label,
  usedPercent: percent,
  resetsAt,
  status: 'ok',
})

const providerBase = {
  httpProxy: null,
  website: null,
  remark: null,
  token: null,
  walletBalanceUserId: null,
  cachedWalletBalance: null,
  cachedWalletBalanceCurrency: null,
  lastBalanceCheckedAt: null,
  lastUsageCheckedAt: null,
  cachedUsage: null,
  walletBalanceScript: null,
  queryConfig: null,
  usageType: 'none',
  usageUrl: null,
  usagePath: null,
  usageHeaders: null,
  walletBalanceType: 'none',
  walletBalanceUrl: null,
  walletBalancePath: null,
  walletBalanceHeaders: null,
  requestHeaders: null,
  requestAdapter: 'none',
  defaultKeyConfig: null,
  isActive: true,
}

const providers = [
  {
    ...providerBase,
    id: 'p-go',
    name: 'opencode go',
    baseUrl: 'https://opencode.ai/zen/go',
    icon: 'claude',
    presetId: 'opencode-go',
    queryScope: 'key',
    sortOrder: 0,
  },
  {
    ...providerBase,
    id: 'p-cc',
    name: 'command code',
    baseUrl: 'https://api.commandcode.ai/provider',
    icon: 'claude',
    presetId: 'command-code',
    queryScope: 'key',
    sortOrder: 1,
  },
  {
    ...providerBase,
    id: 'p-ds',
    name: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    icon: 'deepseek',
    presetId: 'deepseek',
    queryScope: 'account',
    walletBalanceScript: DS_SCRIPT,
    queryConfig: { enabled: true, schemeId: 'custom' },
    cachedWalletBalance: 12.34,
    cachedWalletBalanceCurrency: 'CNY',
    cachedUsage: { remaining: 12.34, unit: 'CNY', windows: [] },
    lastUsageCheckedAt: NOW,
    sortOrder: 2,
  },
  {
    ...providerBase,
    id: 'p-na',
    name: '中转供应商',
    baseUrl: 'https://anyrouter.example.com',
    icon: 'newapi',
    presetId: 'newapi',
    queryScope: 'account',
    sortOrder: 3,
  },
]

const keyBase = {
  types: ['claude_code'],
  config: null,
  modelMapping: null,
  clientConfigs: {},
  isActive: true,
  isExhausted: false,
  lastUsageCheckedAt: null,
  cachedUsage: null,
  usageScript: null,
  queryConfig: null,
  cooldownUntil: null,
  lastErrorAt: null,
  lastErrorKind: null,
  consecutiveErrors: 0,
}

const keys = [
  {
    ...keyBase,
    id: 'k-go-1',
    providerId: 'p-go',
    alias: '工作账号',
    value: 'sk-synthetic-go-1',
    priority: 0,
    types: ['claude_code', 'codex'],
    usageScript: GO_SCRIPT,
    queryConfig: { enabled: true, schemeId: 'opencode-go-key' },
    lastUsageCheckedAt: NOW,
    cachedUsage: {
      windows: [
        usageWindow('rolling', '5h', 0, '2026-11-12T17:15:00Z'),
        usageWindow('weekly', 'Weekly', 36, '2026-11-16T00:00:00Z'),
        usageWindow('monthly', 'Monthly', 96, '2026-11-14T02:00:00Z'),
      ],
    },
  },
  {
    ...keyBase,
    id: 'k-go-2',
    providerId: 'p-go',
    alias: '备用账号',
    value: 'sk-synthetic-go-2',
    priority: 1,
    types: ['claude_code', 'codex'],
    usageScript: GO_SCRIPT,
    queryConfig: { enabled: true, schemeId: 'opencode-go-key' },
  },
  {
    ...keyBase,
    id: 'k-cc-1',
    providerId: 'p-cc',
    alias: '个人账号',
    value: 'sk-synthetic-cc-1',
    priority: 0,
    types: ['claude_code', 'codex'],
    usageScript: CC_SCRIPT,
    queryConfig: { enabled: true, schemeId: 'command-code-key' },
    lastUsageCheckedAt: NOW,
    cachedUsage: {
      remaining: 68.16,
      unit: 'credits',
      windows: [
        usageWindow('rolling', 'rolling', 3.24, '2026-11-12T12:41:00Z'),
        usageWindow('weekly', 'weekly', 5.24, '2026-11-19T02:40:00Z'),
        usageWindow('monthly', 'monthly', 2.65, '2026-12-12T02:32:00Z'),
      ],
    },
  },
  {
    ...keyBase,
    id: 'k-cc-2',
    providerId: 'p-cc',
    alias: '测试账号',
    value: 'sk-synthetic-cc-2',
    priority: 1,
    types: ['claude_code', 'codex'],
    usageScript: CC_SCRIPT,
    queryConfig: { enabled: true, schemeId: 'command-code-key' },
    lastUsageCheckedAt: NOW,
    cachedUsage: {
      remaining: 12.5,
      unit: 'credits',
      windows: [
        usageWindow('rolling', 'rolling', 0, '2026-11-12T12:41:00Z'),
        usageWindow('weekly', 'weekly', 1.5, '2026-11-19T02:40:00Z'),
        usageWindow('monthly', 'monthly', 0.8, '2026-12-12T02:32:00Z'),
      ],
    },
  },
  {
    ...keyBase,
    id: 'k-ds-1',
    providerId: 'p-ds',
    alias: '项目账号',
    value: 'sk-synthetic-ds-1',
    priority: 0,
    types: ['claude_code', 'codex', 'claude_desktop'],
  },
  {
    ...keyBase,
    id: 'k-na-1',
    providerId: 'p-na',
    alias: '默认账号',
    value: 'sk-synthetic-na-1',
    priority: 0,
    types: ['claude_code'],
  },
]

const schemes = {
  account: [
    {
      id: 'deepseek-account',
      scope: 'account',
      labelKey: 'querySchemes.deepseekAccount',
      descriptionKey: 'querySchemes.deepseekAccountDescription',
      credentialRequirements: ['apiKey'],
      supportsWindows: false,
      script: DS_SCRIPT,
    },
    {
      id: 'newapi-account',
      scope: 'account',
      labelKey: 'querySchemes.newApiAccount',
      descriptionKey: 'querySchemes.newApiAccountDescription',
      credentialRequirements: ['accessToken', 'userId'],
      supportsWindows: false,
      script: KEY_SCRIPT,
    },
  ],
  key: [
    {
      id: 'newapi-key',
      scope: 'key',
      labelKey: 'querySchemes.newApiKey',
      descriptionKey: 'querySchemes.newApiKeyDescription',
      credentialRequirements: ['apiKey'],
      supportsWindows: false,
      script: KEY_SCRIPT,
    },
    {
      id: 'opencode-go-key',
      scope: 'key',
      labelKey: 'querySchemes.openCodeGoKey',
      descriptionKey: 'querySchemes.openCodeGoKeyDescription',
      credentialRequirements: ['apiKey'],
      supportsWindows: true,
      script: GO_SCRIPT,
    },
    {
      id: 'command-code-key',
      scope: 'key',
      labelKey: 'querySchemes.commandCodeKey',
      descriptionKey: 'querySchemes.commandCodeKeyDescription',
      credentialRequirements: ['apiKey'],
      supportsWindows: true,
      script: CC_SCRIPT,
    },
  ],
}

const presets = [
  {
    id: 'custom',
    defaultName: '',
    baseUrl: '',
    icon: 'custom',
    requiresSiteAddress: false,
    needsAccountCredential: false,
    walletBalanceType: 'none',
    walletBalanceUrl: null,
    walletBalanceHeaders: null,
    walletBalanceScript: null,
    usageType: 'none',
    usageUrl: null,
    usageHeaders: null,
    queryScope: 'account',
    requestAdapter: 'none',
    defaultKeyConfig: { types: ['claude_code'], clientConfigs: {} },
  },
  {
    id: 'deepseek',
    defaultName: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    icon: 'deepseek',
    requiresSiteAddress: false,
    needsAccountCredential: false,
    walletBalanceType: 'deepseek',
    walletBalanceUrl: 'https://api.deepseek.com/user/balance',
    walletBalanceHeaders: '{"Authorization":"Bearer {{apiKey}}"}',
    walletBalanceScript: DS_SCRIPT,
    usageType: 'none',
    usageUrl: null,
    usageHeaders: null,
    queryScope: 'account',
    requestAdapter: 'none',
    defaultKeyConfig: { types: ['claude_code'], clientConfigs: {} },
  },
  {
    id: 'opencode-go',
    defaultName: 'opencode go',
    baseUrl: 'https://opencode.ai/zen/go',
    icon: 'claude',
    requiresSiteAddress: false,
    needsAccountCredential: false,
    walletBalanceType: 'none',
    walletBalanceUrl: null,
    walletBalanceHeaders: null,
    walletBalanceScript: null,
    usageType: 'none',
    usageUrl: null,
    usageHeaders: null,
    queryScope: 'key',
    requestAdapter: 'none',
    defaultKeyConfig: {
      types: ['claude_code', 'codex'],
      clientConfigs: {
        claude_code: { baseUrl: 'https://opencode.ai/zen/go', authScheme: 'x-api-key' },
        codex: { baseUrl: 'https://opencode.ai/zen/go', authScheme: 'bearer' },
      },
    },
  },
  {
    id: 'command-code',
    defaultName: 'command code',
    baseUrl: 'https://api.commandcode.ai/provider',
    icon: 'claude',
    requiresSiteAddress: false,
    needsAccountCredential: false,
    walletBalanceType: 'none',
    walletBalanceUrl: null,
    walletBalanceHeaders: null,
    walletBalanceScript: null,
    usageType: 'none',
    usageUrl: null,
    usageHeaders: null,
    queryScope: 'key',
    requestAdapter: 'none',
    defaultKeyConfig: {
      types: ['claude_code', 'codex'],
      clientConfigs: {},
    },
  },
]

const settings = {
  language: 'zh',
  themeMode: 'light',
  proxyPort: 12345,
  proxyListenScope: 'loopback',
  defaultTerminalType: 'iterm2',
  closeToTray: true,
  daemonEnabled: true,
}

function fixtureScript(fixtures) {
  const { providers, keys, schemes, presets, settings, scripts } = fixtures
  try {
    if (!localStorage.getItem('language')) localStorage.setItem('language', 'zh')
    if (!localStorage.getItem('themeMode')) localStorage.setItem('themeMode', 'light')
  } catch {
    // The first (about:blank) document cannot use localStorage; the real page
    // gets this script again and stores the preference there.
  }
  window.__visualState = { calls: [] }
  const state = window.__visualState
  // Local helper: the module-level one is not visible inside this serialised
  // init script, and `window` is the browser global here.
  const usageWindow = (id, label, usedPercent, resetsAt) => ({
    id,
    label,
    usedPercent,
    resetsAt,
    status: 'ok',
  })
  const stateKeys = keys.map((key) => ({ ...key }))
  const refreshAnswer =
    (answer) =>
    async (args) => {
      const key = stateKeys.find((item) => item.id === args?.keyId)
      if (key) key.cachedUsage = answer
      return { error: null, isValid: true }
    }
  const testAnswer = (input) => {
    if (input?.script === scripts.go) {
      return {
        scope: 'key',
        usage: {
          windows: [
            usageWindow('rolling', '5h', 12, '2026-11-12T17:15:00Z'),
            usageWindow('weekly', 'Weekly', 48, '2026-11-16T00:00:00Z'),
            usageWindow('monthly', 'Monthly', 91, '2026-11-14T02:00:00Z'),
          ],
        },
        isValid: true,
        invalidMessage: null,
        error: null,
      }
    }
    return {
      scope: 'key',
      usage: {
        remaining: 42.5,
        unit: 'credits',
        isUnlimited: false,
        windows: [
          usageWindow('rolling', 'rolling', 7, '2026-11-12T12:41:00Z'),
          usageWindow('weekly', 'weekly', 9, '2026-11-19T02:40:00Z'),
          usageWindow('monthly', 'monthly', 4, '2026-12-12T02:32:00Z'),
        ],
      },
      isValid: true,
      invalidMessage: null,
      error: null,
    }
  }

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback: () => 1,
    unregisterCallback: () => {},
    convertFileSrc: () => '',
    invoke: async (cmd, args) => {
      state.calls.push(cmd)
      if (cmd === 'settings_get') return settings
      if (cmd === 'provider_list') return providers
      if (cmd === 'provider_get') return providers.find((item) => item.id === args?.id) ?? providers[0]
      if (cmd === 'provider_preset_list') return presets
      if (cmd === 'provider_model_catalog_get') return null
      if (cmd === 'api_key_list') {
        const providerId = args?.providerId
        return stateKeys
          .filter((key) => !providerId || key.providerId === providerId)
          .map((key) => ({ ...key }))
      }
      if (cmd === 'api_key_retired_mapping_report') return []
      if (cmd === 'terminal_get_launch_preview') return null
      if (cmd === 'balance_refresh') return { balance: null, isValid: true, error: null }
      if (cmd === 'key_usage_refresh') {
        const keyId = args?.keyId
        const answer =
          keyId === 'k-go-2'
            ? {
                windows: [
                  usageWindow('rolling', '5h', 3, '2026-11-12T17:15:00Z'),
                  usageWindow('weekly', 'Weekly', 22, '2026-11-16T00:00:00Z'),
                  usageWindow('monthly', 'Monthly', 71, '2026-11-14T02:00:00Z'),
                ],
              }
            : keyId?.startsWith('k-cc')
              ? {
                  remaining: 55.25,
                  unit: 'credits',
                  windows: [usageWindow('rolling', 'rolling', 4, null)],
                }
              : null
        return refreshAnswer(answer)(args)
      }
      if (cmd === 'query_schemes') return schemes[args?.scope ?? 'account'] ?? []
      if (cmd === 'query_test') return testAnswer(args?.input)
      if (cmd === 'icon_list') return { preset: [], uploaded: [] }
      if (cmd === 'app_get_version') return '3.18.0'
      if (cmd === 'request_log_get_provider_gateway_metrics') return []
      if (cmd === 'request_log_get_key_token_stats') return []
      if (cmd === 'proxy_status') return { isRunning: false, port: 12345 }
      if (cmd === 'proxy_get_detail_mode') return false
      if (cmd === 'cli_tool_status') return { available: true, installed: true, needsUpdate: false }
      if (cmd === 'statusline_status') return { state: 'notConfigured', available: true }
      if (cmd === 'auto_launch_is_enabled') return false
      if (cmd === 'show_window_get_shortcut') return 'CommandOrControl+Shift+C'
      if (cmd === 'system_get_platform') return 'macos'
      if (cmd === 'codex_config_is_taken_over') return false
      if (cmd === 'claude_desktop_schema_detect') return 'official'
      if (cmd === 'console_log_read_recent')
        return {
          generation: 'visual',
          truncated: false,
          retention: {
            retentionStartDate: '2026-11-10',
            capacityEvicted: false,
            trimmed: false,
            corrupted: 0,
            limited: false,
          },
          records: [],
        }
      if (cmd === 'console_log_status')
        return { dropped: 0, app: { available: true }, daemon: { available: true } }
      if (cmd === 'console_log_append_renderer')
        return { accepted: (args?.records ?? []).length, rejected: 0 }
      if (cmd === 'console_log_clear') return { ok: true, app: true, daemon: true }
      if (cmd === 'plugin:updater|check') return null
      if (cmd?.startsWith('plugin:event|')) return 1
      return []
    },
  }
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const result = { screenshots: [], checks: [], consoleErrors: [], pageErrors: [] }
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: 'zh-CN',
      reducedMotion: 'reduce',
    })
    await context.route('**/*', (route) => {
      const url = route.request().url()
      if (url.startsWith(BASE) || url.startsWith('data:')) return route.continue()
      return route.abort()
    })
    await context.addInitScript(fixtureScript, {
      providers,
      keys,
      schemes,
      presets,
      settings,
      scripts: { go: GO_SCRIPT, cc: CC_SCRIPT, key: KEY_SCRIPT },
    })
    const page = await context.newPage()
    page.on('console', (message) => {
      if (message.type() === 'error') result.consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => result.pageErrors.push(error.message))

    const settle = async () => {
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 120))),
          ),
      )
    }
    const shot = async (name) => {
      const path = `${EVIDENCE}/${name}.png`
      await page.screenshot({ path, scale: 'css', fullPage: false })
      result.screenshots.push(path)
    }
    const check = (name, value) => result.checks.push({ name, value })

    await page.goto(`${BASE}/#/keys`)
    try {
      await page.locator('[data-provider-group]').first().waitFor({ timeout: 15000 })
    } catch (error) {
      console.error('BOOT FAILED')
      console.error('consoleErrors', result.consoleErrors)
      console.error('pageErrors', result.pageErrors)
      console.error('body', (await page.locator('body').innerText()).slice(0, 1200))
      console.error(
        'calls',
        await page.evaluate(() => (window.__visualState?.calls ?? []).slice(0, 40)),
      )
      throw error
    }
    await settle()
    await shot('01-keys')

    const go = page.locator('[data-provider-group="p-go"]')
    const cc = page.locator('[data-provider-group="p-cc"]')
    const ds = page.locator('[data-provider-group="p-ds"]')
    const na = page.locator('[data-provider-group="p-na"]')
    const goText = (await go.textContent()) ?? ''
    const ccText = (await cc.textContent()) ?? ''
    const dsText = (await ds.textContent()) ?? ''
    const naText = (await na.textContent()) ?? ''

    check('providerGroups', (await page.locator('[data-provider-group]').count()) === 4)
    check('goNoProviderRefresh', (await go.locator('[aria-label="刷新余额"]').count()) === 0)
    check('goNoConfigureQuery', !goText.includes('配置查询'))
    check('ccNoProviderRefresh', (await cc.locator('[aria-label="刷新余额"]').count()) === 0)
    check('ccNoConfigureQuery', !ccText.includes('配置查询'))
    check('goKeyWindows', ['5 小时', '每周', '每月', '已用 36%', '已用 96%'].every((part) => goText.includes(part)))
    const answeredQuota = go
      .locator('[class*="keyCard"]')
      .filter({ hasText: '工作账号' })
      .getByRole('button', { name: '刷新额度' })
      .first()
    check('answeredKeyQuotaHasReloadIcon', (await answeredQuota.locator('.anticon-reload').count()) === 1)
    check('ccKeyCredits', ccText.includes('68.16 credits') && ccText.includes('已用 5.24%'))
    check('deepseekKeepsProviderRefresh', (await ds.locator('[aria-label="刷新余额"]').count()) === 1)
    check('deepseekBalanceShown', dsText.includes('¥12.34'))
    check('newApiShowsConfigureQuery', naText.includes('配置查询'))
    const linkTexts = await page.locator('button.ant-btn-link').allTextContents()
    check('noQueryNowLinkText', linkTexts.every((text) => !text.includes('查询额度')))

    // Manual per-key query: the pending stat is the trigger.
    const goKey2 = go.locator('[class*="keyCard"]').filter({ hasText: '备用账号' })
    const refreshStat = goKey2.getByRole('button', { name: '刷新额度' }).first()
    const beforeWindows = await go.locator('[role="progressbar"]').count()
    await refreshStat.click()
    await settle()
    await settle()
    await page.mouse.move(5, 5)
    await settle()
    const afterWindows = await go.locator('[role="progressbar"]').count()
    const key2Text = (await goKey2.first().textContent()) ?? ''
    check('key2WindowsAfterRefresh', ['已用 22%', '已用 71%'].every((part) => key2Text.includes(part)))
    check('keyQuotaClickAddsWindows', afterWindows >= beforeWindows + 3)
    check('keyQuotaClickRefreshes', (await page.evaluate(() => window.__visualState.calls)).includes('key_usage_refresh'))
    const pageWidth = await page.evaluate(() => ({
      viewport: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }))
    // No horizontal overflow after the key card grows its windows block.
    check('noHorizontalOverflow', pageWidth.scrollWidth <= pageWidth.viewport + 1)
    await shot('02-keys-after-key-refresh')
    if (README_DIR) {
      await page.screenshot({ path: `${README_DIR}/workspace-providers.png`, scale: 'css' })
    }

    // Provider editor for a per-key-quota provider: the account query block is gone.
    await go.locator('[aria-label="设置"]').first().click()
    await page.getByRole('dialog').waitFor({ timeout: 15000 })
    await settle()
    const goDialog = (await page.getByRole('dialog').textContent()) ?? ''
    check('goProviderDialogHasKeyHint', goDialog.includes('额度按密钥查询'))
    check(
      'goProviderDialogHidesAccountQuery',
      !goDialog.includes('启用额度查询') && !goDialog.includes('选择查询方案'),
    )
    await shot('03-provider-modal-go')
    await page.keyboard.press('Escape')
    await settle()

    // A new provider from the Command Code preset: same hidden account section.
    await page.getByRole('button', { name: '添加供应商' }).click()
    await page.getByRole('dialog').waitFor({ timeout: 15000 })
    await settle()
    await page.getByRole('dialog').getByText('Command Code', { exact: true }).click()
    await settle()
    const newDialog = (await page.getByRole('dialog').textContent()) ?? ''
    check('newProviderPresetSetsKeyHint', newDialog.includes('额度按密钥查询'))
    check(
      'newProviderPresetHidesAccountQuery',
      !newDialog.includes('启用额度查询') && !newDialog.includes('选择查询方案'),
    )
    await shot('04-provider-modal-new-command-code')
    await page.keyboard.press('Escape')
    await settle()

    // Key editor: the key-scope catalogue now offers the moved schemes and the
    // draft test shows the windows it answered with.
    const goKey1 = go.locator('[class*="keyCard"]').filter({ hasText: '工作账号' })
    await goKey1.getByRole('button', { name: '编辑' }).first().click()
    await page.getByRole('dialog').waitFor({ timeout: 15000 })
    await settle()
    const keyDialog = (await page.getByRole('dialog').textContent()) ?? ''
    check('goKeyEditorTab', keyDialog.includes('密钥额度'))
    check('goKeyEditorSchemeSelected', keyDialog.includes('OpenCode Go 密钥额度'))
    await page.getByRole('dialog').getByRole('button', { name: '测试查询' }).click()
    await settle()
    await settle()
    const goTestProgress = await page.getByRole('dialog').locator('[role="progressbar"]').count()
    check('goKeyEditorTestWindows', goTestProgress >= 3)
    await shot('05-key-modal-opencode-test')
    await page.keyboard.press('Escape')
    await settle()

    const ccKey1 = cc.locator('[class*="keyCard"]').filter({ hasText: '个人账号' })
    await ccKey1.getByRole('button', { name: '编辑' }).first().click()
    await page.getByRole('dialog').waitFor({ timeout: 15000 })
    await settle()
    await page.getByRole('dialog').getByRole('button', { name: '测试查询' }).click()
    await settle()
    await settle()
    const ccTestText = (await page.getByRole('dialog').textContent()) ?? ''
    check('ccKeyEditorTestCredits', ccTestText.includes('42.50 credits'))
    check(
      'ccKeyEditorTestWindows',
      (await page.getByRole('dialog').locator('[role="progressbar"]').count()) >= 3,
    )
    check('ccKeyEditorNoLegacyAlert', !ccTestText.includes('此脚本可能查询的是账户额度'))
    await shot('06-key-modal-command-code-test')
    if (README_DIR) {
      await page.screenshot({ path: `${README_DIR}/workspace-key-quota.png`, scale: 'css' })
    }
    await page.keyboard.press('Escape')
    await settle()
  } finally {
    await browser.close()
  }
  result.checks = result.checks.map((entry) =>
    typeof entry.value === 'object' && entry.value !== null && !Array.isArray(entry.value)
      ? { name: entry.name, value: JSON.parse(JSON.stringify(entry.value)) }
      : entry,
  )
  console.log(JSON.stringify(result, null, 2))
  const failed = result.checks.filter((entry) => entry.value !== true)
  if (failed.length > 0) {
    console.error(`FAILED CHECKS: ${failed.map((entry) => entry.name).join(', ')}`)
    process.exitCode = 1
  }
}

await main()
