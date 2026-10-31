// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import type { ApiKey, Provider, TerminalLaunchPreview } from '@shared/types'
import KeyEditModal from './KeyEditModal'
import { useProviderModelCatalogStore } from '../../stores/providerModelCatalogStore'
import { buildDuplicatedKeyDraft, type KeyEditMode } from '../../utils/apiKeyEditor'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const apiMock = vi.hoisted(() => ({
  preview: null as TerminalLaunchPreview | null,
  modelCatalogPreview: vi.fn(),
  getModelCatalog: vi.fn(async () => ({
    models: [] as { id: string; displayName: string; supports1m?: boolean }[],
    revision: 0,
    updatedAt: null,
  })),
  getQueryPreference: vi.fn(async () => null as string | null),
  saveQueryPreference: vi.fn(async () => {}),
}))

vi.mock('../../api', () => ({
  getApi: () => ({
    terminal: { getLaunchPreview: async () => apiMock.preview },
    provider: {
      modelCatalogPreview: apiMock.modelCatalogPreview,
      getModelCatalog: apiMock.getModelCatalog,
    },
    apiKey: { retiredMappingReport: async () => [] },
    // The quota script is checked before saving; the mock accepts it.
    balance: { checkScript: async () => ({ url: '', method: 'GET', headers: {} }) },
    userAgent: {
      list: async () => [],
      save: async (value: string) => [value],
      getQueryPreference: apiMock.getQueryPreference,
      saveQueryPreference: apiMock.saveQueryPreference,
    },
  }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh' } }),
}))
vi.mock('../../hooks/useAppMessage', () => ({
  useAppMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: () => ({ globalSettings: {} }),
}))

Object.defineProperty(window, 'matchMedia', {
  value: () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }),
})
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const SOURCE_QUOTA_SCRIPT =
  '({ request: { url: "https://quota.example.com" }, extractor: () => ({ remaining: 1 }) })'
const PRESET_QUOTA_SCRIPT =
  '({ request: { url: "https://preset.example.com/quota" }, extractor: () => ({ remaining: 1 }) })'

let mounted: { root: Root; container: HTMLElement } | null = null

afterEach(async () => {
  if (mounted) {
    await act(async () => {
      mounted!.root.unmount()
    })
    mounted!.container.remove()
    mounted = null
  }
  document.body.innerHTML = ''
  apiMock.preview = null
  apiMock.modelCatalogPreview.mockReset()
  apiMock.getModelCatalog.mockResolvedValue({ models: [], revision: 0, updatedAt: null })
  useProviderModelCatalogStore.setState({ catalogs: {}, loading: {}, errors: {}, requests: {} })
  vi.clearAllMocks()
})

const presetProvider: Provider = {
  ...({
    id: 'provider-1',
    name: 'preset provider',
    baseUrl: 'https://opencode.ai/zen/go',
    httpProxy: null,
    website: null,
    remark: null,
    token: null,
    icon: 'claude',
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
    presetId: 'opencode-go',
  } as Provider),
  defaultKeyConfig: {
    types: ['claude_code', 'codex'],
    clientConfigs: {
      claude_code: { baseUrl: 'https://preset.example.com/anthropic', authScheme: 'bearer' },
    },
    modelMapping: JSON.stringify({ haiku: 'preset-haiku', sonnet: 'preset-sonnet' }),
    usageScript: PRESET_QUOTA_SCRIPT,
  },
}

const deepseekProvider: Provider = {
  id: 'provider-1',
  name: 'deepseek',
  baseUrl: 'https://api.deepseek.com/anthropic',
  httpProxy: null,
  website: null,
  remark: null,
  token: null,
  icon: 'deepseek',
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
  presetId: 'deepseek',
  defaultKeyConfig: null,
  requestAdapter: 'none',
  walletBalanceScript: null,
  requestHeaders: null,
}

