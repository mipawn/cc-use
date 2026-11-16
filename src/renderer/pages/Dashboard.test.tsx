// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import Dashboard from './Dashboard'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
const api = vi.hoisted(() => ({ requestLog: { getOverview: vi.fn(), getMonthlyTrend: vi.fn() } }))
vi.mock('../api', () => ({ getApi: () => api }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}))
vi.mock('simplebar-react', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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

function LocationProbe() {
  const location = useLocation()
  return (
    <output data-testid='location'>
      {location.pathname}
      {location.search}
    </output>
  )
}
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
          <MemoryRouter>
            <Dashboard />
            <LocationProbe />
          </MemoryRouter>
        </ConfigProvider>
      </StyleProvider>,
    ),
  )
  await flush()
}
function dateCell(date: string) {
  return container.querySelector<HTMLButtonElement>(`button[aria-label^="${date} "]`)!
}
function expectStatsDestination(
  destination: string,
  date: string,
  population: string,
  outcome: string | null = null,
) {
  const url = new URL(destination, 'https://example.test')
  expect(url.pathname).toBe('/stats')
  expect(url.searchParams.get('timeRange')).toBe(`custom:${date}:${date}`)
  expect(url.searchParams.get('population')).toBe(population)
  expect(url.searchParams.get('outcome')).toBe(outcome)
  expect(url.searchParams.get('page')).toBe('1')
  expect(url.searchParams.get('pageSize')).toBe('10')
}

beforeEach(() => {
  vi.resetAllMocks()
  // Intentionally near local midnight: UTC truncation yields the previous day in Asia/Shanghai.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 4, 16, 0, 15))
  api.requestLog.getOverview.mockResolvedValue({
    todayTokens: 42,
    todayRequests: 3,
    todayFailedRequests: 1,
  })
  api.requestLog.getMonthlyTrend.mockImplementation((_year: number, month: number) =>
    Promise.resolve(month === 5 ? [{ date: '2026-05-15', tokens: 42, requests: 3 }] : []),
  )
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = undefined
  container?.remove()
  vi.useRealTimers()
})

describe('Dashboard observation navigation', () => {
  it('uses local today and with_usage for token/request/statistics links, but all for failures', async () => {
    await render()
    for (const label of [
      'dashboard.todayTokens',
      'dashboard.todayRequests',
      'workspace.viewStatistics',
    ]) {
      const link = Array.from(container.querySelectorAll('a')).find((item) =>
        item.textContent?.includes(label),
      )!
      expectStatsDestination(link.href, '2026-05-16', 'with_usage')
    }
    const failures = Array.from(container.querySelectorAll('a')).find((item) =>
      item.textContent?.includes('dashboard.todayFailures'),
    )!
    expectStatsDestination(failures.href, '2026-05-16', 'all', 'failed')
  })

  it('opens a clicked local heatmap day with the same usage population', async () => {
    await render()
    expect(api.requestLog.getMonthlyTrend).toHaveBeenCalledTimes(12)
    expect(dateCell('2026-05-15').disabled).toBe(false)
    await act(async () => dateCell('2026-05-15').click())
    expectStatsDestination(
      container.querySelector('[data-testid="location"]')!.textContent!,
      '2026-05-15',
      'with_usage',
    )
  })

  it('disables future and padding cells while allowing today, including zero-usage days', async () => {
    await render()
    expect(dateCell('2026-05-16').disabled).toBe(false)
    expect(dateCell('2026-05-17').disabled).toBe(true)
    expect(dateCell('2025-12-29').disabled).toBe(true)
    expect(dateCell('2027-01-03').disabled).toBe(true)
    await act(async () => {
      dateCell('2026-05-17').click()
      dateCell('2025-12-29').click()
    })
    expect(container.querySelector('[data-testid="location"]')!.textContent).toBe('/')
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="workspace.nextYear"]')!
        .disabled,
    ).toBe(true)
    await act(async () => dateCell('2026-05-16').click())
    expectStatsDestination(
      container.querySelector('[data-testid="location"]')!.textContent!,
      '2026-05-16',
      'with_usage',
    )
  })

  it('does not let a heatmap failure look like an empty successful day', async () => {
    api.requestLog.getMonthlyTrend.mockRejectedValue(new Error('offline'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await render()
      expect(container.textContent).toContain('workspace.overviewUnavailable')
      expect(container.textContent).not.toContain('dashboard.heatmapNoData')
      expect(dateCell('2026-05-15').disabled).toBe(true)
      expect(dateCell('2026-05-16').disabled).toBe(true)
      await act(async () => dateCell('2026-05-15').click())
      expect(container.querySelector('[data-testid="location"]')!.textContent).toBe('/')
    } finally {
      error.mockRestore()
    }
  })
})
