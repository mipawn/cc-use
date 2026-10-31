// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import type { ApiKey, Gateway, Provider } from '@shared/types'
import GatewayPage from './GatewayPage'
import { useApiKeyStore } from '../stores/apiKeyStore'
import { useProviderStore } from '../stores/providerStore'
import { useProviderModelCatalogStore } from '../stores/providerModelCatalogStore'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  modelCatalogPreview: vi.fn(),
  getModelCatalog: vi.fn(),
  apiKeyList: vi.fn(),
  providerList: vi.fn(),
  lanAddresses: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  writeText: vi.fn(),
  settings: { proxyPort: 22345, proxyListenScope: 'loopback' as 'loopback' | 'lan' },
}))

const provider = {
  id: 'provider-1',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/anthropic',
  requestHeaders: '{"User-Agent":"deepseek-default/1.0"}',
  isActive: true,
} as unknown as Provider
const relayProvider = {
  id: 'provider-2',
  name: 'Relay',
  baseUrl: 'https://relay.example.com',
  requestHeaders: null,
  isActive: true,
} as unknown as Provider
const apiKey = {
  id: 'key-1',
  providerId: 'provider-1',
  alias: 'main',
  value: 'sk-real',
  isActive: true,
  isExhausted: false,
} as unknown as ApiKey
const relayKey = {
  id: 'key-2',
  providerId: 'provider-2',
  alias: 'relay-main',
  value: 'sk-relay',
  isActive: true,
  isExhausted: false,
} as unknown as ApiKey

const gateway: Gateway = {
  sessionToken: 'session-abcdefghijklmnopqrstuvwxyz',
  displayName: 'Work',
  providerId: 'provider-1',
  providerName: 'DeepSeek',
  apiKeyId: 'key-1',
  keyAlias: 'main',
  isActive: true,
  createdAt: '2026-10-26T00:00:00Z',
  lastSeenAt: '2026-10-26T00:00:00Z',
  modelPolicy: { mode: 'all' },
  connectionConfig: {
    baseUrl: 'https://gateway.example.com/v1',
    authScheme: 'x-api-key',
    userAgent: 'gateway-agent/2.0',
  },
}

const plainGateway: Gateway = {
  ...gateway,
  displayName: 'Default route',
  connectionConfig: { baseUrl: null, authScheme: 'bearer', userAgent: null },
}

