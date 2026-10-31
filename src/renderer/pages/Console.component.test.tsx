// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App as AntdApp, ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import { createRoot } from 'react-dom/client'
import type { ConsoleEvent, ConsoleLogEvent, ConsoleRequestEvent } from '@shared/types'
import Console from './Console'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import ActivityPage from './ActivityPage'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/**
 * The console store is another work package's file; here it is replaced by a
 * controllable fake so the terminal projection, tabs and clear flow can be
 * exercised without IPC. Metadata and prune hooks are controllable too.
 */
const storeState = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  let events: ConsoleEvent[] = []
  const meta = {
    truncated: false,
    retention: null as {
      retentionStartDate: string | null
      capacityEvicted: boolean
      trimmed: boolean
      corrupted: number
      limited: boolean
    } | null,
    error: null as string | null,
    generation: null as string | null,
  }
  return {
    getEvents: () => events,
    setEvents: (next: ConsoleEvent[]) => {
      events = next
      listeners.forEach((listener) => listener())
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    meta,
    getConsoleHistoryMeta: () => ({ ...meta }),
    pruneExpiredConsoleEvents: vi.fn(() => 0),
    hydrateConsoleHistory: vi.fn(async () => {}),
    clearConsoleHistory: vi.fn(async () => ({ ok: true, app: true, daemon: true })),
    CONSOLE_BUFFER_LIMIT: 500,
  }
})

const apiMock = vi.hoisted(() => ({
  proxy: {
    getDetailMode: vi.fn(async () => false),
    setDetailMode: vi.fn(async () => {}),
  },
}))

vi.mock('../api', () => ({ getApi: () => apiMock }))
vi.mock('../api/consoleStore', () => ({
  CONSOLE_BUFFER_LIMIT: storeState.CONSOLE_BUFFER_LIMIT,
  getConsoleEvents: storeState.getEvents,
  subscribeConsoleStore: storeState.subscribe,
  hydrateConsoleHistory: storeState.hydrateConsoleHistory,
  clearConsoleHistory: storeState.clearConsoleHistory,
  getConsoleHistoryMeta: storeState.getConsoleHistoryMeta,
  pruneExpiredConsoleEvents: storeState.pruneExpiredConsoleEvents,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
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

let clipboardWrite: ReturnType<typeof vi.fn>
let consoleErrorSpy: ReturnType<typeof vi.spyOn>
let activeView: { container: HTMLElement; unmount: () => Promise<void> } | null = null

beforeEach(() => {
  storeState.setEvents([])
  storeState.meta.truncated = false
  storeState.meta.retention = null
  storeState.meta.error = null
  storeState.meta.generation = null
  apiMock.proxy.getDetailMode.mockResolvedValue(false)
  apiMock.proxy.setDetailMode.mockResolvedValue(undefined)
  storeState.clearConsoleHistory.mockResolvedValue({ ok: true, app: true, daemon: true })
  storeState.pruneExpiredConsoleEvents.mockClear()
  storeState.hydrateConsoleHistory.mockClear()
  clipboardWrite = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite },
  })
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  if (activeView) {
    await activeView.unmount()
    activeView = null
  }
  document.body.innerHTML = ''
  consoleErrorSpy.mockRestore()
  vi.clearAllMocks()
})

function request(overrides: Partial<ConsoleRequestEvent> = {}): ConsoleRequestEvent {
  return {
    category: 'request',
    requestId: 'req-1',
    timestamp: '2026-09-11 10:00:00',
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    latencyMs: 120,
    upstream: 'https://upstream.example.com/v1/messages',
    provider: 'Example',
    keyAlias: 'daily',
    kind: 'ok',
    model: 'model',
    ...overrides,
  }
}

function log(overrides: Partial<ConsoleLogEvent> = {}): ConsoleLogEvent {
  return {
    category: 'log',
    id: 'log-1',
    timestamp: '2026-09-11 10:00:00',
    level: 'info',
    source: 'daemon',
    target: 'cc_use_daemon::runtime',
    message: 'ready',
    ...overrides,
  }
}

