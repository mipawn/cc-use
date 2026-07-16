// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App as AntdApp, ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import { createRoot } from 'react-dom/client'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const project = {
  id: 'project-1',
  name: 'cc-use',
  path: '/tmp/cc-use',
  remark: null,
  providerId: 'provider-1',
  apiKeyId: 'shared-key',
  cliType: 'claude_code',
  terminalType: 'terminal',
  prelaunchCommand: null,
  lastOpenedAt: null,
}

const provider = {
  id: 'provider-1',
  name: 'Provider 1',
  baseUrl: 'https://example.com',
  icon: null,
  isActive: true,
}

const createKey = (id: string, alias: string, types: string[]) => ({
  id,
  providerId: provider.id,
  alias,
  value: 'secret',
  types,
  priority: 0,
  isExhausted: false,
  isActive: true,
})

const keys = [
  createKey('shared-key', 'Shared Key', ['claude_code', 'grok']),
  createKey('claude-key', 'Claude Only Key', ['claude_code']),
  createKey('grok-key', 'Grok Only Key', ['grok']),
]

const projectStore = {
  projects: [project],
  fetchProjects: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
}

vi.mock('../api', () => ({
  getApi: () => ({
    terminal: { launch: vi.fn() },
    system: { selectFolder: vi.fn() },
  }),
}))

vi.mock('../stores/projectStore', () => ({
  useProjectStore: () => projectStore,
}))

vi.mock('../stores/providerStore', () => ({
  useProviderStore: () => ({ providers: [provider], fetchProviders: vi.fn() }),
}))

vi.mock('../stores/apiKeyStore', () => ({
  useApiKeyStore: () => ({
    fetchAllApiKeys: vi.fn(),
    getAllApiKeys: () => keys,
    apiKeys: { [provider.id]: keys },
  }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('simplebar-react', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver

async function flushRender() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('Projects page', () => {
  it('shares projects but only shows Grok keys in the Grok card menu', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const { default: Projects } = await import('./Projects')

    await act(async () => {
      root.render(
        <StyleProvider layer>
          <ConfigProvider>
            <AntdApp>
              <Projects defaultCliType='grok' />
            </AntdApp>
          </ConfigProvider>
        </StyleProvider>,
      )
    })
    await flushRender()

    expect(container.textContent).toContain('cc-use')

    const switchButton = container.querySelector('.anticon-swap')?.closest('button')
    expect(switchButton).toBeTruthy()

    await act(async () => {
      switchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flushRender()

    expect(document.body.textContent).toContain('Grok Only Key')
    expect(document.body.textContent).toContain('Shared Key')
    expect(document.body.textContent).not.toContain('Claude Only Key')

    const grokKeyLabel = Array.from(document.body.querySelectorAll('span')).find(
      (element) => element.textContent === 'Grok Only Key',
    )
    await act(async () => {
      grokKeyLabel?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(projectStore.updateProject).toHaveBeenCalledWith({
      id: project.id,
      providerId: provider.id,
      apiKeyId: 'grok-key',
      cliType: 'grok',
    })

    await act(async () => root.unmount())
  })
})