const previewCatalog = {
  models: [
    { id: 'deepseek-chat', displayName: 'DeepSeek Chat' },
    { id: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner' },
  ],
  fetchedAt: '2026-10-28T00:00:00Z',
  fromCache: false,
}

vi.mock('../api', () => ({
  getApi: () => ({
    gateway: {
      list: mocks.list,
      create: mocks.create,
      update: mocks.update,
      delete: mocks.delete,
      modelCatalogPreview: mocks.modelCatalogPreview,
    },
    provider: { list: mocks.providerList, getModelCatalog: mocks.getModelCatalog },
    apiKey: { list: mocks.apiKeyList },
    proxy: { lanAddresses: mocks.lanAddresses },
  }),
}))
vi.mock('../hooks/useServiceStatus', () => ({
  useServiceStatus: () => ({ status: { isRunning: true }, restart: vi.fn(), loading: false }),
}))
vi.mock('../stores/settingsStore', () => ({
  useSettingsStore: (
    selector: (state: {
      globalSettings: { proxyPort: number; proxyListenScope: 'loopback' | 'lan' }
    }) => unknown,
  ) => selector({ globalSettings: mocks.settings }),
}))
vi.mock('../hooks/usePageRefresh', () => ({ usePageRefresh: () => {} }))
vi.mock('../hooks/useAppMessage', () => ({
  useAppMessage: () => ({ success: mocks.success, error: mocks.error }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('simplebar-react', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
})
Object.defineProperty(window, 'matchMedia', {
  value: () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }),
})
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText: mocks.writeText },
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  useApiKeyStore.setState({ apiKeys: {}, loading: {} })
  useProviderStore.setState({ providers: [], loading: false, error: null })
  mocks.list.mockResolvedValue([gateway])
  mocks.providerList.mockResolvedValue([provider, relayProvider])
  mocks.apiKeyList.mockImplementation(async (providerId: string) =>
    providerId === 'provider-1' ? [apiKey] : [relayKey],
  )
  mocks.create.mockResolvedValue(gateway)
  mocks.update.mockImplementation(async (_sessionToken: string, changes: object) => ({
    ...gateway,
    ...changes,
  }))
  mocks.delete.mockResolvedValue(true)
  mocks.modelCatalogPreview.mockResolvedValue(previewCatalog)
  mocks.getModelCatalog.mockResolvedValue({
    models: previewCatalog.models,
    revision: 1,
    updatedAt: null,
  })
  useProviderModelCatalogStore.setState({ catalogs: {}, loading: {}, errors: {}, requests: {} })
  mocks.writeText.mockResolvedValue(undefined)
  mocks.settings.proxyListenScope = 'loopback'
  mocks.lanAddresses.mockResolvedValue({ port: 22345, scope: 'loopback', addresses: [] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

/** Let the async store loads, antd portals and preview promises settle. */
async function flush() {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function renderPage() {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <GatewayPage />
      </MemoryRouter>,
    ),
  )
  await flush()
}

function modal(): HTMLElement {
  const element = document.body.querySelector<HTMLElement>('.ant-modal')
  expect(element).not.toBeNull()
  return element!
}

function modalBody(): HTMLElement {
  const element = modal().querySelector<HTMLElement>('.ant-modal-body')
  expect(element).not.toBeNull()
  return element!
}

function buttonByText(text: string, scope: ParentNode = document.body): HTMLButtonElement {
  const match = Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => (button.textContent ?? '').trim() === text,
  )
  expect(match).toBeDefined()
  return match!
}

async function click(element: Element | null) {
  expect(element).not.toBeNull()
  await act(async () => {
    ;(element as HTMLElement).click()
  })
  await flush()
}

async function fill(element: Element | null, value: string) {
  expect(element).not.toBeNull()
  const input = element as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

function input(selector: string, scope: ParentNode = document.body): HTMLInputElement | null {
  return scope.querySelector<HTMLInputElement>(selector)
}

async function openCreate() {
  await click(buttonByText('gateway.create'))
}

async function openEdit() {
  await click(container.querySelector('button[aria-label="common.edit"]'))
}

async function chooseSelect(index: number, optionText: string) {
  const selects = Array.from(modalBody().querySelectorAll<HTMLElement>('.ant-select'))
  expect(selects[index]).toBeDefined()
  const combobox = selects[index].querySelector<HTMLElement>('[role="combobox"]')
  expect(combobox).not.toBeNull()
  await act(async () => {
    combobox!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  await flush()
  const option = Array.from(
    document.body.querySelectorAll<HTMLElement>('.ant-select-item-option'),
  ).find((candidate) => (candidate.textContent ?? '').includes(optionText))
  expect(option).toBeDefined()
  await click(option!)
}

async function choosePolicy(mode: 'all' | 'selected') {
  await click(modalBody().querySelector(`input[type="radio"][value="${mode}"]`))
}

async function saveModal() {
  await click(buttonByText('common.save', modal()))
}

it('shows the address, binding, local key and effective connection summary', async () => {
  await renderPage()

  const text = container.textContent ?? ''
  expect(text).toContain('Work')
  expect(text).toContain('DeepSeek / main')
  expect(text).toContain('http://127.0.0.1:22345')
  expect(text).toContain('session-abcd')
  expect(text).toContain('https://gateway.example.com/v1')
  expect(text).toContain('gateway.urlOverride')
  expect(text).toContain('gateway.authXApiKey')
  expect(text).toContain('gateway-agent/2.0')
})

it('falls back to the provider default and warns about an unusable bound key', async () => {
  mocks.list.mockResolvedValue([plainGateway])
  mocks.apiKeyList.mockResolvedValue([{ ...apiKey, isExhausted: true }])
  await renderPage()

  const text = container.textContent ?? ''
  expect(text).toContain('https://api.deepseek.com/anthropic')
  expect(text).toContain('gateway.urlDefault')
  expect(text).toContain('gateway.authBearer')
  expect(text).toContain('gateway.userAgentFollow')
  expect(text).toContain('gateway.keyUnavailable')
})

it('no longer renders the two long explanatory paragraphs', async () => {
  await renderPage()

  const text = container.textContent ?? ''
  expect(text).not.toContain('gateway.usageHint')
  expect(text).not.toContain('gateway.userAgentHint')
})

it('toggles a gateway and copies/reveals its local key', async () => {
  await renderPage()
  mocks.update.mockResolvedValue({ ...gateway, isActive: false })

  const toggle = container.querySelector('button[role="switch"]')
  await click(toggle)
  expect(mocks.update).toHaveBeenCalledWith(gateway.sessionToken, { isActive: false })

  await click(container.querySelector('button[aria-label="gateway.copyAddress"]'))
  expect(mocks.writeText).toHaveBeenCalledWith('http://127.0.0.1:22345')
  await click(container.querySelector('button[aria-label="gateway.copyKey"]'))
  expect(mocks.writeText).toHaveBeenLastCalledWith(gateway.sessionToken)
  expect(container.textContent).not.toContain(gateway.sessionToken)
  await click(container.querySelector('button[aria-label="gateway.localKey"]'))
  expect(container.textContent).toContain(gateway.sessionToken)
})

it('deletes a gateway only after the confirmation', async () => {
  await renderPage()
  await click(container.querySelector('button[aria-label="common.delete"]'))

  const popover =
    document.body.querySelector<HTMLElement>('.ant-popconfirm') ??
    document.body.querySelector<HTMLElement>('.ant-popover')
  expect(popover).not.toBeNull()
  const confirm = Array.from(popover!.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => (button.textContent ?? '').trim() === 'common.delete',
  )
  await click(confirm ?? null)

  expect(mocks.delete).toHaveBeenCalledWith(gateway.sessionToken)
  expect(mocks.success).toHaveBeenCalledWith('gateway.deleted')
})

it('shows an empty state when there are no gateways', async () => {
  mocks.list.mockResolvedValue([])
  await renderPage()

  expect(container.textContent).toContain('gateway.empty')
})

it('opens the editor with the stored connection overrides', async () => {
  await renderPage()
  await openEdit()

  expect(modal().textContent).toContain('gateway.edit')
  expect(modalBody().textContent).toContain('gateway.connection')
  expect(input('#gateway-base-url')?.value).toBe('https://gateway.example.com/v1')
  expect(input('#gateway-user-agent')?.value).toBe('gateway-agent/2.0')
  expect(modalBody().textContent).toContain('gateway.authXApiKey')
  expect(modalBody().textContent).toContain('gateway.baseUrlDefault')
})

it('restores the provider default address and saves null for it', async () => {
  await renderPage()
  await openEdit()

  await click(buttonByText('gateway.restoreDefault', modal()))
  expect(input('#gateway-base-url')?.value).toBe('')
  await saveModal()

  expect(mocks.update).toHaveBeenCalledWith(gateway.sessionToken, {
    name: 'Work',
    providerId: 'provider-1',
    apiKeyId: 'key-1',
    modelPolicy: { mode: 'all' },
    connectionConfig: {
      baseUrl: null,
      authScheme: 'x-api-key',
      userAgent: 'gateway-agent/2.0',
    },
  })
  expect(mocks.success).toHaveBeenCalledWith('gateway.saved')
})

it('keeps the stored overrides when only the name changes', async () => {
  await renderPage()
  await openEdit()

  await fill(input('#gateway-name'), 'Renamed')
  await saveModal()

  expect(mocks.update).toHaveBeenCalledWith(gateway.sessionToken, {
    name: 'Renamed',
    providerId: 'provider-1',
    apiKeyId: 'key-1',
    modelPolicy: { mode: 'all' },
    connectionConfig: {
      baseUrl: 'https://gateway.example.com/v1',
      authScheme: 'x-api-key',
      userAgent: 'gateway-agent/2.0',
    },
  })
})

it('keeps the stored overrides when the bound provider and key change', async () => {
  await renderPage()
  await openEdit()

  await chooseSelect(0, 'Relay')
  await chooseSelect(1, 'relay-main')
  await saveModal()

  expect(mocks.update).toHaveBeenCalledWith(gateway.sessionToken, {
    name: 'Work',
    providerId: 'provider-2',
    apiKeyId: 'key-2',
    modelPolicy: { mode: 'all' },
    connectionConfig: {
      baseUrl: 'https://gateway.example.com/v1',
      authScheme: 'x-api-key',
      userAgent: 'gateway-agent/2.0',
    },
  })
})

it('creates a gateway with the full connection draft object', async () => {
  mocks.list.mockResolvedValue([])
  await renderPage()
  await openCreate()

  await fill(input('#gateway-name'), 'New route')
  await chooseSelect(0, 'Relay')
  await chooseSelect(1, 'relay-main')
  await click(modalBody().querySelector('.ant-collapse-header'))
  await chooseSelect(2, 'gateway.authXApiKey')
  await fill(input('#gateway-base-url'), 'https://custom.example.com/v1')
  await fill(input('#gateway-user-agent'), 'custom-agent/1.0')
  await saveModal()

  expect(mocks.create).toHaveBeenCalledWith(
    'New route',
    'provider-2',
    'key-2',
    {
      baseUrl: 'https://custom.example.com/v1',
      authScheme: 'x-api-key',
      userAgent: 'custom-agent/1.0',
    },
    { mode: 'all' },
  )
  expect(mocks.success).toHaveBeenCalledWith('gateway.saved')
})

it('keeps validation inline, never echoes secrets and does not save an invalid draft', async () => {
  mocks.list.mockResolvedValue([])
  await renderPage()
  await openCreate()

  await saveModal()
  expect(modalBody().textContent).toContain('gateway.required')
  expect(mocks.create).not.toHaveBeenCalled()

  await fill(input('#gateway-name'), 'Bad route')
  await chooseSelect(0, 'DeepSeek')
  await chooseSelect(1, 'main')
  await fill(input('#gateway-base-url'), 'http://user:pass@example.com/v1')
  expect(modalBody().textContent).toContain('gateway.invalidBaseUrl')
  await saveModal()

  expect(mocks.create).not.toHaveBeenCalled()
  expect(modalBody().textContent).not.toContain('sk-real')
})

it('creates without a model query and defaults to all models and Bearer', async () => {
  mocks.list.mockResolvedValue([])
  await renderPage()
  await openCreate()
  await fill(input('#gateway-name'), 'Default')
  await chooseSelect(0, 'DeepSeek')
  await chooseSelect(1, 'main')
  expect(document.body.querySelector('.ant-collapse-content-active')).toBeNull()
  expect(modalBody().textContent).not.toContain('gateway.fetchModels')
  expect(modalBody().textContent).not.toContain('gateway.modelPreview')
  await saveModal()
  expect(mocks.create).toHaveBeenCalledWith(
    'Default',
    'provider-1',
    'key-1',
    {
      baseUrl: null,
      authScheme: 'bearer',
      userAgent: null,
    },
    { mode: 'all' },
  )
  expect(mocks.modelCatalogPreview).not.toHaveBeenCalled()
})

it('requires a nonempty selected set and saves IDs from the provider catalog', async () => {
  await renderPage()
  await openEdit()
  await choosePolicy('selected')
  await saveModal()
  expect(modalBody().textContent).toContain('gateway.selectModelsRequired')
  expect(mocks.update).not.toHaveBeenCalled()
  await chooseSelect(2, 'DeepSeek Chat')
  await saveModal()
  expect(mocks.update).toHaveBeenCalledWith(
    gateway.sessionToken,
    expect.objectContaining({
      modelPolicy: { mode: 'selected', modelIds: ['deepseek-chat'] },
    }),
  )
  expect(mocks.modelCatalogPreview).not.toHaveBeenCalled()
})

it('retains missing selected IDs and restrictions through binding changes and catalog failures', async () => {
  mocks.list.mockResolvedValue([
    { ...gateway, modelPolicy: { mode: 'selected', modelIds: ['legacy-model'] } },
  ])
  mocks.getModelCatalog.mockRejectedValue('offline')
  await renderPage()
  await openEdit()
  expect(modalBody().textContent).toContain('legacy-model')
  expect(modalBody().textContent).toContain('gateway.catalogLoadFailed')
  await chooseSelect(0, 'Relay')
  await chooseSelect(1, 'relay-main')
  await saveModal()
  expect(mocks.update).toHaveBeenCalledWith(
    gateway.sessionToken,
    expect.objectContaining({
      providerId: 'provider-2',
      apiKeyId: 'key-2',
      modelPolicy: { mode: 'selected', modelIds: ['legacy-model'] },
    }),
  )
})

it('changing a restriction requires explicit save and cancel keeps the stored policy', async () => {
  mocks.list.mockResolvedValue([
    { ...gateway, modelPolicy: { mode: 'selected', modelIds: ['legacy-model'] } },
  ])
  await renderPage()
  await openEdit()
  await choosePolicy('all')
  await click(buttonByText('common.cancel', modal()))
  expect(mocks.update).not.toHaveBeenCalled()
  await openEdit()
  expect(modalBody().textContent).toContain('legacy-model')
  expect(
    modalBody().querySelector<HTMLInputElement>('input[type="radio"][value="selected"]')?.checked,
  ).toBe(true)
})

it('keeps an in-flight save attached to its editor until it finishes', async () => {
  let complete!: (value: Gateway) => void
  mocks.update.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve
    }),
  )
  await renderPage()
  await openEdit()
  await saveModal()
  expect(buttonByText('common.cancel', modal()).disabled).toBe(true)
  expect(modal().querySelector('.ant-modal-close')).toBeNull()
  await act(async () => {
    complete(gateway)
  })
  await flush()
  expect(mocks.success).toHaveBeenCalledWith('gateway.saved')
})

it('locks draft fields while saving and restores them after a failure', async () => {
  let rejectSave!: (error: Error) => void
  mocks.update.mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectSave = reject
    }),
  )
  await renderPage()
  await openEdit()
  await fill(input('#gateway-name', modalBody()), 'Renamed route')
  await saveModal()

  expect(input('#gateway-name', modalBody())!.disabled).toBe(true)
  expect(input('#gateway-base-url', modalBody())!.disabled).toBe(true)
  expect(
    modalBody().querySelector<HTMLInputElement>('input[type="radio"][value="selected"]')!.disabled,
  ).toBe(true)
  expect(
    modalBody()
      .querySelector<HTMLElement>('.ant-select')!
      .classList.contains('ant-select-disabled'),
  ).toBe(true)
  expect(buttonByText('common.cancel', modal()).disabled).toBe(true)

  await act(async () => rejectSave(new Error('write failed')))
  await flush()

  expect(mocks.error).toHaveBeenCalledWith('Error: write failed')
  expect(input('#gateway-name', modalBody())!.disabled).toBe(false)
  expect(input('#gateway-name', modalBody())!.value).toBe('Renamed route')
  expect(
    modalBody()
      .querySelector<HTMLElement>('.ant-select')!
      .classList.contains('ant-select-disabled'),
  ).toBe(false)
  expect(buttonByText('common.cancel', modal()).disabled).toBe(false)
  expect(buttonByText('common.save', modal()).classList.contains('ant-btn-loading')).toBe(false)
  expect(mocks.list).toHaveBeenCalledTimes(1)
})

