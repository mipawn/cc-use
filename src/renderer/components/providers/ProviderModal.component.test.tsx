// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import type { Provider, ProviderPreset, QuerySchemeInfo } from '@shared/types'
import ProviderModal from './ProviderModal'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const presets = vi.fn()
const checkScript = vi.fn()
const iconList = vi.fn()
const iconDelete = vi.fn()
const schemes = vi.fn()
const testDraft = vi.fn()

vi.mock('../../api', () => ({
  getApi: () => ({
    provider: { presets },
    icon: {
      upload: async () => '',
      list: iconList,
      read: async () => 'data:image/png;base64,aWNvbg==',
      delete: iconDelete,
    },
    balance: { checkScript, schemes, testDraft },
  }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { names?: string }) =>
      values?.names ? `${key}: ${values.names}` : key,
    i18n: { language: 'zh' },
  }),
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

const GO_SCRIPT = `({
  request: { url: "{{baseUrl}}/v1/usage", method: "GET",
             headers: { Authorization: "Bearer {{apiKey}}" } },
  extractor: function (response) { return { windows: response.windows } }
})`

/** The account schemes the section picks from; scripts are the saved truth. */
const accountSchemes: QuerySchemeInfo[] = [
  {
    id: 'deepseek-account',
    scope: 'account',
    labelKey: 'querySchemes.deepseekAccount',
    descriptionKey: 'querySchemes.deepseekAccountDescription',
    credentialRequirements: ['apiKey'],
    supportsWindows: false,
    script: DEEPSEEK_SCRIPT,
  },
  {
    id: 'newapi-account',
    scope: 'account',
    labelKey: 'querySchemes.newApiAccount',
    descriptionKey: 'querySchemes.newApiAccountDescription',
    credentialRequirements: ['accessToken', 'userId'],
    supportsWindows: false,
    script: NEWAPI_SCRIPT,
  },
  {
    id: 'opencode-go-account',
    scope: 'account',
    labelKey: 'querySchemes.openCodeGoAccount',
    descriptionKey: 'querySchemes.openCodeGoAccountDescription',
    credentialRequirements: ['apiKey'],
    supportsWindows: true,
    script: GO_SCRIPT,
  },
]

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
  iconDelete.mockReset()
  iconDelete.mockResolvedValue({ deleted: true, usedBy: [] })
  presets.mockReset()
  checkScript.mockReset()
  checkScript.mockResolvedValue({ url: 'https://relay.example.com', method: 'GET', headers: {} })
  presets.mockResolvedValue([custom, deepseek])
  schemes.mockReset()
  schemes.mockResolvedValue(accountSchemes)
  testDraft.mockReset()
  testDraft.mockResolvedValue({
    scope: 'account',
    usage: { remaining: 10, unit: 'USD', isUnlimited: false },
    isValid: true,
    invalidMessage: null,
    error: null,
  })
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

/** The request-header editor in advanced settings, after the query block. */
function headersEditor(): HTMLTextAreaElement {
  return document.body.querySelectorAll<HTMLTextAreaElement>('textarea[class*="queryEditor"]')[0]!
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
  await settle()
  return onSave
}

/** The scheme catalogue arrives and recognition has been applied. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function clickPreset(index: number) {
  const chips = document.body.querySelectorAll('[class*="presetChip"]')
  await act(async () => {
    ;(chips[index] as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await settle()
}

/** The section picks a scheme by opening its dropdown and choosing an option. */
async function chooseScheme(label: string) {
  const trigger = document.body.querySelector('.ant-select input[role="combobox"]')
  expect(trigger).not.toBeNull()
  await act(async () => {
    ;(trigger as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const option = Array.from(document.body.querySelectorAll('.ant-select-item-option')).find(
    (item) => item.textContent === label,
  )
  expect(option).toBeDefined()
  await act(async () => {
    ;(option as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await settle()
}

/** The selected scheme, read from the select's own rendering. */
function schemeSelectValue(): string {
  return (
    document.body
      .querySelector('.ant-select')
      ?.querySelector('.ant-select-content-value')
      ?.getAttribute('title') ?? ''
  )
}

async function clickButton(text: string) {
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (item) => item.textContent === text,
  )!
  expect(button).toBeDefined()
  await act(async () => {
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await settle()
}

function scriptEditor(): HTMLTextAreaElement | undefined {
  const node = document.body.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="querySchemes.customScriptLabel"]',
  )
  return node ?? undefined
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
  await settle()
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
  await settle()
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
    queryConfig: null,
    ...overrides,
  }
}

function iconDeleteDialog(): HTMLElement {
  return [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].find((dialog) =>
    dialog.textContent?.includes('providers.deleteIconConfirm'),
  )!
}

async function beginIconDelete(filename: string) {
  const button = document.body.querySelector<HTMLButtonElement>(
    `button[aria-label="providers.deleteIcon: ${filename}"]`,
  )
  expect(button).not.toBeNull()
  await act(async () => button!.click())
}

async function confirmIconDelete() {
  const button = [...iconDeleteDialog().querySelectorAll('button')].find(
    (item) => item.textContent === 'common.delete',
  )!
  await act(async () => button.click())
}

it('offers deletion only for uploaded icons and cancel keeps the draft and file', async () => {
  iconList.mockResolvedValue({ uploaded: ['cancel-upload.png'] })
  await render(null)
  expect(
    document.body.querySelectorAll('button[aria-label^="providers.deleteIcon:"]'),
  ).toHaveLength(1)
  await act(async () =>
    document.body.querySelector<HTMLButtonElement>('[aria-label="cancel-upload.png"]')!.click(),
  )
  await beginIconDelete('cancel-upload.png')
  expect(iconDeleteDialog().textContent).toContain('providers.deleteIconIrreversible')
  const cancel = [...iconDeleteDialog().querySelectorAll('button')].find(
    (item) => item.textContent === 'common.cancel',
  )!
  await act(async () => cancel.click())
  expect(iconDelete).not.toHaveBeenCalled()
  expect(
    document.body.querySelector('[aria-label="cancel-upload.png"]')?.getAttribute('aria-pressed'),
  ).toBe('true')
})

it('deletes only after confirmation and clears a selected unsaved icon draft', async () => {
  iconList.mockResolvedValue({ uploaded: ['delete-draft.png', 'keep-upload.png'] })
  const onSave = await render(null)
  await fillRequiredFields()
  await act(async () =>
    document.body.querySelector<HTMLButtonElement>('[aria-label="delete-draft.png"]')!.click(),
  )
  await beginIconDelete('delete-draft.png')
  expect(iconDelete).not.toHaveBeenCalled()
  await confirmIconDelete()
  expect(iconDelete).toHaveBeenCalledExactlyOnceWith('delete-draft.png')
  expect(document.body.querySelector('[aria-label="delete-draft.png"]')).toBeNull()
  expect(document.body.querySelector('[aria-label="keep-upload.png"]')).not.toBeNull()
  await submit()
  expect(onSave.mock.calls[0][0].icon).toBeUndefined()
})

it('keeps the selected icon and names providers when the backend refuses an in-use file', async () => {
  iconList.mockResolvedValue({ uploaded: ['in-use.png'] })
  iconDelete.mockResolvedValue({
    deleted: false,
    usedBy: [{ id: 'provider-1', name: 'Live provider' }],
  })
  await render(providerFixture({ icon: 'in-use.png' }))
  await beginIconDelete('in-use.png')
  await confirmIconDelete()
  expect(iconDeleteDialog().textContent).toContain('providers.iconInUseHint')
  expect(iconDeleteDialog().textContent).toContain('Live provider')
  expect(
    document.body.querySelector('[aria-label="in-use.png"]')?.getAttribute('aria-pressed'),
  ).toBe('true')
  expect(iconDeleteDialog().querySelector('button.ant-btn-primary')?.hasAttribute('disabled')).toBe(
    true,
  )
})

it('keeps the file and selected draft visible when deletion fails', async () => {
  iconList.mockResolvedValue({ uploaded: ['failed-delete.png'] })
  iconDelete.mockRejectedValue(new Error('disk unavailable'))
  await render(providerFixture({ icon: 'failed-delete.png' }))
  await beginIconDelete('failed-delete.png')
  await confirmIconDelete()
  expect(iconDeleteDialog().textContent).toContain('providers.iconDeleteFailed')
  expect(
    document.body.querySelector('[aria-label="failed-delete.png"]')?.getAttribute('aria-pressed'),
  ).toBe('true')
})

it('ignores a list reply that arrives after successful deletion', async () => {
  let resolve!: (value: { uploaded: string[] }) => void
  iconList.mockReturnValue(
    new Promise<{ uploaded: string[] }>((done) => {
      resolve = done
    }),
  )
  await render(providerFixture({ icon: 'file:///old/library/late-list.png' }))
  await beginIconDelete('late-list.png')
  await confirmIconDelete()
  await act(async () => resolve({ uploaded: ['late-list.png'] }))
  expect(document.body.querySelector('[aria-label="late-list.png"]')).toBeNull()
})

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

it('starts a new provider with the query off, no scheme and an empty script', async () => {
  await render(null)

  // The account query is a section to configure, not a code template to read:
  // nothing here enables itself, and no starter script exists any more (D3).
  expect(document.body.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
  expect(document.body.textContent).toContain('providers.accountQuerySection')
  expect(document.body.textContent).not.toContain('providers.scriptPlaceholder')
  // No query configuration exists yet, so the editor has nothing to show.
  expect(scriptEditor()).toBeUndefined()
  expect(schemeSelectValue()).toBe('')
})

it('recognises a chosen preset script and pre-fills the scheme without enabling it', async () => {
  await render(null)
  await clickPreset(1) // deepseek

  expect(fieldValue('baseUrl')).toBe('https://api.deepseek.com')
  expect(fieldValue('name')).toBe('deepseek')
  // Display-only recognition: the scheme marker shows, the switch stays off,
  // and the script text lives behind the custom affordance (D3).
  expect(schemeSelectValue()).toBe('querySchemes.deepseekAccount')
  expect(document.body.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')

  await clickButton('querySchemes.basedOnScheme')
  expect(scriptEditor()?.value).toBe(DEEPSEEK_SCRIPT)
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

it('clears the query the same way the blank template clears the other fields', async () => {
  await render(null)

  await clickPreset(1)
  expect(schemeSelectValue()).toBe('querySchemes.deepseekAccount')

  // The blank template owns the query field too: it empties it and clears the
  // marker, and nothing re-enables by itself (D3).
  await clickPreset(0)
  expect(schemeSelectValue()).toBe('')
  expect(document.body.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
  expect(document.body.textContent).not.toContain('querySchemes.customize')
})

it('stores a preset script as a parked, disabled configuration', async () => {
  const onSave = await render(null)
  await clickPreset(1)
  await submit()

  expect(onSave).toHaveBeenCalledTimes(1)
  expect(onSave.mock.calls[0][0]).toMatchObject({
    presetId: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    name: 'deepseek',
    walletBalanceScript: DEEPSEEK_SCRIPT,
    walletBalanceType: 'custom',
    // Prefill is not configuration: the switch the user never touched stays
    // off, and the scheme marker records where the script came from (D3).
    queryConfig: { enabled: false, schemeId: 'deepseek-account' },
    usageType: 'none',
  })
  expect(onSave.mock.calls[0][0].defaultKeyConfig).toMatchObject({
    types: ['claude_code', 'codex'],
  })
})

it('saves the script as the user edited it, not as the preset shipped it', async () => {
  const onSave = await render(null)
  await clickPreset(1)

  await clickButton('querySchemes.basedOnScheme')
  await typeInto(scriptEditor()!, '({ request: { url: "https://x/y" }, extractor: () => ({}) })')
  await submit()

  expect(onSave.mock.calls[0][0].walletBalanceScript).toBe(
    '({ request: { url: "https://x/y" }, extractor: () => ({}) })',
  )
  expect(onSave.mock.calls[0][0].queryConfig).toMatchObject({
    enabled: false,
    schemeId: 'custom',
  })
})

it('checks the script before saving, and refuses one the engine rejects', async () => {
  checkScript.mockRejectedValue('第 1 行无法识别')
  const onSave = await render(null)

  // The offline check runs on the text that will be stored. Reaching the code
  // is always a user decision: pick custom in the scheme select, then enter the
  // script, then save — nothing was ever sent.
  await fillRequiredFields()
  await chooseScheme('querySchemes.customize')
  await clickButton('querySchemes.customize')
  await typeInto(scriptEditor()!, 'not a script')
  await submit()

  expect(checkScript).toHaveBeenCalledWith(expect.any(String), 'https://relay.example.com')
  expect(onSave).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('第 1 行无法识别')
})

it('does not ask the engine about a provider with no query', async () => {
  const onSave = await render(null)
  await fillRequiredFields()
  await submit()

  expect(checkScript).not.toHaveBeenCalled()
  expect(onSave).toHaveBeenCalledTimes(1)
  expect(onSave.mock.calls[0][0].walletBalanceScript).toBeUndefined()
  expect(onSave.mock.calls[0][0].queryConfig).toEqual({ enabled: false, schemeId: 'custom' })
})

it('opens a saved query with the switch on and keeps the script behind the custom affordance', async () => {
  // A pre-config legacy row: no stored config, a non-empty script means on.
  const onSave = await render(
    providerFixture({
      walletBalanceScript: DEEPSEEK_SCRIPT,
      queryConfig: null,
    }),
  )

  expect(document.body.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
  expect(document.body.querySelectorAll('[class*="presetChip"]').length).toBe(0)
  expect(schemeSelectValue()).toBe('querySchemes.deepseekAccount')
  // The code is hidden until the explicit entry; nothing is lost by the reveal.
  expect(scriptEditor()).toBeUndefined()
  await submit()

  expect(onSave.mock.calls[0][0]).toMatchObject({
    id: 'provider-1',
    presetId: 'newapi',
    walletBalanceScript: DEEPSEEK_SCRIPT,
    queryConfig: { enabled: true, schemeId: 'deepseek-account' },
  })

  // Entering the code is an explicit choice: the marker becomes custom while
  // the script text stays verbatim.
  await clickButton('querySchemes.basedOnScheme')
  expect(scriptEditor()?.value).toBe(DEEPSEEK_SCRIPT)
})

it('classifies an unrecognised legacy script as custom with the original text preserved', async () => {
  const handWritten = '({ hand: "written" })'
  const onSave = await render(
    providerFixture({
      walletBalanceScript: handWritten,
      queryConfig: null,
    }),
  )

  // No catalogue entry owns the text, so the explicit custom entry is the
  // affordance and the original text is displayed in full (D5).
  expect(schemeSelectValue()).toBe('querySchemes.customize')
  await clickButton('querySchemes.customize')
  expect(scriptEditor()?.value).toBe(handWritten)
  await submit()

  expect(onSave.mock.calls[0][0]).toMatchObject({
    walletBalanceScript: handWritten,
    queryConfig: { enabled: true, schemeId: 'custom' },
  })
})

it('keeps the stored configuration and text when editing without touching the query', async () => {
  const stored = providerFixture({
    walletBalanceScript: '({ hand: "written" })',
    queryConfig: { enabled: false, schemeId: 'opencode-go-account' },
  })
  const onSave = await render(stored)

  await submit()

  expect(onSave.mock.calls[0][0]).toMatchObject({
    id: 'provider-1',
    walletBalanceScript: '({ hand: "written" })',
    walletBalanceType: 'custom',
    // The user's stored choice survives untouched (A5/D5).
    queryConfig: { enabled: false, schemeId: 'opencode-go-account' },
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

it('asks for the access credentials that the chosen scheme needs', async () => {
  presets.mockResolvedValue([custom, deepseek, newapi])

  await render(null)
  await clickPreset(1) // deepseek: borrows a saved key, no account token
  expect(document.body.querySelector('input#token')).toBeNull()
  expect(document.body.querySelector('input#walletBalanceUserId')).toBeNull()

  await clickPreset(2) // newapi: names both the account token and the user id
  expect(document.body.querySelector('input#token')).not.toBeNull()
  expect(document.body.querySelector('input#walletBalanceUserId')).not.toBeNull()
})

it('reuses an uploaded icon from the local library', async () => {
  iconList.mockResolvedValue({ uploaded: ['saved-logo.png'] })
  const onSave = await render(providerFixture())
  const icon = document.body.querySelector<HTMLButtonElement>('button[aria-label="saved-logo.png"]')
  expect(icon?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aWNvbg==')
  await act(async () => {
    icon!.click()
  })
  await submit()
  expect(onSave.mock.calls[0][0].icon).toBe('saved-logo.png')
})

it('persists an explicitly cleared account query', async () => {
  const onSave = await render(providerFixture({ walletBalanceScript: DEEPSEEK_SCRIPT }))
  await clickButton('querySchemes.basedOnScheme')

  await typeInto(scriptEditor()!, '')
  await submit()
  expect(onSave.mock.calls[0][0].walletBalanceScript).toBe('')
  expect(onSave.mock.calls[0][0].walletBalanceType).toBe('none')
})

it('picking a scheme writes the scheme script and leaves every other field alone', async () => {
  const provider = providerFixture({
    defaultKeyConfig: { types: ['claude_code', 'codex'] },
    requestHeaders: '{"X-Keep": "1"}',
  })
  const onSave = await render(provider)
  await chooseScheme('querySchemes.openCodeGoAccount')
  await submit()

  const saved = onSave.mock.calls[0][0]
  expect(saved.walletBalanceScript).toBe(GO_SCRIPT)
  expect(saved.queryConfig).toEqual({ enabled: true, schemeId: 'opencode-go-account' })
  // Query work never touches the rest of the provider (A7).
  expect(saved.name).toBe(provider.name)
  expect(saved.baseUrl).toBe(provider.baseUrl)
  expect(saved.requestHeaders).toBe('{\n  "X-Keep": "1"\n}')
  expect(saved.defaultKeyConfig).toEqual(provider.defaultKeyConfig ?? undefined)
  // The stored origin template is untouched by a scheme change.
  expect(saved.presetId).toBe('newapi')
})

it('offers the query schemes through one select, with nothing chosen for a new provider', async () => {
  await render(null)

  // The section owns the choice; a fresh provider shows the placeholder, not a
  // defaulted scheme (D3).
  expect(schemeSelectValue()).toBe('')
  expect(document.body.textContent).toContain('querySchemes.schemePlaceholder')
  const trigger = document.body.querySelector('.ant-select input[role="combobox"]')
  expect(trigger).not.toBeNull()
})

it('runs the draft test against the current provider draft and shows the answer', async () => {
  const provider = providerFixture({
    id: 'provider-1',
    baseUrl: 'https://custom.example.com',
    token: 'tok-draft',
  })
  await render(provider)

  await chooseScheme('querySchemes.deepseekAccount')
  await clickButton('querySchemes.test')
  await settle()

  // The account test sends the draft's address and account credentials; it
  // borrows a saved key server-side through the provider id, never a value.
  expect(testDraft).toHaveBeenCalledTimes(1)
  const input = testDraft.mock.calls[0][0]
  expect(input).toMatchObject({
    scope: 'account',
    baseUrl: 'https://custom.example.com',
    script: DEEPSEEK_SCRIPT,
    providerId: 'provider-1',
  })
  expect(input.apiKey).toBeUndefined()
  expect(document.body.textContent).toContain('querySchemes.testSuccess')
  expect(document.body.textContent).toContain('$10.00')
})
