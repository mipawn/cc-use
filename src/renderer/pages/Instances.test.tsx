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
    i18n: { language: 'zh-CN' },
  }),
}))

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: () => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
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

async function renderPage(clientKind?: 'claude_code' | 'grok') {
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
    async rerender(nextClientKind: 'claude_code' | 'grok') {
      await act(async () => {
        root.render(
          <StyleProvider layer>
            <ConfigProvider>
              <AntdApp>
                <Instances clientKind={nextClientKind} />
              </AntdApp>
            </ConfigProvider>
          </StyleProvider>,
        )
      })
      await flushRender()
    },
    unmount() {
      act(() => root.unmount())
      container.remove()
    },
  }
}

describe('Instances page', () => {
  beforeEach(() => {
    vi.resetAllMocks()
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

  it('filters Claude Code while reading the complete active population', async () => {
    const view = await renderPage('claude_code')

    expect(apiMock.managedInstances.list).toHaveBeenCalledWith('claude_code')
    expect(apiMock.provider.list).toHaveBeenCalled()
    expect(apiMock.managedInstances.list).toHaveBeenCalledWith()
    expect(view.container.textContent).toContain('stance-2')
    expect(view.container.textContent).not.toContain('9f8e7d6c')
    expect(view.container.textContent).not.toContain('1a2b3c4d')
    expect(view.container.textContent).toContain('bid-web')
    expect(view.container.textContent).not.toContain('/tmp/team-a/bid-web')
    expect(view.container.textContent).not.toContain('PID 222')
    expect(view.container.textContent).toContain(
      new Date('2026-04-14T17:00:00Z').toLocaleString('zh-CN'),
    )
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

    expect(view.container.textContent).toContain('stance-3')
    expect(view.container.textContent).not.toContain('opped123')
    expect(view.container.textContent).toContain('instances.reasonProcessExit')
    expect(view.container.textContent).toContain('instances.exitCode')
    expect(view.container.querySelector('.ant-select')).toBeNull()
    view.unmount()
  })

  it('filters Grok without exposing session credentials', async () => {
    const view = await renderPage('grok')

    expect(view.container.textContent).toContain('stance-1')
    expect(view.container.textContent).not.toContain('1a2b3c4d')
    expect(view.container.textContent).not.toContain('9f8e7d6c')
    expect(view.container.textContent).toContain('bid-web')
    expect(view.container.textContent).toContain(
      new Date('2026-04-14T16:00:00Z').toLocaleString('zh-CN'),
    )

    view.unmount()
  })

  it('only treats keys from the same CLI type as compatible', async () => {
    const { isApiKeyCompatibleWithCliType } = await import('./Instances')

    expect(isApiKeyCompatibleWithCliType({ types: ['claude_code'] }, 'claude')).toBe(true)
    expect(isApiKeyCompatibleWithCliType({ types: ['grok'] }, 'grok')).toBe(true)
    expect(isApiKeyCompatibleWithCliType({ types: ['grok'] }, 'claude_code')).toBe(false)
    expect(isApiKeyCompatibleWithCliType({ types: ['claude_code'] }, 'grok')).toBe(false)
  })

  it('keeps an old live instance even when absent from the 100 recent records', async () => {
    const fixture = (await apiMock.managedInstances.list())[0]
    const oldActive = {
      ...fixture,
      id: 'old-live-instance',
      projectPath: '/tmp/old-live-directory',
      launchedAt: '2020-01-01T00:00:00Z',
    }
    const recent = Array.from({ length: 100 }, (_, index) => ({
      ...fixture,
      id: `recent-${index}`,
      status: index % 2 ? 'failed' : 'stopped',
      projectPath: `/tmp/recent-${index}`,
    }))
    apiMock.managedInstances.list.mockImplementation((kind?: string) =>
      Promise.resolve(kind ? recent : [oldActive]),
    )
    const view = await renderPage('grok')
    try {
      expect(apiMock.managedInstances.list).toHaveBeenCalledWith()
      expect(apiMock.managedInstances.list).toHaveBeenCalledWith('grok')
      expect(view.container.textContent).toContain('old-live-directory')
      expect(view.container.textContent).not.toContain('recent-99')
      const history = Array.from(
        view.container.querySelectorAll<HTMLElement>('.ant-segmented-item'),
      ).find((item) => item.textContent?.includes('instances.historyView'))!
      await act(async () => history.click())
      expect(view.container.textContent).not.toContain('old-live-directory')
      expect(view.container.textContent).toContain('recent-0')
      expect(view.container.textContent).toContain('instances.statusFailed')
    } finally {
      view.unmount()
    }
  })

  it('does not let a late previous-client response replace the current client', async () => {
    const fixtures = await apiMock.managedInstances.list()
    let resolveOld!: (value: typeof fixtures) => void
    const oldRequest = new Promise<typeof fixtures>((resolve) => {
      resolveOld = resolve
    })
    apiMock.managedInstances.list.mockImplementation((kind?: string) =>
      kind === 'claude_code' ? oldRequest : Promise.resolve([fixtures[0]]),
    )
    const view = await renderPage('claude_code')
    try {
      await view.rerender('grok')
      expect(view.container.textContent).toContain('stance-1')
      await act(async () => resolveOld([fixtures[1]]))
      await flushRender()
      expect(view.container.textContent).toContain('stance-1')
      expect(view.container.textContent).not.toContain('stance-2')
    } finally {
      view.unmount()
    }
  })

  it('keeps a rejected switch open and rereads authoritative instance state', async () => {
    apiMock.managedInstances.updateAssignment.mockRejectedValue(new Error('instance stopped'))
    const view = await renderPage('grok')
    try {
      const switchButton = Array.from(view.container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('instances.switchRoute'),
      )!
      await act(async () => switchButton.click())
      const before = apiMock.managedInstances.list.mock.calls.length
      const applyButton = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.ant-modal button'),
      ).find((button) => button.textContent?.includes('instances.applyRoute'))!
      expect(applyButton.disabled).toBe(false)
      await act(async () => applyButton.click())
      await flushRender()
      expect(apiMock.managedInstances.updateAssignment).toHaveBeenCalledWith({
        id: 'instance-1',
        providerId: 'provider-1',
        apiKeyId: 'key-1',
        assignmentSource: 'manual_ui',
      })
      expect(apiMock.managedInstances.list.mock.calls.length).toBeGreaterThan(before)
      expect(document.querySelector('.ant-modal')?.textContent).toContain('resources.failed')
      expect(document.querySelector('.ant-modal')?.textContent).toContain('Key 1')
      expect(document.body.textContent).not.toContain('instances.assignmentUpdated')
    } finally {
      view.unmount()
    }
  })

  it.each(['resolve', 'reject'] as const)(
    'ignores an old cleanup %s after changing client without releasing a new cleanup',
    async (outcome) => {
      let finishOld!: () => void
      let finishNew!: () => void
      apiMock.managedInstances.cleanup
        .mockImplementationOnce(
          () => new Promise<number>((resolve, reject) => {
            finishOld = () => outcome === 'resolve' ? resolve(1) : reject(new Error('old failure'))
          }),
        )
        .mockImplementationOnce(() => new Promise<number>((resolve) => {
          finishNew = () => resolve(0)
        }))
      const view = await renderPage('claude_code')
      const cleanup = () => Array.from(view.container.querySelectorAll('button')).find(
        (button) => button.textContent?.includes('instances.cleanup'),
      )!
      try {
        await act(async () => cleanup().click())
        await view.rerender('grok')
        expect(cleanup().classList.contains('ant-btn-loading')).toBe(false)
        await act(async () => cleanup().click())
        const calls = apiMock.managedInstances.list.mock.calls.length
        await act(async () => finishOld())
        await flushRender()
        expect(apiMock.managedInstances.list).toHaveBeenCalledTimes(calls)
        expect(view.container.textContent).toContain('stance-1')
        expect(view.container.textContent).not.toContain('stance-2')
        expect(cleanup().classList.contains('ant-btn-loading')).toBe(true)
        expect(document.body.textContent).not.toContain('instances.cleanupSuccess')
        expect(document.body.textContent).not.toContain('instances.cleanupPartial')
        expect(document.body.textContent).not.toContain('instances.cleanupFailed')
        await act(async () => finishNew())
        expect(cleanup().classList.contains('ant-btn-loading')).toBe(false)
      } finally {
        view.unmount()
      }
    },
  )

  it.each(['resolve', 'reject'] as const)(
    'ignores a previous client assignment %s while a new assignment is pending',
    async (outcome) => {
      let finishOld!: () => void
      let finishNew!: () => void
      apiMock.managedInstances.updateAssignment
        .mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
          finishOld = () => outcome === 'resolve' ? resolve() : reject(new Error('old failure'))
        }))
        .mockImplementationOnce(() => new Promise<void>((resolve) => { finishNew = resolve }))
      const view = await renderPage('claude_code')
      const startSwitch = async () => {
        const switchButton = Array.from(view.container.querySelectorAll('button')).find(
          (button) => button.textContent?.includes('instances.switchRoute'),
        )!
        await act(async () => switchButton.click())
        const apply = Array.from(document.querySelectorAll<HTMLButtonElement>('.ant-modal button')).find(
          (button) => button.textContent?.includes('instances.applyRoute'),
        )!
        await act(async () => apply.click())
      }
      try {
        await startSwitch()
        await view.rerender('grok')
        await startSwitch()
        expect(apiMock.managedInstances.updateAssignment).toHaveBeenCalledTimes(2)
        const calls = apiMock.managedInstances.list.mock.calls.length
        await act(async () => finishOld())
        await flushRender()
        expect(apiMock.managedInstances.list).toHaveBeenCalledTimes(calls)
        expect(view.container.textContent).toContain('stance-1')
        expect(view.container.textContent).not.toContain('stance-2')
        expect(document.body.textContent).not.toContain('instances.assignmentUpdated')
        expect(document.querySelector('.ant-modal')?.textContent).not.toContain('resources.failed')
        const switchButton = Array.from(view.container.querySelectorAll('button')).find(
          (button) => button.textContent?.includes('instances.switchRoute'),
        )!
        expect(switchButton.classList.contains('ant-btn-loading')).toBe(true)
        await act(async () => finishNew())
        await flushRender()
        expect(document.body.textContent).toContain('instances.assignmentUpdated')
      } finally {
        view.unmount()
      }
    },
  )

  it('cleans up only the selected client type', async () => {
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