it('does not let a previous post-save reload unlock a newer pending save', async () => {
  let completeReload!: (value: Gateway[]) => void
  let completeSecondSave!: (value: Gateway) => void
  mocks.list.mockResolvedValueOnce([gateway]).mockReturnValueOnce(
    new Promise((resolve) => {
      completeReload = resolve
    }),
  )
  mocks.update.mockResolvedValueOnce(gateway)
  mocks.create.mockReturnValueOnce(
    new Promise((resolve) => {
      completeSecondSave = resolve
    }),
  )
  await renderPage()
  await openEdit()
  await saveModal()
  expect(mocks.list).toHaveBeenCalledTimes(2)
  await openCreate()
  await fill(input('#gateway-name', modalBody()), 'Second route')
  await chooseSelect(0, 'DeepSeek')
  await chooseSelect(1, 'main')
  await saveModal()
  expect(mocks.create).toHaveBeenCalledOnce()
  expect(buttonByText('common.cancel', modal()).disabled).toBe(true)
  await act(async () => completeReload([gateway]))
  await flush()
  expect(buttonByText('common.cancel', modal()).disabled).toBe(true)
  expect(modal().querySelector('.ant-modal-close')).toBeNull()
  expect(buttonByText('common.save', modal()).classList.contains('ant-btn-loading')).toBe(true)
  await act(async () => completeSecondSave(gateway))
  await flush()
  expect(mocks.success).toHaveBeenCalledTimes(2)
})

