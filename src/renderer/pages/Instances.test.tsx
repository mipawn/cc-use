// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App as AntdApp, ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import { createRoot } from 'react-dom/client'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const apiMock = {
  managedInstances: {
    list: vi.fn(),
    updateAssignment: vi.fn(),
    cleanup: vi.fn(),
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

async function renderPage(clientKind: 'claude_code' | 'grok') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const { default: Instances } = await import('./Instances')

  await act(async () => {
    root.render(
      <StyleProvider layer>
        <ConfigProvider>
          <AntdApp>
            <Instances clientKind={clientKind} />
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
      act(() => root.unmount())
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
        cliType: 'grok',
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
      {
        id: 'instance-3',
        sessionToken: 'session-stopped123',
        projectId: 'project-1',
        providerId: 'provider-1',
        apiKeyId: 'key-2',
        cliType: 'claude_code',
        terminalType: 'terminal',
        projectPath: '/tmp/team-a/finished-project',
        shellPid: 555,
        processPid: 666,
        status: 'stopped',
        assignmentSource: 'project_launch',
        lastSeenAt: '2026-04-14T18:00:00Z',
        launchedAt: '2026-04-14T17:30:00Z',
        stoppedAt: '2026-04-14T18:05:00Z',
        stopReason: 'process_exit',
        exitCode: 0,
      },
    ])
    apiMock.provider.list.mockResolvedValue([
      { id: 'provider-1', name: 'Provider 1', isActive: true },
    ])
    apiMock.apiKey.list.mockResolvedValue([
      {
        id: 'key-1',
        alias: 'Key 1',
        providerId: 'provider-1',
        types: ['grok'],
        isActive: true,
        isExhausted: false,
      },
      {
        id: 'key-2',
        alias: 'Key 2',
        providerId: 'provider-1',
        types: ['claude'],
        isActive: true,
        isExhausted: false,
      },
    ])
    apiMock.managedInstances.updateAssignment.mockResolvedValue(undefined)
    apiMock.managedInstances.cleanup.mockResolvedValue(0)
  })

  it('only shows Claude Code instances in the Claude Code launchpad', async () => {
    const view = await renderPage('claude_code')

    expect(apiMock.managedInstances.list).toHaveBeenCalledWith('claude_code')
    expect(apiMock.provider.list).toHaveBeenCalled()
    expect(view.container.textContent).toContain('instances.tableTitle')
    expect(view.container.textContent).toContain('9f8e7d6c')
    expect(view.container.textContent).not.toContain('1a2b3c4d')
    expect(view.container.textContent).toContain('bid-web')
    expect(view.container.textContent).not.toContain('/tmp/team-a/bid-web')
    expect(view.container.textContent).not.toContain('PID 222')
    expect(view.container.textContent).toContain('2026-04-15 01:00:00')
    expect(view.container.textContent).not.toContain('opped123')

    view.unmount()
  })

  it('shows stopped and failed records only in recent history', async () => {
    const view = await renderPage('claude_code')
    const historyOption = Array.from(
      view.container.querySelectorAll<HTMLElement>('.ant-segmented-item'),
    ).find((item) => item.textContent?.includes('instances.historyView'))

    expect(historyOption).toBeDefined()
    await act(async () => {
      historyOption?.click()
    })
    await flushRender()

    expect(view.container.textContent).toContain('opped123')
    expect(view.container.textContent).toContain('instances.reasonProcessExit')
    expect(view.container.textContent).toContain('instances.exitCode')
    expect(view.container.querySelector('.ant-select')).toBeNull()
    view.unmount()
  })

  it('only shows Grok instances in the Grok Build launchpad', async () => {
    const view = await renderPage('grok')

    expect(view.container.textContent).toContain('1a2b3c4d')
    expect(view.container.textContent).not.toContain('9f8e7d6c')
    expect(view.container.textContent).toContain('bid-web')
    expect(view.container.textContent).toContain('2026-04-15 00:00:00')

    view.unmount()
  })

  it('only treats keys from the same CLI type as compatible', async () => {
    const { isApiKeyCompatibleWithCliType } = await import('./Instances')

    expect(isApiKeyCompatibleWithCliType({ types: ['claude_code'] }, 'claude')).toBe(true)
    expect(isApiKeyCompatibleWithCliType({ types: ['grok'] }, 'grok')).toBe(true)
    expect(isApiKeyCompatibleWithCliType({ types: ['grok'] }, 'claude_code')).toBe(false)
    expect(isApiKeyCompatibleWithCliType({ types: ['claude_code'] }, 'grok')).toBe(false)
  })

  it('cleans up only the current launchpad client type', async () => {
    const view = await renderPage('grok')
    const cleanupButton = Array.from(view.container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('instances.cleanup'),
    )

    expect(cleanupButton).toBeDefined()
    await act(async () => {
      cleanupButton?.click()
    })
    await flushRender()

    expect(apiMock.managedInstances.cleanup).toHaveBeenCalledWith('grok')
    view.unmount()
  })
})
