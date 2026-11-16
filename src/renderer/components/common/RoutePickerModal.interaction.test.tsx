// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import { createRoot, type Root } from 'react-dom/client'
import type { ApiKey, Provider } from '@shared/types'
import RoutePickerModal from './RoutePickerModal'
import styles from './RoutePickerModal.module.css'
import type ProviderModal from '../providers/ProviderModal'
import type KeyEditModal from '../keys/KeyEditModal'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
const mocks = vi.hoisted(() => ({
  createProvider: vi.fn(),
  createApiKey: vi.fn(),
  api: {
    provider: { list: vi.fn() },
    apiKey: { list: vi.fn() },
    balance: { refresh: vi.fn() },
    keyUsage: { refresh: vi.fn() },
  },
}))
vi.mock('../../api', () => ({ getApi: () => mocks.api }))
vi.mock('../../stores/providerStore', () => ({
  useProviderStore: { getState: () => ({ createProvider: mocks.createProvider }) },
}))
vi.mock('../../stores/apiKeyStore', () => ({
  useApiKeyStore: { getState: () => ({ createApiKey: mocks.createApiKey }) },
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { value?: string }) =>
      values?.value === undefined ? key : `${key}:${values.value}`,
    i18n: { language: 'en' },
  }),
}))
// Keep real picker orchestration; only the independently tested resource forms are stubs.
vi.mock('../providers/ProviderModal', () => ({
  default: ({ onSave, onClose }: ComponentProps<typeof ProviderModal>) => (
    <div data-testid='provider-form'>
      <button onClick={onClose}>cancel-provider</button>
      <button
        onClick={async () => {
          await onSave({ name: 'Created provider', baseUrl: 'https://example.test' })
          onClose()
        }}
      >
        save-provider
      </button>
    </div>
  ),
}))
vi.mock('../keys/KeyEditModal', () => ({
  default: ({
    onSave,
    onClose,
    defaultProviderId,
    defaultClientKind,
  }: ComponentProps<typeof KeyEditModal>) => (
    <div data-testid='key-form' data-provider={defaultProviderId} data-client={defaultClientKind}>
      <button onClick={onClose}>cancel-key</button>
      <button
        onClick={async () => {
          await onSave({
            mode: 'create',
            providerId: defaultProviderId!,
            value: 'fake-test-key',
            types: [defaultClientKind ?? 'grok'],
          })
          onClose()
        }}
      >
        save-key
      </button>
    </div>
  ),
}))
Object.defineProperty(window, 'matchMedia', {
  writable: true,
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

const provider = {
  id: 'provider-1',
  name: 'Alpha provider',
  baseUrl: 'https://alpha.test',
  isActive: true,
} as Provider
const key = {
  id: 'key-1',
  providerId: provider.id,
  alias: 'Alpha key',
  priority: 0,
  types: ['codex'],
  isActive: true,
  isExhausted: false,
  cachedUsage: null,
  lastUsageCheckedAt: null,
} as ApiKey
let root: Root | undefined
let container: HTMLDivElement
let props: ComponentProps<typeof RoutePickerModal>
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
async function rerender(changes: Partial<typeof props> = {}) {
  props = { ...props, ...changes }
  await act(async () =>
    root!.render(
      <StyleProvider layer>
        <ConfigProvider theme={{ token: { motion: false } }}>
          <RoutePickerModal {...props} />
        </ConfigProvider>
      </StyleProvider>,
    ),
  )
  await flush()
}
async function render(changes: Partial<typeof props> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  props = {
    open: true,
    clientKind: 'codex',
    providers: [provider],
    apiKeys: [key],
    currentKeyId: key.id,
    onCancel: vi.fn(),
    onSelect: vi.fn().mockResolvedValue(undefined),
  }
  await rerender(changes)
}
function button(text: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (item) => item.textContent === text,
  )!
}
async function click(text: string) {
  await vi.waitFor(async () => {
    await flush()
    expect(button(text), text).toBeDefined()
  })
  await act(async () => button(text).click())
  await flush()
}
async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="resources.search"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function searchValue() {
  return document.querySelector<HTMLInputElement>('input[aria-label="resources.search"]')?.value
}

beforeEach(async () => {
  // Preload the mocked form modules so cold lazy imports settle within act.
  await act(async () => {
    await Promise.all([import('../providers/ProviderModal'), import('../keys/KeyEditModal')])
  })
  vi.resetAllMocks()
  mocks.api.provider.list.mockResolvedValue([provider])
  mocks.api.apiKey.list.mockResolvedValue([key])
  mocks.api.balance.refresh.mockResolvedValue({ isValid: true })
  mocks.api.keyUsage.refresh.mockResolvedValue({ isValid: true })
  mocks.createProvider.mockResolvedValue({
    ...provider,
    id: 'created-provider',
    name: 'Created provider',
  })
  mocks.createApiKey.mockResolvedValue({
    ...key,
    id: 'created-key',
    providerId: 'created-provider',
    alias: 'Created key',
  })
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = undefined
  container?.remove()
})

describe('Route picker interaction continuity', () => {
  it.each(['normal', 'empty', 'error'] as const)(
    'keeps header and confirmation outside the bounded body in the %s state',
    async (state) => {
      await render({
        title: 'A long route selection title '.repeat(12),
        ...(state === 'empty' ? { providers: [], apiKeys: [] } : {}),
        ...(state === 'error'
          ? { onSelect: vi.fn().mockRejectedValue(new Error('route rejected')) }
          : {}),
      })
      if (state === 'error') await click('resources.apply')
      const dialog = document.querySelector('[role="dialog"]')!
      const body = dialog.querySelector(`.${styles.modalBody}`)!
      const header = dialog.querySelector(`.${styles.modalHeader}`)!
      const footer = dialog.querySelector(`.${styles.modalFooter}`)!
      expect(dialog.closest('.ant-modal-centered')).not.toBeNull()
      expect(dialog.querySelector(`.${styles.modalContainer}`)).not.toBeNull()
      expect(header).not.toBeNull()
      expect(footer).not.toBeNull()
      expect(body).not.toBeNull()
      expect(body.contains(header)).toBe(false)
      expect(body.contains(footer)).toBe(false)
      expect(footer.contains(button('common.cancel'))).toBe(true)
      expect(footer.contains(button('resources.apply'))).toBe(true)
      expect(button('resources.apply').disabled).toBe(state === 'empty')
      if (state === 'error') expect(body.textContent).toContain('resources.failed')
      await click('common.cancel')
      expect(props.onCancel).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    ['resources.addProvider', 'cancel-provider'],
    ['resources.addKey', 'cancel-key'],
  ])('retains the search and selected route after canceling %s', async (entry, cancel) => {
    await render()
    await search('Alpha')
    await click(entry)
    await click(cancel)
    expect(searchValue()).toBe('Alpha')
    expect(document.querySelector('[role="button"][aria-pressed="true"]')?.textContent).toContain(
      'Alpha key',
    )
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(mocks.createApiKey).not.toHaveBeenCalled()
    expect(mocks.createProvider).not.toHaveBeenCalled()
  })

  it('creates a provider then a client-seeded key and returns without implicitly applying it', async () => {
    await render()
    await search('Alpha')
    await click('resources.addProvider')
    await click('save-provider')
    expect(document.querySelector('[data-testid="provider-form"]')).toBeNull()
    expect(document.querySelector('[data-testid="key-form"]')?.getAttribute('data-provider')).toBe(
      'created-provider',
    )
    expect(document.querySelector('[data-testid="key-form"]')?.getAttribute('data-client')).toBe(
      'codex',
    )
    await click('save-key')
    expect(searchValue()).toBe('Alpha')
    expect(document.querySelector('.ant-modal-footer')?.textContent).toContain(
      'Created provider / Created key',
    )
    expect(document.body.textContent).toContain('resources.created')
    expect(mocks.createProvider).toHaveBeenCalledTimes(1)
    expect(mocks.createApiKey).toHaveBeenCalledTimes(1)
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onCancel).not.toHaveBeenCalled()
    await click('resources.apply')
    expect(props.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: expect.objectContaining({ id: 'created-provider' }),
        apiKey: expect.objectContaining({ id: 'created-key' }),
      }),
    )
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })

  it('keeps the draft during parent refresh while honoring newly disabled resources', async () => {
    await render()
    await search('Alpha')
    await rerender({ providers: [{ ...provider }], apiKeys: [{ ...key, isActive: false }] })
    expect(searchValue()).toBe('Alpha')
    expect(document.querySelector('.ant-modal-footer')?.textContent).toContain(
      'Alpha provider / Alpha key',
    )
    expect(button('resources.apply').disabled).toBe(true)
    expect(props.onSelect).not.toHaveBeenCalled()
  })

  it('allows gateway selection regardless of the key client types', async () => {
    await render({
      context: 'gateway',
      clientKind: 'claude_code',
      apiKeys: [{ ...key, types: ['grok'] }],
    })
    expect(button('resources.apply').disabled).toBe(false)
    await click('resources.apply')
    expect(props.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: expect.objectContaining({ id: key.id, types: ['grok'] }) }),
    )
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })

  it('renders unknown quota as unknown rather than zero', async () => {
    await render()
    expect(document.body.textContent).toContain('resources.unknownQuota')
    expect(document.body.textContent).toContain('resources.never')
    expect(document.body.textContent).not.toContain('resources.remaining:0')
    expect(document.body.textContent).not.toContain('resources.total:0')
    expect(document.body.textContent).not.toContain('resources.used:0')
  })

  it('keeps a failed application open with the same query and selection', async () => {
    await render({ onSelect: vi.fn().mockRejectedValue(new Error('route rejected')) })
    await search('Alpha')
    await click('resources.apply')
    expect(document.body.textContent).toContain('resources.failed')
    expect(searchValue()).toBe('Alpha')
    expect(document.querySelector('.ant-modal-footer')?.textContent).toContain(
      'Alpha provider / Alpha key',
    )
    expect(button('resources.apply').disabled).toBe(false)
    expect(props.onCancel).not.toHaveBeenCalled()
  })

  it('ignores an obsolete quota-refresh snapshot when parent resources change', async () => {
    let resolveProviders!: (value: Provider[]) => void
    mocks.api.provider.list.mockReturnValue(
      new Promise<Provider[]>((resolve) => {
        resolveProviders = resolve
      }),
    )
    await render()
    await search('Alpha')
    await click('resources.refreshQuota')
    await rerender({
      providers: [{ ...provider, name: 'Alpha authoritative' }],
      apiKeys: [{ ...key, isActive: false }],
    })
    await act(async () => resolveProviders([provider]))
    await flush()
    expect(searchValue()).toBe('Alpha')
    expect(document.querySelector('.ant-modal-footer')?.textContent).toContain(
      'Alpha authoritative / Alpha key',
    )
    expect(button('resources.apply').disabled).toBe(true)
    expect(props.onSelect).not.toHaveBeenCalled()
  })
})