it.each(['success', 'failure'] as const)(
  'ignores an older post-save list %s after a newer save refresh',
  async (outcome) => {
    const newerGateway: Gateway = {
      ...gateway,
      sessionToken: 'session-newer-synthetic-only',
      displayName: 'Second route',
    }
    let settleOlder!: () => void
    const olderRead = new Promise<Gateway[]>((resolve, reject) => {
      settleOlder = () => {
        if (outcome === 'failure') reject(new Error('older-list-failure'))
        else resolve([gateway])
      }
    })
    mocks.list
      .mockResolvedValueOnce([gateway])
      .mockReturnValueOnce(olderRead)
      .mockResolvedValueOnce([gateway, newerGateway])
    mocks.update.mockResolvedValueOnce(gateway)
    mocks.create.mockResolvedValueOnce(newerGateway)
    await renderPage()
    await openEdit()
    await saveModal()
    await openCreate()
    await fill(input('#gateway-name', modalBody()), 'Second route')
    await chooseSelect(0, 'DeepSeek')
    await chooseSelect(1, 'main')
    await saveModal()
    expect(mocks.list).toHaveBeenCalledTimes(3)
    expect(container.textContent).toContain('Second route')
    await act(async () => settleOlder())
    await flush()
    expect(container.textContent).toContain('Second route')
    expect(container.textContent).not.toContain('older-list-failure')
    expect(mocks.success).toHaveBeenCalledTimes(2)
  },
)

