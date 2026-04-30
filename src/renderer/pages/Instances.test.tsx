// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App as AntdApp, ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import { createRoot } from 'react-dom/client'

const apiMock = {
  managedInstances: {
    list: vi.fn(),
    updateAssignment: vi.fn(),
  },
  provider: {
    list: vi.fn(),
  },
  apiKey: {
    list: vi.fn(),
  },
}

vi.mock('../api', () => ({
  getApi: () => apiMock,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
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

async function renderPage() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const { default: Instances } = await import('./Instances')

  await act(async () => {
    root.render(
      <StyleProvider layer>
        <ConfigProvider>
          <AntdApp>
            <Instances />
          </AntdApp>
        </ConfigProvider>
      </StyleProvider>,
    )
  })

  await flushRender()
  await flushRender()
  await flushRender()

  return {
    container,
    unmount() {
      root.unmount()
      container.remove()
    },
  }
}

describe('Instances page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.managedInstances.list.mockResolvedValue([
      {
        id: 'instance-1',
        sessionToken: 'session-1a2b3c4d',
        projectId: 'project-1',
        providerId: 'provider-1',
        apiKeyId: 'key-1',
        cliType: 'claude',
        terminalType: 'terminal',
        projectPath: '/tmp/team-a/bid-web',
        shellPid: 111,
        processPid: 222,
        status: 'running',
        assignmentSource: 'project_launch',
        lastSeenAt: '2026-04-14T16:00:00Z',
        launchedAt: '2026-04-14T16:00:00Z',
        stoppedAt: null,
        stopReason: null,
        exitCode: null,
      },
      {
        id: 'instance-2',
        sessionToken: 'session-9f8e7d6c',
        projectId: 'project-1',
        providerId: 'provider-1',
        apiKeyId: 'key-2',
        cliType: 'claude',
        terminalType: 'terminal',
        projectPath: '/tmp/team-a/bid-web',
        shellPid: 333,
        processPid: 444,
        status: 'running',
        assignmentSource: 'project_launch',
        lastSeenAt: '2026-04-14T17:00:00Z',
        launchedAt: '2026-04-14T17:00:00Z',
        stoppedAt: null,
        stopReason: null,
        exitCode: null,
      },
    ])
    apiMock.provider.list.mockResolvedValue([{ id: 'provider-1', name: 'Provider 1' }])
    apiMock.apiKey.list.mockResolvedValue([
      { id: 'key-1', alias: 'Key 1', providerId: 'provider-1', types: ['claude'] },
      { id: 'key-2', alias: 'Key 2', providerId: 'provider-1', types: ['claude'] },
    ])
    apiMock.managedInstances.updateAssignment.mockResolvedValue(undefined)
  })

  it('shows only unique ids for instances', async () => {
    const view = await renderPage()

    expect(apiMock.managedInstances.list).toHaveBeenCalled()
    expect(apiMock.provider.list).toHaveBeenCalled()
    expect(view.container.textContent).toContain('instances.tableTitle')
    expect(view.container.textContent).toContain('1a2b3c4d')
    expect(view.container.textContent).toContain('9f8e7d6c')
    expect(view.container.textContent).toContain('bid-web')
    expect(view.container.textContent).not.toContain('/tmp/team-a/bid-web')
    expect(view.container.textContent).not.toContain('PID 222')
    expect(view.container.textContent).toContain('2026-04-15 00:00:00')

    view.unmount()
  })
})
