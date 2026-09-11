// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import type { Provider, ProviderPreset } from '@shared/types'
import ProviderModal from './ProviderModal'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const presets = vi.fn()
const checkScript = vi.fn()
const iconList = vi.fn()

vi.mock('../../api', () => ({
  getApi: () => ({
    provider: { presets },
    icon: { upload: async () => '', list: iconList },
    balance: { checkScript },
  }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh' } }),
}))
vi.mock('../../hooks/useAppMessage', () => ({
  useAppMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
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

const DEEPSEEK_SCRIPT = `({
  request: { url: "https://api.deepseek.com/user/balance", method: "GET",
             headers: { Authorization: "Bearer {{apiKey}}" } },
  extractor: function (response) { return { remaining: response.balance } }
})`

const NEWAPI_SCRIPT = `({
  request: { url: "{{baseUrl}}/api/user/self", method: "GET",
             headers: { Authorization: "{{accessToken}}", "New-Api-User": "{{userId}}" } },
  extractor: function (response) { return { remaining: response.data.quota / 500000 } }
})`

const deepseek: ProviderPreset = {
  id: 'deepseek',
  defaultName: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  icon: 'deepseek',
  requiresSiteAddress: false,
  needsAccountCredential: false,
  walletBalanceType: 'deepseek',
  walletBalanceUrl: 'https://api.deepseek.com/user/balance',
  walletBalanceHeaders: '{"Authorization": "Bearer {key}"}',
  usageType: 'none',
  usageUrl: null,
  usageHeaders: null,
  walletBalanceScript: DEEPSEEK_SCRIPT,
  requestAdapter: 'none',
  defaultKeyConfig: {
    types: ['claude_code', 'codex'],
    clientConfigs: { claude_code: { baseUrl: 'https://api.deepseek.com/anthropic' } },
    modelMapping: '{"haiku":"deepseek-v4-flash"}',
  },
}

const custom: ProviderPreset = {
  id: 'custom',
  defaultName: '',
  baseUrl: '',
  icon: 'custom',
  requiresSiteAddress: false,
  needsAccountCredential: false,
  walletBalanceType: 'none',
  walletBalanceUrl: null,
  walletBalanceHeaders: null,
  usageType: 'none',
  usageUrl: null,
  usageHeaders: null,
  walletBalanceScript: null,
  requestAdapter: 'none',
  defaultKeyConfig: { types: ['claude_code'] },
}

const newapi: ProviderPreset = {
  id: 'newapi',
  defaultName: '',
  baseUrl: '',
  icon: 'newapi',
  requiresSiteAddress: true,
  needsAccountCredential: true,
  walletBalanceType: 'newapi',
  walletBalanceUrl: '{baseUrl}/api/user/self',
  walletBalanceHeaders: '{"Authorization": "{token}", "New-Api-User": "{userId}"}',
  usageType: 'none',
  usageUrl: null,
  usageHeaders: null,
  walletBalanceScript: NEWAPI_SCRIPT,
  requestAdapter: 'none',
  defaultKeyConfig: { types: ['claude_code'] },
}

let mounted: { root: Root; container: HTMLElement } | null = null

beforeEach(() => {
  iconList.mockReset()
  iconList.mockResolvedValue({ uploaded: [] })
  presets.mockReset()
  checkScript.mockReset()
  checkScript.mockResolvedValue({ url: 'https://relay.example.com', method: 'GET', headers: {} })
  presets.mockResolvedValue([custom, deepseek])
})

afterEach(async () => {
  if (mounted) {
    await act(async () => {
      mounted!.root.unmount()
    })
    mounted!.container.remove()
    mounted = null
  }
  document.body.innerHTML = ''
})

/** antd form controls carry the field name as their element id. */
function fieldValue(name: string): string | undefined {
  return document.body.querySelector<HTMLInputElement>(`input#${name}`)?.value
}

/** The account query editor, then the request-header editor beneath it. */
function scriptEditor(): HTMLTextAreaElement {
  return document.body.querySelectorAll<HTMLTextAreaElement>('textarea[class*="queryEditor"]')[0]!
}

function headersEditor(): HTMLTextAreaElement {
  return document.body.querySelectorAll<HTMLTextAreaElement>('textarea[class*="queryEditor"]')[1]!
}

async function render(provider: Provider | null, onSave = vi.fn()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted = { root, container }
  await act(async () => {
    root.render(
      <StyleProvider layer>
        <ConfigProvider>
          <ProviderModal open provider={provider} onClose={() => {}} onSave={onSave} />
        </ConfigProvider>
      </StyleProvider>,
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return onSave
}

async function clickPreset(index: number) {
  const chips = document.body.querySelectorAll('[class*="presetChip"]')
  await act(async () => {
    ;(chips[index] as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function typeInto(element: HTMLInputElement | HTMLTextAreaElement, text: string) {
  // React tracks the previous value on the node, so a plain assignment is
  // swallowed; going through the native setter is what makes the change land.
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  await act(async () => {
    setter?.call(element, text)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** A new provider cannot be saved without these. */
async function fillRequiredFields() {
  await typeInto(document.body.querySelector<HTMLInputElement>('input#name')!, 'relay')
  await typeInto(
    document.body.querySelector<HTMLInputElement>('input#baseUrl')!,
    'https://relay.example.com',
  )
}

async function submit() {
  const ok = Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.textContent === 'common.confirm',
  )
  expect(ok).toBeDefined()
  await act(async () => {
    ok!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function providerFixture(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'provider-1',
    name: 'my gateway',
    baseUrl: 'https://custom.example.com',
    httpProxy: null,
    website: null,
    remark: null,
    token: null,
    icon: 'newapi',
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
    presetId: 'newapi',
    defaultKeyConfig: { types: ['claude_code'] },
    requestAdapter: 'none',
    walletBalanceScript: null,
    requestHeaders: null,
    ...overrides,
  }
}

it('offers the catalogue on a new provider', async () => {
  await render(null)
  expect(presets).toHaveBeenCalled()
  // Presets are offered by name, not by vendor logo: a preset picks a
  // template, so a brand mark would promise the wrong thing.
  const chips = Array.from(document.body.querySelectorAll('[class*="presetChip"]'))
  expect(chips.map((chip) => chip.textContent)).toEqual(['custom', 'deepseek'])
  // The icon picker below is a separate control and keeps its logos.
  expect(document.body.querySelectorAll('[class*="iconItem"]').length).toBe(4 + 1)
})

it('writes a chosen preset script into the editor', async () => {
  await render(null)
  await clickPreset(1) // deepseek

  expect(fieldValue('baseUrl')).toBe('https://api.deepseek.com')
  expect(fieldValue('name')).toBe('deepseek')
  expect(scriptEditor().value).toBe(DEEPSEEK_SCRIPT)
})

it('resets the address when a template that has none of its own is chosen', async () => {
  presets.mockResolvedValue([custom, deepseek, newapi])
  await render(null)

  await clickPreset(1) // deepseek fills its own address
  expect(fieldValue('baseUrl')).toBe('https://api.deepseek.com')

  // New API's site belongs to the user, so its template carries none. Leaving
  // DeepSeek's address standing would point the provider at a service it is not.
  await clickPreset(2)
  expect(fieldValue('baseUrl')).toBe('')
  expect(fieldValue('name')).toBe('')
})

it('starts a new provider on the starter script', async () => {
  await render(null)

  // The query is a field to complete, not a switch to find: a new provider
  // opens on a script that shows the shape rather than on nothing at all.
  expect(scriptEditor().value).toContain('{{baseUrl}}')
  expect(scriptEditor().value).toContain('extractor')
})

it('returns to the starter script when the blank template is chosen', async () => {
  presets.mockResolvedValue([custom, deepseek])
  await render(null)

  await clickPreset(1)
  expect(scriptEditor().value).toBe(DEEPSEEK_SCRIPT)

  await clickPreset(0)
  expect(scriptEditor().value).not.toBe(DEEPSEEK_SCRIPT)
  expect(scriptEditor().value).toContain('extractor')
})

it('saves the script a preset shipped', async () => {
  const onSave = await render(null)
  await clickPreset(1)
  await submit()

  expect(onSave).toHaveBeenCalledTimes(1)
  expect(onSave.mock.calls[0][0]).toMatchObject({
    presetId: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    name: 'deepseek',
    walletBalanceScript: DEEPSEEK_SCRIPT,
    usageType: 'none',
  })
  expect(onSave.mock.calls[0][0].defaultKeyConfig).toMatchObject({
    types: ['claude_code', 'codex'],
  })
})

it('saves the script as the user edited it, not as the preset shipped it', async () => {
  const onSave = await render(null)
  await clickPreset(1)

  await typeInto(scriptEditor(), '({ request: { url: "https://x/y" }, extractor: () => ({}) })')
  await submit()

  expect(onSave.mock.calls[0][0].walletBalanceScript).toBe(
    '({ request: { url: "https://x/y" }, extractor: () => ({}) })',
  )
})

it('checks the script before saving, and refuses one the engine rejects', async () => {
  checkScript.mockRejectedValue('第 1 行无法识别')
  const onSave = await render(null)
  await fillRequiredFields()

  await submit()

  expect(checkScript).toHaveBeenCalledWith(expect.any(String), 'https://relay.example.com')
  expect(onSave).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('第 1 行无法识别')
})

it('does not ask the engine about a provider with no query', async () => {
  const onSave = await render(null)
  await typeInto(scriptEditor(), '')
  await fillRequiredFields()
  await submit()

  expect(checkScript).not.toHaveBeenCalled()
  expect(onSave).toHaveBeenCalledTimes(1)
  expect(onSave.mock.calls[0][0].walletBalanceScript).toBeUndefined()
})

it('shows the stored script when editing, without re-applying a template', async () => {
  const onSave = await render(providerFixture({ walletBalanceScript: DEEPSEEK_SCRIPT }))

  expect(scriptEditor().value).toBe(DEEPSEEK_SCRIPT)
  // No preset picker on edit: the stored config is the source of truth.
  expect(document.body.querySelectorAll('[class*="presetChip"]').length).toBe(0)
  await submit()

  expect(onSave.mock.calls[0][0]).toMatchObject({
    id: 'provider-1',
    presetId: 'newapi',
    walletBalanceScript: DEEPSEEK_SCRIPT,
  })
})

it('carries the request headers it was given', async () => {
  const onSave = await render(providerFixture())

  await typeInto(headersEditor(), '{"X-Relay": "cc-use"}')
  await submit()

  expect(onSave.mock.calls[0][0].requestHeaders).toBe('{"X-Relay": "cc-use"}')
})

it('shows the stored headers pretty-printed, and clears them when emptied', async () => {
  const onSave = await render(
    providerFixture({ requestHeaders: '{"X-Relay":"cc-use","X-Tenant":"acme"}' }),
  )

  expect(headersEditor().value).toBe('{\n  "X-Relay": "cc-use",\n  "X-Tenant": "acme"\n}')

  await typeInto(headersEditor(), '')
  await submit()

  expect(onSave.mock.calls[0][0].requestHeaders).toBeUndefined()
})

it('shows nothing — rather than a broken path — when no mark was chosen', async () => {
  // `custom` is what the blank template stores, and it means "unset".
  await render(providerFixture({ icon: 'custom', presetId: 'custom' }))

  expect(document.body.querySelector('img[src="file://custom"]')).toBeNull()
  expect(document.body.querySelectorAll('[class*="iconItemActive"]').length).toBe(0)
})

it('asks for the access token only when the script names it', async () => {
  presets.mockResolvedValue([custom, deepseek, newapi])

  await render(null)
  await clickPreset(1) // deepseek: its script uses {{apiKey}}, not {{accessToken}}
  expect(document.body.querySelector('input#token')).toBeNull()

  await clickPreset(2) // newapi: names both {{accessToken}} and {{userId}}
  expect(document.body.querySelector('input#token')).not.toBeNull()
  expect(document.body.querySelector('input#walletBalanceUserId')).not.toBeNull()
})

it('reuses an uploaded icon from the local library', async () => {
  iconList.mockResolvedValue({ uploaded: ['saved-logo.png'] })
  const onSave = await render(providerFixture())
  const icon = document.body.querySelector<HTMLButtonElement>('button[aria-label="saved-logo.png"]')
  expect(icon?.querySelector('img')?.getAttribute('src')).toBe(
    'cc-use-icon://localhost/saved-logo.png',
  )
  await act(async () => {
    icon!.click()
  })
  await submit()
  expect(onSave.mock.calls[0][0].icon).toBe('saved-logo.png')
})

it('persists an explicitly cleared account query', async () => {
  const onSave = await render(providerFixture({ walletBalanceScript: DEEPSEEK_SCRIPT }))
  await typeInto(scriptEditor(), '')
  await submit()
  expect(onSave.mock.calls[0][0].walletBalanceScript).toBe('')
  expect(onSave.mock.calls[0][0].walletBalanceType).toBe('none')
})