function sourceKey(): ApiKey {
  return {
    id: 'key-1',
    providerId: 'provider-1',
    alias: 'daily',
    value: 'sk-source-credential',
    types: ['claude_code'],
    priority: 2,
    isExhausted: false,
    isActive: true,
    usageType: 'custom',
    usageScript: SOURCE_QUOTA_SCRIPT,
    usageUrl: null,
    usagePath: null,
    usageHeaders: null,
    cachedUsage: null,
    lastUsageCheckedAt: null,
    modelMapping: JSON.stringify({ haiku: 'source-haiku', sonnet: 'source-sonnet' }),
    clientConfigs: {
      claude_code: { baseUrl: 'https://source.example.com/anthropic', authScheme: 'bearer' },
    },
    cooldownUntil: null,
    lastErrorAt: null,
    lastErrorKind: null,
    consecutiveErrors: 0,
  }
}

async function render(
  mode: KeyEditMode,
  apiKey: ApiKey | null,
  onSave = vi.fn(),
  provider: Provider = deepseekProvider,
  options: {
    defaultTab?: 'usage' | 'modelMapping'
    onClose?: () => void
  } = {},
) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted = { root, container }
  await act(async () => {
    root.render(
      <StyleProvider layer>
        <ConfigProvider>
          <KeyEditModal
            open
            mode={mode}
            apiKey={apiKey}
            providers={[provider]}
            defaultProviderId='provider-1'
            defaultTab={options.defaultTab}
            onClose={options.onClose ?? (() => {})}
            onSave={onSave}
          />
        </ConfigProvider>
      </StyleProvider>,
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return onSave
}

const query = (selector: string) => document.body.querySelector<HTMLInputElement>(selector)

/** Tabs render their pane lazily, so an inactive tab has to be opened first. */
async function openTab(label: string) {
  const tab = Array.from(document.body.querySelectorAll('.ant-tabs-tab')).find((node) =>
    node.textContent?.includes(label),
  )
  expect(tab).toBeDefined()
  await act(async () => {
    ;(tab as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function openCode() {
  const header = Array.from(document.body.querySelectorAll('.ant-collapse-header')).find((node) =>
    node.textContent?.includes('Claude Code'),
  ) as HTMLElement
  expect(header).toBeDefined()
  if (header.getAttribute('aria-expanded') !== 'true') {
    await act(async () => {
      header.click()
    })
  }
}

async function clickButton(text: string) {
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (node) => node.textContent === text,
  )!
  expect(button).toBeDefined()
  await act(async () => {
    button.click()
  })
}

async function chooseCodeModel(value: string) {
  const select = document.body
    .querySelector('[aria-label="Claude Code ANTHROPIC_MODEL"]')
    ?.closest('.ant-select')
  expect(select).not.toBeNull()
  await act(async () => {
    select!
      .querySelector('input[role="combobox"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }))
  })
  await fillInput('input[aria-label="keys.processDefaultModel keys.manualEntry"]', value)
  await act(async () => {
    ;(
      document.body.querySelector('button[aria-label="keys.useEnteredModel"]') as HTMLButtonElement
    ).click()
  })
}

it('fills every tab from the source key when duplicating', async () => {
  await render('duplicate', buildDuplicatedKeyDraft(sourceKey(), '（副本）'))

  expect(query('input[type="password"]')?.value).toBe('sk-source-credential')
  expect(query('input#alias')?.value).toBe('daily（副本）')

  // Quota settings travel with the copy instead of resetting to the defaults.
  const fieldValues = Array.from(document.body.querySelectorAll('input, textarea')).map(
    (field) => (field as HTMLInputElement | HTMLTextAreaElement).value,
  )
  expect(fieldValues).toContain(SOURCE_QUOTA_SCRIPT)

  // The copy opens on the model mapping so it can be re-pointed immediately.
  expect(document.body.querySelector('.ant-tabs-tab-active')?.textContent).toContain(
    'keys.modelConfiguration',
  )
  await openCode()
  expect(selectedValue('Claude Code haiku keys.upstreamModel')).toBe('source-haiku')
  expect(selectedValue('Claude Code sonnet keys.upstreamModel')).toBe('source-sonnet')
})

it('keeps provider defaults out of the duplicated draft', async () => {
  await render('duplicate', buildDuplicatedKeyDraft(sourceKey()))
  await openCode()

  expect(selectedValue('Claude Code haiku keys.upstreamModel')).not.toBe('deepseek-v4-flash')
  expect(selectedValue('Claude Code opus keys.upstreamModel')).toBe('')
})

it('still starts a plain create from provider defaults', async () => {
  await render('create', null)

  expect(query('input[type="password"]')?.value).toBe('')
  expect(document.body.querySelector('.ant-tabs-tab-active')?.textContent).toContain(
    'keys.usageConfig',
  )

  await openTab('keys.modelConfiguration')
  await openCode()
  expect(selectedValue('Claude Code haiku keys.upstreamModel')).toBe('deepseek-v4-flash')
})

it('saves the copy as a new record without the source id', async () => {
  const onSave = await render('duplicate', buildDuplicatedKeyDraft(sourceKey()))

  const saveButton = Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.textContent === 'common.save',
  )
  expect(saveButton).toBeDefined()
  await act(async () => {
    saveButton!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  expect(onSave).toHaveBeenCalledTimes(1)
  expect(onSave.mock.calls[0][0]).toMatchObject({
    mode: 'duplicate',
    providerId: 'provider-1',
    value: 'sk-source-credential',
  })
  // No id means the save path inserts a new record; the source stays untouched.
  expect(onSave.mock.calls[0][0].id).toBeUndefined()
})

it('saves an edit against the existing id', async () => {
  const source = sourceKey()
  const onSave = await render('edit', source)

  const saveButton = Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.textContent === 'common.save',
  )
  await act(async () => {
    saveButton!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  expect(onSave.mock.calls[0][0]).toMatchObject({ mode: 'edit', id: 'key-1' })
})

async function submit() {
  const saveButton = Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.textContent === 'common.save',
  )
  expect(saveButton).toBeDefined()
  await act(async () => {
    saveButton!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** A new key cannot be saved without a credential. */
async function fillKeyValue(value = 'sk-new') {
  const field = document.body.querySelector<HTMLInputElement>('input#value')
  expect(field).not.toBeNull()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(field, value)
    field!.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function toggleQuota() {
  const toggle = document.body.querySelector('[role="switch"]')
  expect(toggle).not.toBeNull()
  await act(async () => {
    ;(toggle as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

it('keeps the key quota query off until the switch is turned on', async () => {
  const onSave = await render('create', null, vi.fn(), presetProvider)

  await fillKeyValue()
  await submit()

  // The script is on screen to read, but nothing is asked about this key until
  // the switch says so.
  expect(onSave.mock.calls[0][0].usageScript).toBeUndefined()
})

it('saves the key quota query once the switch is on', async () => {
  const onSave = await render('create', null, vi.fn(), presetProvider)

  await fillKeyValue()
  await toggleQuota()
  await submit()

  expect(onSave.mock.calls[0][0].usageScript).toBe(PRESET_QUOTA_SCRIPT)
})

it('seeds a new key from the provider defaults instead of a hardcoded template', async () => {
  const onSave = await render('create', null, vi.fn(), presetProvider)

  // The provider's own defaults show up without opening any advanced tab.
  expect(document.body.querySelector('.ant-tabs-tab-active')?.textContent).toContain(
    'keys.usageConfig',
  )
  const seeded = Array.from(document.body.querySelectorAll('input, textarea')).map(
    (field) => (field as HTMLInputElement | HTMLTextAreaElement).value,
  )
  expect(seeded).toContain(PRESET_QUOTA_SCRIPT)

  await openTab('keys.modelConfiguration')
  await openCode()
  expect(selectedValue('Claude Code haiku keys.upstreamModel')).toBe('preset-haiku')
  expect(selectedValue('Claude Code sonnet keys.upstreamModel')).toBe('preset-sonnet')

  // What was seeded is what gets saved.
  const saveButton = Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.textContent === 'common.save',
  )
  await act(async () => {
    saveButton!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(onSave).not.toHaveBeenCalled() // value is required and still empty
})

it('clears a previously configured quota script when the switch is turned off', async () => {
  const onSave = await render('edit', sourceKey())
  await toggleQuota()
  await submit()
  expect(onSave.mock.calls[0][0].usageScript).toBe('')
})

async function fillInput(selector: string, value: string) {
  const field = query(selector)
  expect(field).not.toBeNull()
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(field, value)
    field!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function openClient(label: string) {
  const header = Array.from(document.body.querySelectorAll('.ant-collapse-header')).find((node) =>
    node.textContent?.includes(label),
  ) as HTMLElement
  expect(header).toBeDefined()
  await act(async () => {
    header.click()
  })
}

it('gives Desktop its own catalog and fixed forwarding without changing Code', async () => {
  const source = {
    ...sourceKey(),
    types: ['claude_code', 'claude_desktop'] as ApiKey['types'],
    modelMapping: JSON.stringify({
      version: 2,
      clients: {
        claude_code: { upstream: { mode: 'family', haiku: 'source-haiku' } },
        claude_desktop: {
          catalog: {
            mode: 'custom',
            models: [{ id: 'desktop-real', displayName: 'Desktop label' }],
          },
          upstream: { mode: 'fixed', model: 'old-desktop' },
        },
      },
    }),
  }
  const onSave = await render('duplicate', buildDuplicatedKeyDraft(source))
  expect(document.body.querySelectorAll('.ant-collapse-header')).toHaveLength(2)
  await openClient('Claude Desktop')
  await chooseTarget('Claude Desktop keys.upstreamModel', 'desktop-target')
  await submit()
  const clients = JSON.parse(onSave.mock.calls[0][0].modelMapping).clients
  expect(clients.claude_code.upstream.haiku).toBe('source-haiku')
  expect(clients.claude_desktop.upstream).toEqual({ mode: 'fixed', model: 'desktop-target' })
  expect(clients.claude_desktop.catalog.models).toEqual([
    { id: 'desktop-real', displayName: 'Desktop label' },
  ])
  expect(clients.claude_desktop.upstream.autoMode).toBeUndefined()
})

it('edits process models through the same local config and preserves other variables', async () => {
  const source = { ...sourceKey(), config: { OTHER_OPTION: 'keep', ANTHROPIC_MODEL: 'old' } }
  const onSave = await render('duplicate', buildDuplicatedKeyDraft(source))
  await openCode()
  await chooseCodeModel('new-process-model')
  await clickButton('keys.otherStartupSettings…')
  const local = Array.from(document.body.querySelectorAll('textarea')).find((field) =>
    field.value.includes('OTHER_OPTION'),
  )!
  expect(JSON.parse(local.value)).toEqual({
    OTHER_OPTION: 'keep',
  })
  await clickButton('keys.applyModelDraft')
  await submit()
  expect(onSave.mock.calls[0][0].config).toEqual({
    OTHER_OPTION: 'keep',
    ANTHROPIC_MODEL: 'new-process-model',
  })
  expect(JSON.parse(onSave.mock.calls[0][0].modelMapping).clients.claude_code.upstream.haiku).toBe(
    'source-haiku',
  )
})

it('previews unsaved process model changes while retaining gateway credentials', async () => {
  apiMock.preview = {
    cliType: 'claude_code',
    command: 'claude',
    env: { ANTHROPIC_MODEL: 'old', ANTHROPIC_AUTH_TOKEN: 'session-preview' },
  }
  await render('edit', { ...sourceKey(), config: { ANTHROPIC_MODEL: 'old' } })
  await openTab('keys.modelConfiguration')
  await openCode()
  await chooseCodeModel('draft-model')
  await clickButton('keys.viewLaunchPreview')
  const preview = Array.from(document.body.querySelectorAll('textarea')).find((field) =>
    field.value.includes('__command'),
  )!
  expect(JSON.parse(preview.value)).toMatchObject({
    ANTHROPIC_MODEL: 'draft-model',
    ANTHROPIC_AUTH_TOKEN: 'session-preview',
  })
})

const cloudModels = [
  { id: 'cloud-model', displayName: 'Cloud model' },
  { id: 'cloud-one-m', displayName: 'One M', supports1m: true },
]

function selectedValue(label: string) {
  return (
    document.body
      .querySelector(`[aria-label="${label}"]`)
      ?.closest('.ant-select')
      ?.querySelector('.ant-select-content-value')
      ?.getAttribute('title') ?? ''
  )
}
async function chooseTarget(label: string, value: string) {
  const combo = document.body.querySelector(`[aria-label="${label}"]`)!
  expect(combo).not.toBeNull()
  await act(async () =>
    combo.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }),
    ),
  )
  await fillInput(`input[aria-label="${label} keys.manualEntry"]`, value)
  const add = [
    ...document.body.querySelectorAll<HTMLButtonElement>('.ant-select-dropdown button'),
  ].find((button) => button.textContent === 'keys.clientModelAdd')!
  await act(async () => add.click())
}
async function openCatalog(onSave = vi.fn(), onClose = vi.fn(), apiKey: ApiKey = sourceKey()) {
  apiMock.getModelCatalog.mockResolvedValue({ models: cloudModels, revision: 1, updatedAt: null })
  await render('edit', apiKey, onSave, deepseekProvider, {
    defaultTab: 'modelMapping',
    onClose,
  })
  await openCode()
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
async function selectCatalogModel(id: string) {
  const combo = document.body.querySelector('[aria-label="Claude Code keys.clientModelSelection"]')!
  expect(combo).not.toBeNull()
  await act(async () => {
    combo.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const options = [...document.body.querySelectorAll<HTMLElement>('.ant-select-item-option')]
  const option = options.find((node) => node.textContent?.includes(id))
  expect(option).toBeDefined()
  await act(async () => {
    option!.click()
  })
  await act(async () => {
    combo.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }))
  })
  return options.map((node) => node.textContent ?? '').join(' ')
}
async function clickFooter(text: string) {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent === text,
  )
  expect(button).toBeDefined()
  await act(async () => {
    button!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

it('reads saved choices in the Key selector without a network query or UA editor', async () => {
  await openCatalog()
  expect(apiMock.getModelCatalog).toHaveBeenCalledWith('provider-1')
  expect(apiMock.modelCatalogPreview).not.toHaveBeenCalled()
  expect(
    document.body.querySelector('[aria-label="Claude Code keys.clientModelSelection"]'),
  ).not.toBeNull()
  expect(document.body.textContent).not.toContain('keys.manageModels')
  expect(document.body.textContent).not.toContain('keys.manualAddModel')
  expect(document.body.querySelector('[aria-label="User-Agent"]')).toBeNull()
  expect(document.body.textContent).not.toContain('keys.catalogLoad')
})

it('selects saved provider models inline and saves only the Key draft with unrelated mapping preserved', async () => {
  const onSave = vi.fn()
  const source: ApiKey = {
    ...sourceKey(),
    modelMapping: JSON.stringify({
      version: 2,
      clients: {
        claude_code: {
          catalog: { mode: 'append', models: [{ id: 'added-model', displayName: 'Added' }] },
          upstream: { mode: 'family', haiku: 'source-haiku', sonnet: 'source-sonnet' },
        },
      },
    }),
  }
  await openCatalog(onSave, vi.fn(), source)
  await selectCatalogModel('cloud-model')
  expect(onSave).not.toHaveBeenCalled()
  await openCode()
  // Applied draft is available immediately, before the Key has been saved.
  await chooseTarget('Claude Code haiku keys.upstreamModel', 'cloud-model')
  await clickFooter('common.save')
  expect(onSave).toHaveBeenCalledTimes(1)
  expect(onSave.mock.calls[0][0].clientConfigs).toEqual({
    claude_code: { baseUrl: 'https://source.example.com/anthropic', authScheme: 'bearer' },
  })
  const mapping = JSON.parse(onSave.mock.calls[0][0].modelMapping)
  expect(mapping.clients.claude_code.catalog).toEqual({
    mode: 'custom',
    models: [
      { id: 'added-model', displayName: 'Added' },
      { id: 'cloud-model', displayName: 'Cloud model' },
    ],
  })
  expect(mapping.clients.claude_code.upstream).toEqual({
    mode: 'family',
    haiku: 'cloud-model',
    sonnet: 'source-sonnet',
  })
})

it('keeps unselected saved candidates out of the Key without a second editor', async () => {
  const onSave = vi.fn()
  await openCatalog(onSave)
  await clickFooter('common.save')
  expect(onSave).toHaveBeenCalledTimes(1)
  expect(onSave.mock.calls[0][0].modelMapping).not.toContain('cloud-model')
  expect(apiMock.modelCatalogPreview).not.toHaveBeenCalled()
})

it('cancelling the Key discards inline model selection without a Key save', async () => {
  const onSave = vi.fn(),
    onClose = vi.fn()
  await openCatalog(onSave, onClose)
  await selectCatalogModel('cloud-model')
  await clickFooter('common.cancel')
  expect(onClose).toHaveBeenCalled()
  expect(onSave).not.toHaveBeenCalled()
})

it('keeps legacy selected IDs and 1M metadata while adding choices from the saved catalog', async () => {
  const onSave = vi.fn()
  const source: ApiKey = {
    ...sourceKey(),
    modelMapping: JSON.stringify({
      version: 2,
      clients: {
        claude_code: {
          catalog: {
            mode: 'append',
            models: [{ id: 'legacy-private', displayName: 'Legacy label', supports1m: true }],
          },
          upstream: { mode: 'fixed', model: 'manual-upstream-target' },
        },
      },
    }),
  }
  await openCatalog(onSave, vi.fn(), source)
  const choices = await selectCatalogModel('cloud-one-m')
  expect(choices).toContain('Legacy label')
  await clickFooter('common.save')
  const client = JSON.parse(onSave.mock.calls[0][0].modelMapping).clients.claude_code
  expect(client.catalog).toEqual({
    mode: 'custom',
    models: [
      { id: 'legacy-private', displayName: 'Legacy label', supports1m: true },
      { id: 'cloud-one-m', displayName: 'One M', supports1m: true },
    ],
  })
  expect(client.upstream).toEqual({ mode: 'fixed', model: 'manual-upstream-target' })
  expect(apiMock.modelCatalogPreview).not.toHaveBeenCalled()
})

it('saves selected models as an explicit client whitelist and clearing restores the provider catalog', async () => {
  const onSave = vi.fn()
  await openCatalog(onSave)
  await selectCatalogModel('cloud-model')
  await clickFooter('common.save')

  let catalog = JSON.parse(onSave.mock.lastCall![0].modelMapping).clients.claude_code.catalog
  expect(catalog).toEqual({
    mode: 'custom',
    models: [{ id: 'cloud-model', displayName: 'Cloud model' }],
  })

  // Clicking the checked option again clears the whitelist, which falls back
  // to the provider catalog instead of saving an empty custom list.
  await selectCatalogModel('cloud-model')
  await clickFooter('common.save')
  catalog = JSON.parse(onSave.mock.lastCall![0].modelMapping).clients.claude_code.catalog
  expect(catalog).toEqual({ mode: 'provider' })
  expect(onSave).toHaveBeenCalledTimes(2)
  expect(apiMock.modelCatalogPreview).not.toHaveBeenCalled()
})

it('does not display dormant provider drafts as checked Key selections', async () => {
  const source: ApiKey = {
    ...sourceKey(),
    modelMapping: JSON.stringify({
      version: 2,
      clients: {
        claude_code: {
          catalog: {
            mode: 'provider',
            models: [{ id: 'runtime-model', displayName: 'Runtime model' }],
            draftModels: [{ id: 'dormant-only', displayName: 'Dormant only' }],
          },
        },
      },
    }),
  }
  await openCatalog(vi.fn(), vi.fn(), source)
  const combo = document.body.querySelector('[aria-label="Claude Code keys.clientModelSelection"]')!
  const select = combo.closest('.ant-select')!
  expect(select.querySelectorAll('.ant-select-selection-item')).toHaveLength(0)
})

it('does not keep a second model-management entry inside the Key editor', async () => {
  await openCatalog()
  expect(document.body.textContent).not.toContain('keys.catalogMode')
  expect(document.body.textContent).not.toContain('keys.useProviderCatalog')
  expect(document.body.textContent).not.toContain('keys.manageModels')
})

it.each(['edit', 'duplicate'] as const)(
  'preserves provider runtime metadata through an unrelated %s save',
  async (mode) => {
    const runtime = [{ id: 'legacy-sonnet', displayName: 'Legacy Sonnet', supports1m: true }]
    const drafts = [{ id: 'dormant-only', displayName: 'Dormant only' }]
    const source: ApiKey = {
      ...sourceKey(),
      types: ['claude_code', 'claude_desktop'],
      config: { ANTHROPIC_MODEL: 'legacy-sonnet[1m]', OTHER_OPTION: 'keep' },
      modelMapping: JSON.stringify({
        version: 2,
        clients: {
          claude_code: {
            catalog: { mode: 'provider', models: runtime, draftModels: drafts },
            upstream: { mode: 'fixed', model: 'legacy-upstream' },
          },
          claude_desktop: {
            catalog: {
              mode: 'provider',
              models: runtime,
              draftModels: drafts,
              roles: { opus: 'legacy-sonnet' },
            },
            upstream: { mode: 'follow' },
          },
        },
      }),
    }
    const onSave = await render(mode, source)
    await fillInput('input#alias', 'Renamed without changing models')
    await submit()
    expect(onSave).toHaveBeenCalledOnce()
    const saved = onSave.mock.calls[0][0]
    const clients = JSON.parse(saved.modelMapping).clients
    expect(clients.claude_code.catalog.models).toEqual(runtime)
    expect(clients.claude_code.catalog.draftModels).toEqual(drafts)
    expect(clients.claude_code.upstream).toEqual({ mode: 'fixed', model: 'legacy-upstream' })
    expect(clients.claude_desktop.catalog.models).toEqual(runtime)
    expect(clients.claude_desktop.catalog.roles).toEqual({ opus: 'legacy-sonnet' })
    expect(saved.config).toEqual(source.config)
  },
)

it('keeps explicit Desktop role labels and 1M without promoting other provider selections', async () => {
  apiMock.getModelCatalog.mockResolvedValue({
    models: [
      { id: 'claude-opus-4-6', displayName: 'Role Label', supports1m: true },
      { id: 'other-draft', displayName: 'Other draft', supports1m: true },
    ],
    revision: 1,
    updatedAt: null,
  })
  const onSave = await render(
    'edit',
    {
      ...sourceKey(),
      types: ['claude_desktop'],
      modelMapping: JSON.stringify({
        version: 2,
        clients: {
          claude_desktop: {
            catalog: {
              mode: 'provider',
              draftModels: [{ id: 'other-draft', displayName: 'Other draft', supports1m: true }],
            },
            upstream: { mode: 'follow' },
          },
        },
      }),
    },
    vi.fn(),
    deepseekProvider,
    { defaultTab: 'modelMapping' },
  )
  const header = Array.from(
    document.body.querySelectorAll<HTMLElement>('.ant-collapse-header'),
  ).find((node) => node.textContent?.includes('Claude Desktop'))!
  if (header.getAttribute('aria-expanded') !== 'true') await act(async () => header.click())
  const combo = document.body.querySelector('[aria-label="Claude Desktop keys.roleSlots sonnet"]')!
  expect(combo).not.toBeNull()
  await act(async () =>
    combo.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }),
    ),
  )
  const option = Array.from(
    document.body.querySelectorAll<HTMLElement>('.ant-select-item-option'),
  ).find((node) => node.textContent?.includes('claude-opus-4-6'))!
  expect(option).toBeDefined()
  await act(async () => option.click())
  await submit()
  expect(onSave).toHaveBeenCalledOnce()
  const catalog = JSON.parse(onSave.mock.calls[0][0].modelMapping).clients.claude_desktop.catalog
  expect(catalog.mode).toBe('provider')
  expect(catalog.roles).toEqual({ sonnet: 'claude-opus-4-6' })
  expect(catalog.models).toEqual([
    { id: 'claude-opus-4-6', displayName: 'Role Label', supports1m: true },
  ])
  expect(catalog.draftModels.map((model: { id: string }) => model.id)).toEqual([
    'other-draft',
    'claude-opus-4-6',
  ])
  expect(apiMock.modelCatalogPreview).not.toHaveBeenCalled()
})

it('saves an existing 1M custom default unchanged when its model supports 1M', async () => {
  const onSave = vi.fn()
  const source: ApiKey = {
    ...sourceKey(),
    config: { ANTHROPIC_MODEL: 'custom-large[1m]', OTHER_OPTION: 'keep' },
    modelMapping: JSON.stringify({
      version: 2,
      clients: {
        claude_code: {
          catalog: {
            mode: 'custom',
            models: [{ id: 'custom-large', displayName: 'Large model', supports1m: true }],
          },
          upstream: { mode: 'follow' },
        },
      },
    }),
  }
  await render('edit', source, onSave)
  await submit()
  expect(onSave).toHaveBeenCalledTimes(1)
  expect(onSave.mock.calls[0][0].config).toEqual(source.config)
  expect(
    JSON.parse(onSave.mock.calls[0][0].modelMapping).clients.claude_code.catalog.models,
  ).toEqual([{ id: 'custom-large', displayName: 'Large model', supports1m: true }])
})

it('rejects a suffixed custom default when that model does not support 1M', async () => {
  const onSave = vi.fn()
  await render(
    'edit',
    {
      ...sourceKey(),
      config: { ANTHROPIC_MODEL: 'custom-small[1m]' },
      modelMapping: JSON.stringify({
        version: 2,
        clients: {
          claude_code: {
            catalog: {
              mode: 'custom',
              models: [{ id: 'custom-small', displayName: 'Small model' }],
            },
            upstream: { mode: 'follow' },
          },
        },
      }),
    },
    onSave,
  )
  await submit()
  expect(onSave).not.toHaveBeenCalled()
})

it('keeps connection edits independent of model selection and restores the provider default', async () => {
  const onSave = vi.fn()
  await render('edit', sourceKey(), onSave)
  await openTab('keys.connectionConfig')
  const baseUrl = [...document.body.querySelectorAll('input')].find(
    (field) => field.value === 'https://source.example.com/anthropic',
  )!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(baseUrl, 'https://draft.example.com/anthropic')
    baseUrl.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await openTab('keys.modelConfiguration')
  await openCode()
  expect(
    document.body.querySelector('[aria-label="Claude Code keys.clientModelSelection"]'),
  ).not.toBeNull()
  expect(apiMock.modelCatalogPreview).not.toHaveBeenCalled()
  await openTab('keys.connectionConfig')
  await act(async () =>
    document.body
      .querySelector<HTMLButtonElement>('button[aria-label="keys.connectionRestoreDefault"]')!
      .click(),
  )
  expect(baseUrl.value).toBe('')
  await clickFooter('common.save')
  expect(onSave).toHaveBeenCalledTimes(1)
  expect(onSave.mock.calls[0][0].clientConfigs).toEqual({ claude_code: { authScheme: 'bearer' } })
})

it('saves an explicit client connection override under the original Key semantics', async () => {
  const onSave = vi.fn()
  await render('edit', sourceKey(), onSave)
  await openTab('keys.connectionConfig')
  const baseUrl = [...document.body.querySelectorAll('input')].find(
    (field) => field.value === 'https://source.example.com/anthropic',
  )!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(baseUrl, 'https://saved.example.com/anthropic')
    baseUrl.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await submit()
  expect(onSave.mock.calls[0][0].clientConfigs).toEqual({
    claude_code: { baseUrl: 'https://saved.example.com/anthropic', authScheme: 'bearer' },
  })
})
