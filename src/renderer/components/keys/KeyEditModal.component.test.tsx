// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import type { ApiKey, Provider, TerminalLaunchPreview } from '@shared/types'
import KeyEditModal from './KeyEditModal'
import { buildDuplicatedKeyDraft, type KeyEditMode } from '../../utils/apiKeyEditor'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const apiMock = vi.hoisted(() => ({ preview: null as TerminalLaunchPreview | null }))

vi.mock('../../api', () => ({
  getApi: () => ({
    terminal: { getLaunchPreview: async () => apiMock.preview },
    apiKey: { retiredMappingReport: async () => [] },
    // The quota script is checked before saving; the mock accepts it.
    balance: { checkScript: async () => ({ url: '', method: 'GET', headers: {} }) },
    userAgent: { list: async () => [], save: async (value: string) => [value] },
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
            onClose={() => {}}
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
  expect(query('input[aria-label="Claude Code haiku keys.upstreamModel"]')?.value).toBe(
    'source-haiku',
  )
  expect(query('input[aria-label="Claude Code sonnet keys.upstreamModel"]')?.value).toBe(
    'source-sonnet',
  )
})

it('keeps provider defaults out of the duplicated draft', async () => {
  await render('duplicate', buildDuplicatedKeyDraft(sourceKey()))
  await openCode()

  expect(query('input[aria-label="Claude Code haiku keys.upstreamModel"]')?.value).not.toBe(
    'deepseek-v4-flash',
  )
  expect(query('input[aria-label="Claude Code opus keys.upstreamModel"]')?.value).toBe('')
})

it('still starts a plain create from provider defaults', async () => {
  await render('create', null)

  expect(query('input[type="password"]')?.value).toBe('')
  expect(document.body.querySelector('.ant-tabs-tab-active')?.textContent).toContain(
    'keys.usageConfig',
  )

  await openTab('keys.modelConfiguration')
  await openCode()
  expect(query('input[aria-label="Claude Code haiku keys.upstreamModel"]')?.value).toBe(
    'deepseek-v4-flash',
  )
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
  expect(query('input[aria-label="Claude Code haiku keys.upstreamModel"]')?.value).toBe(
    'preset-haiku',
  )
  expect(query('input[aria-label="Claude Code sonnet keys.upstreamModel"]')?.value).toBe(
    'preset-sonnet',
  )

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
  await fillInput('input[aria-label="Claude Desktop keys.upstreamModel"]', 'desktop-target')
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
