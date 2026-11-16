// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import Statistics from './Statistics'
import { buildStatisticsUrl, parseObservationContext } from '../utils/observationContext'
import type { ObservationContext } from '../utils/observationContext'
import { refreshCurrentPage } from '../api/pageRefresh'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const api = vi.hoisted(() => ({ getStatistics: vi.fn(), getRecentPaginated: vi.fn() }))
vi.mock('../api', () => ({ getApi: () => ({ requestLog: api }) }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
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

const context: ObservationContext = {
  timeRange: 'custom:2026-09-10:2026-09-11',
  filter: {
    providerId: 'provider-1',
    apiKeyId: 'key-2',
    instanceId: 'instance-3',
    population: 'with_usage',
  },
  page: 2,
  pageSize: 20,
}
const statistics = {
  summary: {
    totalRequests: 4,
    totalTokens: 40,
    failedRequests: 1,
    cacheHitRate: 0,
    avgLatencyMs: 100,
    avgFirstTokenMs: null,
    avgOutputTokensPerSecond: null,
  },
  dailyModelUsage: [],
  keyUsage: [],
  projectUsage: [],
  trendGranularity: 'day',
}
const item = {
  id: 'fixture-row',
  requestId: 'request-4',
  model: 'fixture-model',
  keyAlias: 'key',
  providerName: 'provider',
  projectName: 'historical-directory',
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  latencyMs: 100,
  firstTokenMs: null,
  outputTokensPerSecond: null,
  statusCode: 200,
  outcome: 'success',
  errorMessage: null,
  createdAt: new Date(2026, 8, 11, 12).toISOString(),
}
let location: ReturnType<typeof useLocation>
let navigate: ReturnType<typeof useNavigate>
function RouterProbe() {
  location = useLocation()
  navigate = useNavigate()
  return null
}
let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
beforeEach(() => {
  api.getStatistics.mockReset().mockResolvedValue(statistics)
  api.getRecentPaginated
    .mockReset()
    .mockImplementation(async (_range, page, pageSize) => ({
      items: [item],
      total: 100,
      page,
      pageSize,
    }))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
async function render(url = buildStatisticsUrl(context)) {
  await act(async () =>
    root.render(
      <StyleProvider layer>
        <ConfigProvider>
          <MemoryRouter initialEntries={[url]}>
            <RouterProbe />
            <Statistics />
          </MemoryRouter>
        </ConfigProvider>
      </StyleProvider>,
    ),
  )
}
function button(text: string, parent: ParentNode = container) {
  const node = Array.from(parent.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text),
  )
  expect(node).toBeTruthy()
  return node!
}

it('queries aggregates and pages with the identical scope and keeps it on page refresh', async () => {
  await render()
  expect(api.getStatistics).toHaveBeenLastCalledWith(context.timeRange, context.filter)
  expect(api.getRecentPaginated).toHaveBeenLastCalledWith(context.timeRange, 2, 20, context.filter)
  await act(async () => {
    await refreshCurrentPage()
  })
  expect(api.getStatistics).toHaveBeenCalledTimes(2)
  expect(api.getRecentPaginated).toHaveBeenLastCalledWith(context.timeRange, 2, 20, context.filter)
  expect(parseObservationContext(location.search).context).toEqual(context)
  expect(container.textContent).not.toContain('statistics.projectUsage')
})

it('choosing failures preserves source/date and includes zero-token failures from page one', async () => {
  await render()
  await act(async () => button('statistics.failedRequests').click())
  const failed = { ...context.filter, outcome: 'failed', population: 'all' }
  expect(api.getStatistics).toHaveBeenLastCalledWith(context.timeRange, failed)
  expect(api.getRecentPaginated).toHaveBeenLastCalledWith(context.timeRange, 1, 20, failed)
  expect(parseObservationContext(location.search).context.filter).toEqual(failed)
})

it.each([
  '?providerId=&requestId=request-4',
  '?sessionToken=private-route-token',
  '?timeRange=custom:2026-02-30:2026-03-01',
])('does not query or echo raw input for invalid scope %s', async (query) => {
  await render(`/stats${query}`)
  expect(api.getStatistics).not.toHaveBeenCalled()
  expect(api.getRecentPaginated).not.toHaveBeenCalled()
  expect(container.textContent).toContain('observation.invalidQuery')
  expect(container.textContent).not.toContain('private-route-token')
})

it('reports deleted associations without falling back and retries the same scope', async () => {
  api.getStatistics.mockRejectedValueOnce(
    'instance scope association unavailable: private-route-token',
  )
  await render()
  expect(container.textContent).toContain('observation.scopeUnavailable')
  expect(container.textContent).not.toContain('private-route-token')
  expect(container.querySelector('[data-row-key="fixture-row"]')).toBeNull()
  await act(async () => button('common.retry').click())
  expect(api.getStatistics).toHaveBeenLastCalledWith(context.timeRange, context.filter)
  expect(container.querySelector('[data-row-key="fixture-row"]')).not.toBeNull()
})

it('opens precise console from the drawer with its original ledger context', async () => {
  await render()
  await act(async () =>
    button('statistics.detail', container.querySelector('[data-row-key="fixture-row"]')!).click(),
  )
  expect(document.querySelector('.ant-drawer-body')?.textContent).toContain('historical-directory')
  await act(async () => button('observation.openConsole', document).click())
  expect(location.pathname).toBe('/console')
  expect(parseObservationContext(location.search)).toEqual({
    context,
    invalid: false,
    requestId: 'request-4',
    requestDate: '2026-09-11',
  })
  expect(location.search).not.toContain('historical-directory')
})

it('disables console handoff for a legacy record without requestId', async () => {
  api.getRecentPaginated.mockResolvedValueOnce({
    items: [{ ...item, requestId: null }],
    total: 1,
    page: 1,
    pageSize: 20,
  })
  await render()
  await act(async () =>
    button('statistics.detail', container.querySelector('[data-row-key="fixture-row"]')!).click(),
  )
  expect(button('observation.openConsole', document).disabled).toBe(true)
})

it('ignores an older source response after navigating to another source', async () => {
  let resolveOld!: (value: unknown) => void
  api.getStatistics.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve
    }),
  )
  await render()
  const next = { ...context, filter: { providerId: 'new-provider' } }
  await act(async () => {
    await navigate(buildStatisticsUrl(next))
  })
  await act(async () =>
    resolveOld({ ...statistics, summary: { ...statistics.summary, totalTokens: 999999 } }),
  )
  expect(container.textContent).not.toContain('999999')
  expect(api.getStatistics).toHaveBeenLastCalledWith(context.timeRange, next.filter)
  expect(parseObservationContext(location.search).context).toEqual(next)
})
