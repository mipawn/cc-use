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
const api = vi.hoisted(() => ({
  getStatistics: vi.fn(),
  getRecentPaginated: vi.fn(),
  syncAntigravity: vi.fn(),
  onAntigravityUpdated: vi.fn(),
}))
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
  api.getRecentPaginated.mockReset().mockImplementation(async (_range, page, pageSize) => ({
    items: [item],
    total: 100,
    page,
    pageSize,
  }))
  api.syncAntigravity.mockReset().mockResolvedValue({
    scannedFiles: 0,
    updatedConversations: 0,
    removedFiles: 0,
  })
  api.onAntigravityUpdated.mockReset().mockReturnValue(() => {})
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

async function chooseSource(label: string) {
  const trigger = container.querySelector<HTMLInputElement>(
    'input[aria-label="observation.source"]',
  )
  expect(trigger).not.toBeNull()
  await act(async () => {
    trigger!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const option = Array.from(document.body.querySelectorAll('.ant-select-item-option')).find(
    (item) => item.textContent === label,
  )
  expect(option).toBeDefined()
  await act(async () => {
    ;(option as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

it('queries aggregates and pages with the identical scope and keeps it on page refresh', async () => {
  await render()
  expect(api.syncAntigravity).toHaveBeenCalledTimes(1)
  expect(api.getStatistics).toHaveBeenLastCalledWith(context.timeRange, context.filter)
  expect(api.getRecentPaginated).toHaveBeenLastCalledWith(context.timeRange, 2, 20, context.filter)
  await act(async () => {
    await refreshCurrentPage()
  })
  // Manual refresh asks for a catch-up pass before re-reading the same scope.
  expect(api.syncAntigravity).toHaveBeenCalledTimes(2)
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

it('scopes the ledger by source from the filter bar and resets only pagination', async () => {
  await render()
  await chooseSource('observation.sources.antigravity_cli')
  const scoped = { ...context.filter, source: 'antigravity_cli' as const }
  expect(api.getStatistics).toHaveBeenLastCalledWith(context.timeRange, scoped)
  expect(api.getRecentPaginated).toHaveBeenLastCalledWith(context.timeRange, 1, 20, scoped)
  expect(parseObservationContext(location.search).context).toEqual({
    ...context,
    filter: scoped,
    page: 1,
  })
})

it('hides incomparable averages and explains the mixed source scope', async () => {
  api.getStatistics.mockResolvedValueOnce({
    ...statistics,
    summary: {
      ...statistics.summary,
      avgLatencyMs: null,
      avgFirstTokenMs: null,
      avgOutputTokensPerSecond: null,
      performanceMixedSources: true,
    },
  })
  await render()
  expect(container.textContent).toContain('observation.performanceMixedHint')
  // The three performance readings use an em dash instead of a fabricated number.
  expect(container.textContent?.match(/—/g)?.length).toBeGreaterThanOrEqual(3)
})

it('re-reads the same scope after an Antigravity update event', async () => {
  await render()
  const handler = api.onAntigravityUpdated.mock.calls.at(-1)?.[0] as (() => void) | undefined
  expect(handler).toBeTruthy()
  await act(async () => {
    handler?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(api.getStatistics).toHaveBeenCalledTimes(2)
  expect(api.getStatistics).toHaveBeenLastCalledWith(context.timeRange, context.filter)
})

it('subscribes to Antigravity updates before asking for the catch-up scan', async () => {
  await render()
  expect(api.onAntigravityUpdated).toHaveBeenCalledTimes(1)
  expect(api.syncAntigravity).toHaveBeenCalledTimes(1)
  // A scan that commits while the request is in flight must not miss its own emit.
  expect(api.onAntigravityUpdated.mock.invocationCallOrder[0]).toBeLessThan(
    api.syncAntigravity.mock.invocationCallOrder[0],
  )
})

it('labels the ledger duration per source and splits thinking/response tokens', async () => {
  api.getRecentPaginated.mockResolvedValueOnce({
    items: [
      {
        ...item,
        id: 'antigravity-row',
        source: 'antigravity_cli',
        latencyMs: null,
        generationMs: 1200,
        outputTokens: 120,
        thinkingTokens: 30,
        responseTokens: 90,
      },
      { ...item, id: 'proxy-row', source: 'proxy' },
    ],
    total: 2,
    page: 2,
    pageSize: 20,
  })
  await render()
  const cells = (id: string) =>
    Array.from(container.querySelector(`[data-row-key="${id}"]`)!.querySelectorAll('td'))

  // Antigravity rows report generation duration and never claim proxy latency.
  expect(cells('antigravity-row')[6].textContent).toContain('observation.generationDuration')
  expect(cells('antigravity-row')[6].textContent).toContain('1.20 s')
  expect(cells('antigravity-row')[6].textContent).not.toContain('statistics.latency')
  // The Thinking + Response split rides in the token cell next to the four-bucket total.
  expect(cells('antigravity-row')[3].textContent).toContain('130')
  expect(cells('antigravity-row')[3].textContent).toContain('observation.thinkingTokens 30')
  expect(cells('antigravity-row')[3].textContent).toContain('observation.responseTokens 90')

  // Proxy rows keep end-to-end latency and carry no token split.
  expect(cells('proxy-row')[6].textContent).toContain('statistics.latency')
  expect(cells('proxy-row')[6].textContent).toContain('100 ms')
  expect(cells('proxy-row')[3].textContent).not.toContain('observation.thinkingTokens')

  // A mixed ledger names both measurements in the header instead of proxy latency alone.
  const headers = Array.from(container.querySelectorAll('th')).map((cell) => cell.textContent ?? '')
  expect(headers).toContain('observation.generationDuration / statistics.latency')
})

it('labels the duration column as generation duration for an Antigravity scope', async () => {
  api.getRecentPaginated.mockResolvedValueOnce({
    items: [
      { ...item, id: 'cli-row', source: 'antigravity_cli', latencyMs: null, generationMs: 800 },
    ],
    total: 1,
    page: 1,
    pageSize: 20,
  })
  await render(
    buildStatisticsUrl({ ...context, filter: { ...context.filter, source: 'antigravity_cli' } }),
  )
  const headers = Array.from(container.querySelectorAll('th')).map((cell) => cell.textContent ?? '')
  expect(headers).toContain('observation.generationDuration')
  expect(headers).not.toContain('statistics.latency')
})

it.each([
  '?providerId=&requestId=request-4',
  '?sessionToken=private-route-token',
  '?timeRange=custom:2026-02-30:2026-03-01',
])('does not query or echo raw input for invalid scope %s', async (query) => {
  await render(`/stats${query}`)
  expect(api.getStatistics).not.toHaveBeenCalled()
  expect(api.getRecentPaginated).not.toHaveBeenCalled()
  // An unparsable scope does not even ask for a maintenance scan.
  expect(api.syncAntigravity).not.toHaveBeenCalled()
  expect(api.onAntigravityUpdated).not.toHaveBeenCalled()
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