it('shows the LAN entries and copies them when LAN access is enabled', async () => {
  mocks.settings.proxyListenScope = 'lan'
  mocks.lanAddresses.mockResolvedValue({
    port: 22345,
    scope: 'lan',
    addresses: [
      { ip: '192.168.1.10', url: 'http://192.168.1.10:22345', interface: 'en0' },
      { ip: '10.0.0.8', url: 'http://10.0.0.8:22345', interface: null },
    ],
  })
  await renderPage()

  const text = container.textContent ?? ''
  expect(text).toContain('http://192.168.1.10:22345')
  expect(text).toContain('http://10.0.0.8:22345')
  expect(text).toContain('en0')
  expect(text).not.toContain('gateway.lanOffHint')
  // The local address row stays exactly as before.
  expect(text).toContain('http://127.0.0.1:22345')

  const copyButtons = container.querySelectorAll('button[aria-label="gateway.copyLanAddress"]')
  expect(copyButtons.length).toBe(2)
  await click(copyButtons[0])
  expect(mocks.writeText).toHaveBeenCalledWith('http://192.168.1.10:22345')
})

it('links to settings instead of listing LAN entries when only loopback is enabled', async () => {
  await renderPage()

  const text = container.textContent ?? ''
  expect(text).toContain('gateway.lanOffHint')
  expect(text).toContain('gateway.lanOpenSettings')
  const link = container.querySelector<HTMLAnchorElement>('a[href="/settings"]')
  expect(link).not.toBeNull()
  expect(container.querySelectorAll('button[aria-label="gateway.copyLanAddress"]').length).toBe(0)
  expect(text).toContain('http://127.0.0.1:22345')
})

