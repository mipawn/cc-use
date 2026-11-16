// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App as AntdApp, ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import type {
  DesktopClientKind,
  DesktopConnectionState,
  DesktopOperationResult,
} from '@shared/types'
import DesktopPage from './DesktopPage'
import en from '../locales/en'
import zh from '../locales/zh'
import type ProviderModal from '../components/providers/ProviderModal'
import type KeyEditModal from '../components/keys/KeyEditModal'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
const api = vi.hoisted(() => ({
  desktopConnection: { state: vi.fn(), apply: vi.fn(), restore: vi.fn() },
  provider: { list: vi.fn(), create: vi.fn() },
  apiKey: { list: vi.fn(), create: vi.fn() },
}))
vi.mock('../api', () => ({ getApi: () => api }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('../components/launchpad/ConfigPreviewButton', () => ({ default: () => null }))
vi.mock('../stores/providerStore', () => ({
  useProviderStore: { getState: () => ({ createProvider: api.provider.create }) },
}))
vi.mock('../stores/apiKeyStore', () => ({
  useApiKeyStore: { getState: () => ({ createApiKey: api.apiKey.create }) },
}))
// Exercise the real picker/page hand-off; resource form fields have their own tests.
vi.mock('../components/providers/ProviderModal', () => ({
  default: ({ onSave, onClose }: ComponentProps<typeof ProviderModal>) => (
    <button
      onClick={async () => {
        await onSave({ name: 'Test provider', baseUrl: 'https://fixture.invalid' })
        onClose()
      }}
    >
      create-provider
    </button>
  ),
}))
vi.mock('../components/keys/KeyEditModal', () => ({
  default: ({ onSave, onClose, defaultProviderId }: ComponentProps<typeof KeyEditModal>) => (
    <button
      onClick={async () => {
        await onSave({
          mode: 'create',
          providerId: defaultProviderId!,
          value: 'fixture-key',
          types: ['codex'],
        })
        onClose()
      }}
    >
      create-key
    </button>
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

const provider = { id: 'provider-1', name: 'Test provider', isActive: true }
const key = {
  id: 'key-1',
  providerId: provider.id,
  alias: 'Shared key',
  priority: 0,
  types: ['codex', 'claude_desktop'],
  isActive: true,
  isExhausted: false,
}
const connection = (
  clientKind: DesktopClientKind,
  overrides: Partial<DesktopConnectionState> = {},
): DesktopConnectionState => ({
  clientKind,
  status: 'official',
  route: null,
  lastConfigChange: null,
  syncFailure: null,
  warning: null,
  ...overrides,
})
const change = {
  action: 'takeover' as const,
  source: 'user' as const,
  changedAt: '2026-04-14T16:00:00Z',
  version: 1,
}
const takenOver = connection('codex', {
  status: 'taken_over',
  route: { providerId: provider.id, apiKeyId: key.id },
  lastConfigChange: change,
})
const result = (overrides: Partial<DesktopOperationResult> = {}): DesktopOperationResult => ({
  clientKind: 'codex',
  action: 'takeover',
  completion: 'complete',
  routeChanged: true,
  configChanged: true,
  modelCount: 2,
  nextAction: 'reopen_client',
  updatedAt: change.changedAt,
  warning: null,
  state: takenOver,
  ...overrides,
})
let root: Root | undefined
let container: HTMLDivElement
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
async function render() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <StyleProvider layer>
        <ConfigProvider theme={{ token: { motion: false } }}>
          <AntdApp>
            <MemoryRouter initialEntries={['/desktop?client=codex']}>
              <DesktopPage />
            </MemoryRouter>
          </AntdApp>
        </ConfigProvider>
      </StyleProvider>,
    ),
  )
  await flush()
}
async function click(text: string, scope: ParentNode = document) {
  const button = Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(
    (item) => item.textContent === text,
  )
  expect(button, `button ${text}`).toBeDefined()
  await act(async () => button!.click())
  await flush()
}
async function chooseRoute() {
  await click('desktopAccess.connect', container)
  const route = document.querySelector<HTMLElement>('.ant-modal [role="button"][aria-pressed]')!
  expect(route).not.toBeNull()
  await act(async () => route.click())
}
async function switchClient() {
  const label = Array.from(container.querySelectorAll<HTMLElement>('.ant-segmented-item')).find(
    (item) => item.textContent === 'Claude Desktop',
  )!
  await act(async () => label.click())
  await flush()
}

beforeEach(() => {
  vi.resetAllMocks()
  api.desktopConnection.state.mockImplementation((kind: DesktopClientKind) =>
    Promise.resolve(connection(kind)),
  )
  api.desktopConnection.apply.mockResolvedValue(result())
  api.provider.list.mockResolvedValue([provider])
  api.apiKey.list.mockResolvedValue([key])
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = undefined
  container?.remove()
})

describe('Desktop configuration feedback', () => {
  it.each(['user', 'startup', 'key_edit'] as const)(
    'describes %s sync failure without claiming unrelated key-save success',
    async (source) => {
      api.desktopConnection.state.mockResolvedValue(
        connection('codex', {
          syncFailure: {
            source,
            occurredAt: change.changedAt,
            message: 'Fixture configuration write failed',
          },
        }),
      )
      await render()
      const alert = container.querySelector('.ant-alert-error')
      expect(alert?.textContent).toContain('Fixture configuration write failed')
      if (source === 'key_edit') {
        expect(alert?.textContent).toContain('desktopAccess.syncFailed')
        expect(alert?.textContent).toContain('desktopAccess.syncFailedHint')
        expect(alert?.textContent).not.toContain('desktopAccess.configSyncFailed')
      } else {
        expect(alert?.textContent).toContain('desktopAccess.configSyncFailed')
        expect(alert?.textContent).not.toContain('desktopAccess.syncFailed')
        expect(alert?.textContent).not.toContain('desktopAccess.syncFailedHint')
      }
    },
  )

  it('keeps general and key-save sync failure copy distinct in both locales', () => {
    expect(en.desktopAccess.configSyncFailed).toBe('Configuration sync failed')
    expect(zh.desktopAccess.configSyncFailed).toBe('配置同步失败')
    expect(en.desktopAccess.syncFailed).toBe('Key saved, but desktop configuration sync failed')
    expect(zh.desktopAccess.syncFailed).toBe('密钥已保存，但桌面配置同步失败')
    expect(en.desktopAccess.syncFailedHint).toContain('Saving the key')
    expect(zh.desktopAccess.syncFailedHint).toContain('密钥配置')
  })

  it('shows a durable state warning when no partial operation result is present', async () => {
    api.desktopConnection.state.mockResolvedValue(
      connection('codex', { warning: 'Persisted configuration repair warning' }),
    )
    await render()
    expect(container.textContent).toContain('Persisted configuration repair warning')
    expect(container.textContent).not.toContain('desktopAccess.partial')
  })

  it('shows resources created in the picker immediately after applying without a reload', async () => {
    await Promise.all([
      import('../components/providers/ProviderModal'),
      import('../components/keys/KeyEditModal'),
    ])
    api.provider.list.mockResolvedValue([])
    api.apiKey.list.mockResolvedValue([])
    api.provider.create.mockResolvedValue(provider)
    api.apiKey.create.mockResolvedValue(key)
    await render()
    await click('desktopAccess.connect', container)
    await click('resources.addProvider')
    await vi.waitFor(() => expect(document.body.textContent).toContain('create-provider'))
    await click('create-provider')
    await vi.waitFor(() => expect(document.body.textContent).toContain('create-key'))
    await click('create-key')
    expect(api.desktopConnection.apply).not.toHaveBeenCalled()
    await click('desktopAccess.connect', document.querySelector('.ant-modal')!)
    expect(api.desktopConnection.apply).toHaveBeenCalledWith('codex', provider.id, key.id)
    expect(container.textContent).toContain('Test provider')
    expect(container.textContent).toContain('Shared key')
    expect(container.textContent).toContain('desktopAccess.models')
    expect(container.textContent).not.toContain('desktopAccess.resourceUnavailable')
    expect(api.provider.list).toHaveBeenCalledTimes(1)
    expect(api.desktopConnection.state).toHaveBeenCalledTimes(1)
  })

  it('reports a partial write as partial, keeps the picker open and preserves reload guidance after reread', async () => {
    const warning = 'route saved but catalog sync failed'
    const partialState = { ...takenOver, warning }
    api.desktopConnection.apply.mockResolvedValue(
      result({ completion: 'partial', warning, state: partialState }),
    )
    await render()
    await chooseRoute()
    api.desktopConnection.state.mockResolvedValue(partialState)
    await click('desktopAccess.connect', document.querySelector('.ant-modal')!)
    expect(api.desktopConnection.apply).toHaveBeenCalledWith('codex', provider.id, key.id)
    expect(api.desktopConnection.state).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('desktopAccess.partial')
    expect(container.textContent?.split(warning)).toHaveLength(2)
    expect(container.textContent).toContain('desktopAccess.lastConfigChange')
    expect(container.textContent).toContain('desktopAccess.reopenHint')
    expect(container.textContent).toContain('desktopAccess.noDetection')
    expect(document.querySelector('.ant-modal')?.textContent).toContain('resources.failed')
    expect(document.body.textContent).not.toContain('desktopAccess.configSaved')
    expect(document.body.textContent).not.toContain('desktopAccess.routeApplied')
  })

  it('retains known configuration-change instructions across a state refresh', async () => {
    api.desktopConnection.state.mockResolvedValue(takenOver)
    await render()
    expect(container.textContent).toContain('desktopAccess.reopenHint')
    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="common.refresh"]',
    )!
    await act(async () => refresh.click())
    await flush()
    expect(api.desktopConnection.state).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('desktopAccess.lastConfigChange')
    expect(container.textContent).toContain('desktopAccess.reopenHint')
    expect(container.textContent).toContain('desktopAccess.noDetection')
  })

  it('ignores a previous client state response after selecting a different client', async () => {
    let resolveCodex!: (state: DesktopConnectionState) => void
    const codex = new Promise<DesktopConnectionState>((resolve) => {
      resolveCodex = resolve
    })
    api.desktopConnection.state.mockImplementation((kind: DesktopClientKind) =>
      kind === 'codex' ? codex : Promise.resolve(connection(kind)),
    )
    await render()
    await switchClient()
    expect(api.desktopConnection.state).toHaveBeenCalledWith('claude_desktop')
    expect(container.textContent).toContain('desktopAccess.status.official')
    await act(async () =>
      resolveCodex(
        connection('codex', { warning: 'stale Codex warning', lastConfigChange: change }),
      ),
    )
    await flush()
    expect(container.textContent).not.toContain('stale Codex warning')
    expect(container.textContent).not.toContain('desktopAccess.lastConfigChange')
    expect(container.textContent).toContain('desktopAccess.status.official')
  })

  it('dismisses an old client restore confirmation without restoring the newly selected client', async () => {
    api.desktopConnection.state.mockImplementation((kind: DesktopClientKind) =>
      Promise.resolve(kind === 'codex' ? takenOver : connection(kind)),
    )
    await render()
    await click('desktopAccess.restore', container)
    expect(document.body.textContent).toContain('desktopAccess.restoreTitle')
    await switchClient()
    expect(document.querySelector('.ant-modal-confirm')).toBeNull()
    expect(api.desktopConnection.restore).not.toHaveBeenCalled()
  })
})