async function flush(): Promise<void> {
  for (let round = 0; round < 2; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function renderConsole(routed = false) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <StyleProvider layer>
        <ConfigProvider>
          <AntdApp>
            {routed ? (
              <MemoryRouter initialEntries={['/console']}>
                <Routes>
                  <Route element={<ActivityPage />}>
                    <Route path='/console' element={<Console />} />
                    <Route
                      path='/stats'
                      element={
                        <div>
                          statistics-content
                          <Outlet />
                        </div>
                      }
                    />
                  </Route>
                </Routes>
              </MemoryRouter>
            ) : (
              <Console />
            )}
          </AntdApp>
        </ConfigProvider>
      </StyleProvider>,
    )
  })
  await flush()
  const view = {
    container,
    async unmount() {
      await act(async () => root.unmount())
      container.remove()
    },
  }
  activeView = view
  return view
}

function requestRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-testid="console-request-row"]'))
}

function logRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-testid="console-log-row"]'))
}

function tabs(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'))
}

function buttonWithText(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes(text),
  )
}

async function clickElement(element: HTMLElement | null | undefined): Promise<void> {
  expect(element).toBeTruthy()
  await act(async () => element!.click())
  await flush()
}

async function clickTab(container: HTMLElement, label: string): Promise<void> {
  const tab = tabs(container).find((candidate) => candidate.textContent?.includes(label))
  await clickElement(tab)
}

async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await flush()
}

function searchInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    'input[placeholder^="console.searchPlaceholder"], input[placeholder^="console.logSearchPlaceholder"]',
  )
  expect(input).not.toBeNull()
  return input!
}

describe('Console terminal stream', () => {
  it('renders request lines, not a data table, with the three console tabs', async () => {
    storeState.setEvents([
      request({ requestId: 'req-ok', model: 'ok-model' }),
      request({ requestId: 'req-fail', status: 500, model: 'fail-model' }),
    ])
    const view = await renderConsole()

    expect(requestRows(view.container)).toHaveLength(2)
    expect(view.container.querySelector('table')).toBeNull()
    expect(tabs(view.container).map((tab) => tab.textContent)).toEqual([
      'console.viewRequests',
      'console.viewProblems 1',
      'console.viewLogs',
    ])
    expect(view.container.textContent).toContain('console.bufferInfo')
  })

  it('keeps the problem tab to failing requests and searches the current view', async () => {
    storeState.setEvents([
      request({ requestId: 'req-ok', model: 'ok-model' }),
      request({ requestId: 'req-fail', status: 500, model: 'fail-model' }),
      request({ requestId: 'req-other', status: 429, model: 'other-model' }),
    ])
    const view = await renderConsole()

    await clickTab(view.container, 'console.viewProblems')
    expect(requestRows(view.container)).toHaveLength(2)
    expect(view.container.textContent).not.toContain('ok-model')

    await typeInto(searchInput(view.container), 'other')
    expect(requestRows(view.container)).toHaveLength(1)
    expect(view.container.textContent).toContain('other-model')

    await typeInto(searchInput(view.container), '')
    expect(requestRows(view.container)).toHaveLength(2)
  })

  it('renders the persisted log as plain terminal lines and filters them', async () => {
    storeState.setEvents([
      log({ id: 'log-info', level: 'info', message: 'listening on 127.0.0.1' }),
      log({ id: 'log-error', level: 'error', source: 'app', message: 'write failed' }),
    ])
    const view = await renderConsole()
    await clickTab(view.container, 'console.viewLogs')

    expect(logRows(view.container)).toHaveLength(2)
    expect(requestRows(view.container)).toHaveLength(0)
    expect(view.container.textContent).toMatch(/\[\d{2}:\d{2}:\d{2}\]/)
    expect(view.container.textContent).toContain('daemon/cc_use_daemon::runtime')
    expect(view.container.querySelector('table')).toBeNull()

    await typeInto(searchInput(view.container), 'write failed')
    expect(logRows(view.container)).toHaveLength(1)
    expect(view.container.textContent).toContain('app')
  })
})

describe('Console detail and copy', () => {
  it('opens request detail on demand and copies the request id', async () => {
    storeState.setEvents([request({ requestId: 'request-copy' })])
    const view = await renderConsole()
    await clickElement(requestRows(view.container)[0])

    expect(view.container.textContent).toContain('console.upstream')
    const copy = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="console.copyRequestId"]',
    )
    await clickElement(copy)
    expect(clipboardWrite).toHaveBeenCalledWith('request-copy')

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    await flush()
    expect(view.container.textContent).not.toContain('console.upstream')
  })

  it('does not attach a detail panel to log lines', async () => {
    storeState.setEvents([log({ message: 'plain line' })])
    const view = await renderConsole()
    await clickTab(view.container, 'console.viewLogs')
    await clickElement(logRows(view.container)[0])
    expect(view.container.textContent).not.toContain('console.copyRequestId')
  })
})