it('explains a missing LAN address instead of rendering an empty list', async () => {
  mocks.settings.proxyListenScope = 'lan'
  mocks.lanAddresses.mockResolvedValue({ port: 22345, scope: 'lan', addresses: [] })
  await renderPage()

  expect(container.textContent).toContain('gateway.lanNoAddresses')
  expect(container.querySelectorAll('button[aria-label="gateway.copyLanAddress"]').length).toBe(0)
  expect(container.textContent).toContain('http://127.0.0.1:22345')
})

it('keeps the page usable when LAN discovery fails and retries inline', async () => {
  mocks.settings.proxyListenScope = 'lan'
  mocks.lanAddresses.mockRejectedValueOnce(new Error('discovery failed'))
  await renderPage()

  expect(container.textContent).toContain('gateway.lanLoadFailed')
  expect(container.textContent).toContain('http://127.0.0.1:22345')

  mocks.lanAddresses.mockResolvedValueOnce({
    port: 22345,
    scope: 'lan',
    addresses: [{ ip: '192.168.1.10', url: 'http://192.168.1.10:22345', interface: 'en0' }],
  })
  await click(buttonByText('common.retry'))
  expect(mocks.lanAddresses).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('http://192.168.1.10:22345')
})

it('shows binding review guidance only after the saved binding changes', async () => {
  mocks.list.mockResolvedValue([
    { ...gateway, modelPolicy: { mode: 'selected', modelIds: ['legacy-model'] } },
  ])
  await renderPage()
  await openEdit()
  expect(modalBody().textContent).not.toContain('gateway.bindingPolicyHint')
  await chooseSelect(0, 'Relay')
  await chooseSelect(1, 'relay-main')
  expect(modalBody().textContent).toContain('gateway.bindingPolicyHint')
  expect(modalBody().textContent).toContain('legacy-model')
  await chooseSelect(0, 'DeepSeek')
  await chooseSelect(1, 'main')
  expect(modalBody().textContent).not.toContain('gateway.bindingPolicyHint')
})

it('keeps the selected draft when switching exposure choices before saving', async () => {
  mocks.list.mockResolvedValue([
    { ...gateway, modelPolicy: { mode: 'selected', modelIds: ['legacy-model'] } },
  ])
  await renderPage()
  await openEdit()
  await choosePolicy('all')
  expect(modalBody().querySelector('#gateway-model-ids')).toBeNull()
  await choosePolicy('selected')
  expect(modalBody().textContent).toContain('legacy-model')
  await saveModal()
  expect(mocks.update).toHaveBeenCalledWith(
    gateway.sessionToken,
    expect.objectContaining({
      modelPolicy: { mode: 'selected', modelIds: ['legacy-model'] },
    }),
  )
})