describe('Console follow and history', () => {
  it('pauses on the terminal scroller and resumes with incoming rows', async () => {
    storeState.setEvents([request({ requestId: 'req-1' })])
    const view = await renderConsole()
    const scroller = view.container.querySelector<HTMLElement>('[data-testid="console-scroller"]')!
    expect(scroller).not.toBeNull()

    await clickElement(buttonWithText(view.container, 'console.pause'))
    await act(async () =>
      storeState.setEvents([
        request({ requestId: 'req-1' }),
        request({ requestId: 'req-2', model: 'second' }),
      ]),
    )
    expect(buttonWithText(view.container, 'console.newEvents')).toBeDefined()
    await clickElement(buttonWithText(view.container, 'console.newEvents'))
    expect(buttonWithText(view.container, 'console.pause')).toBeDefined()
    expect(buttonWithText(view.container, 'console.newEvents')).toBeUndefined()
  })

  it('clears the paused/new-event state when the console is cleared', async () => {
    storeState.setEvents([request({ requestId: 'req-1' })])
    const view = await renderConsole()
    await clickElement(buttonWithText(view.container, 'console.pause'))
    await act(async () =>
      storeState.setEvents([
        request({ requestId: 'req-1' }),
        request({ requestId: 'req-2', model: 'second' }),
      ]),
    )
    expect(buttonWithText(view.container, 'console.newEvents')).toBeDefined()

    await clickElement(buttonWithText(view.container, 'console.clear'))
    await clickElement(buttonWithText(document.body, 'common.confirm'))

    expect(buttonWithText(view.container, 'console.newEvents')).toBeUndefined()
    expect(buttonWithText(view.container, 'console.pause')).toBeDefined()
  })

  it('shows the history read error with a retry action', async () => {
    storeState.meta.error = 'history-broken'
    const view = await renderConsole()

    expect(view.container.textContent).toContain('console.historyLoadFailed')
    expect(view.container.textContent).toContain('history-broken')
    const retry = buttonWithText(view.container, 'common.retry')
    await clickElement(retry)
    expect(storeState.hydrateConsoleHistory).toHaveBeenCalledTimes(2)
  })

  it('prunes expired rows on mount and when focus returns', async () => {
    await renderConsole()
    expect(storeState.pruneExpiredConsoleEvents).toHaveBeenCalled()
    const calls = storeState.pruneExpiredConsoleEvents.mock.calls.length
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(storeState.pruneExpiredConsoleEvents.mock.calls.length).toBeGreaterThan(calls)
  })

  it('reverts the detail-mode switch when the daemon rejects the change', async () => {
    apiMock.proxy.setDetailMode.mockRejectedValueOnce(new Error('daemon offline'))
    const view = await renderConsole()
    const toggle = view.container.querySelector<HTMLInputElement>(
      'button[role="switch"][aria-label="console.detailMode"]',
    )
    expect(toggle).not.toBeNull()
    await clickElement(toggle)
    expect(apiMock.proxy.setDetailMode).toHaveBeenCalledWith(true)
    expect(toggle!.getAttribute('aria-checked')).toBe('false')
  })
})

describe('Console clear result', () => {
  it('shows a per-owner partial failure instead of pretending full success', async () => {
    storeState.clearConsoleHistory.mockResolvedValueOnce({ ok: false, app: true, daemon: false })
    const view = await renderConsole()

    await clickElement(buttonWithText(view.container, 'console.clear'))
    await clickElement(buttonWithText(document.body, 'common.confirm'))

    const result = document.querySelector<HTMLElement>('[data-testid="console-clear-result"]')
    expect(result?.textContent).toContain('console.clearPartial')
  })

  it('reports a full failure when both owners fail', async () => {
    storeState.clearConsoleHistory.mockResolvedValueOnce({ ok: false, app: false, daemon: false })
    const view = await renderConsole()

    await clickElement(buttonWithText(view.container, 'console.clear'))
    await clickElement(buttonWithText(document.body, 'common.confirm'))

    const result = document.querySelector<HTMLElement>('[data-testid="console-clear-result"]')
    expect(result?.textContent).toContain('console.clearFailed')
  })
})

describe('Observation shell', () => {
  it('renders the console heading inside the shared observation shell', async () => {
    const view = await renderConsole(true)
    expect(view.container.querySelector('h2')?.textContent).toBe('console.title')
    expect(view.container.textContent).toContain('console.subtitle')
  })
})
