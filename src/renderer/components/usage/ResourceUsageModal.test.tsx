// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ResourceUsageModal, { type ResourceScope } from './ResourceUsageModal'
import type { ResourceUsageStatistics, ResourceUsageTrendItem } from '@shared/types'
import { refreshCurrentPage } from '../../api/pageRefresh'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const apiMock = vi.hoisted(() => ({ getResourceStatistics: vi.fn() }))
const measurements = vi.hoisted(() => ({ speed: 100 as number | null }))

vi.mock('../../api', () => ({
  getApi: () => ({
    requestLog: { getResourceStatistics: apiMock.getResourceStatistics },
  }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh' } }),
}))
vi.mock('./MultiMetricLineChart', () => ({
  default: ({
    data,
    series,
  }: {
    data: ResourceUsageTrendItem[]
    series: { key: string; value: (item: ResourceUsageTrendItem) => number | null }[]
  }) => (
    <div data-testid='trend'>
      {series.map((line) => `${line.key}:${line.value(data[0])}`).join(',')}
    </div>
  ),
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

const providerScope: ResourceScope = { type: 'provider', providerId: 'provider-1', name: 'One' }
const otherProviderScope: ResourceScope = {
  type: 'provider',
  providerId: 'provider-2',
  name: 'Two',
}
const keyScope: ResourceScope = {
  type: 'key',
  providerId: 'provider-1',
  apiKeyId: 'key-1',
  name: 'Example Key',
  providerName: 'One',
}

function statistics(
  summary: Partial<ResourceUsageStatistics['summary']> = {},
  trend: Partial<ResourceUsageTrendItem> = {},
): ResourceUsageStatistics {
  return {
    summary: {
      totalTokens: 1200,
      totalRequests: 2,
      successfulRequests: 2,
      failedRequests: 0,
      successRate: 1,
      cacheHitRate: 0.5,
      avgLatencyMs: 12000,
      avgFirstTokenMs: 2000,
      avgOutputTokensPerSecond: measurements.speed,
      ...summary,
    },
    dailyTrend: [
      {
        date: '2026-10-16',
        tokens: 1200,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 100,
        cacheCreationTokens: 0,
        requests: 2,
        failedRequests: 0,
        successRate: 1,
        cacheHitRate: 0.5,
        avgLatencyMs: 12000,
        avgFirstTokenMs: 2000,
        avgOutputTokensPerSecond: measurements.speed,
        ...trend,
      },
    ],
    trendGranularity: 'day',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function segmentedItem(label: string): HTMLElement {
  const item = Array.from(document.querySelectorAll('.ant-segmented-item')).find(
    (element) => element.textContent === label,
  )
  if (!item) throw new Error(`missing segmented item: ${label}`)
  return item as HTMLElement
}

function statisticValues(): string[] {
  return Array.from(document.querySelectorAll('.ant-statistic-content-value')).map(
    (element) => element.textContent ?? '',
  )
}

function retryButton(): HTMLElement {
  const button = Array.from(document.querySelectorAll('button')).find(
    (element) => element.textContent === 'common.retry',
  )
  if (!button) throw new Error('missing retry button')
  return button
}

const container = document.createElement('div')
let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  apiMock.getResourceStatistics.mockReset()
  apiMock.getResourceStatistics.mockImplementation(async () => statistics())
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = undefined
  container.remove()
  document.body.innerHTML = ''
  measurements.speed = 100
  vi.restoreAllMocks()
})

async function renderModal(props: { open?: boolean; scope?: ResourceScope | null } = {}) {
  document.body.append(container)
  root = createRoot(container)
  await renderInto(props)
}

async function renderInto(props: { open?: boolean; scope?: ResourceScope | null }) {
  const open = props.open ?? true
  const scope = props.scope === undefined ? providerScope : props.scope
  await act(async () => {
    root?.render(<ResourceUsageModal open={open} scope={scope} onClose={() => {}} />)
  })
  // Let the loader's promise chain settle inside act.
  await act(async () => {
    await Promise.resolve()
  })
}

async function refreshPage(): Promise<boolean> {
  let refreshed = false
  await act(async () => {
    refreshed = await refreshCurrentPage()
  })
  return refreshed
}

it('keeps provider usage focused on usage and quality after moving speed to statistics', async () => {
  await renderModal()
  expect(document.body.textContent).not.toContain('statistics.avgOutputSpeed')
  expect(document.body.textContent).not.toContain('tok/s')
  const tabs = Array.from(document.querySelectorAll('.ant-segmented-item')).filter((item) =>
    item.textContent?.startsWith('usageDetail.'),
  )
  expect(tabs.map((item) => item.textContent)).toEqual([
    'usageDetail.usageTrend',
    'usageDetail.qualityTrend',
  ])
  await act(async () => (tabs[1] as HTMLElement).click())
  const chart = document.querySelector('[data-testid="trend"]')
  expect(chart?.textContent).toContain('firstTokenLatency:2000')
  expect(chart?.textContent).toContain('successRate')
  expect(chart?.textContent).not.toContain('outputSpeed')
})

describe('resource usage modal loading', () => {
  it('queries the clicked provider scope on first open', async () => {
    await renderModal()
    expect(apiMock.getResourceStatistics).toHaveBeenCalledTimes(1)
    expect(apiMock.getResourceStatistics).toHaveBeenCalledWith('week', 'provider-1', undefined)
    expect(document.body.textContent).toContain('usageDetail.totalRequests')
    expect(document.body.textContent).toContain('usageDetail.refreshHint')
  })

  it('queries the clicked provider and key when the scope targets a key', async () => {
    await renderModal({ scope: keyScope })
    expect(apiMock.getResourceStatistics).toHaveBeenCalledTimes(1)
    expect(apiMock.getResourceStatistics).toHaveBeenCalledWith('week', 'provider-1', 'key-1')
  })

  it('does not query or register a refresh handler while closed', async () => {
    await renderModal({ open: false, scope: null })
    expect(apiMock.getResourceStatistics).not.toHaveBeenCalled()
    expect(await refreshPage()).toBe(false)
  })
})

describe('resource usage modal page refresh', () => {
  it('re-reads the same scope on page refresh and updates the rows', async () => {
    await renderModal()
    expect(statisticValues()).toContain('2')

    apiMock.getResourceStatistics.mockResolvedValueOnce(statistics({ totalRequests: 9 }))
    expect(await refreshPage()).toBe(true)

    expect(apiMock.getResourceStatistics).toHaveBeenCalledTimes(2)
    expect(apiMock.getResourceStatistics).toHaveBeenLastCalledWith('week', 'provider-1', undefined)
    expect(statisticValues()).toContain('9')
  })

  it('keeps the selected range and trend view across a refresh', async () => {
    await renderModal()

    await act(async () => segmentedItem('statistics.last30Days').click())
    expect(apiMock.getResourceStatistics).toHaveBeenLastCalledWith(
      'last30Days',
      'provider-1',
      undefined,
    )
    await act(async () => segmentedItem('usageDetail.qualityTrend').click())

    apiMock.getResourceStatistics.mockResolvedValueOnce(statistics({ totalRequests: 9 }))
    expect(await refreshPage()).toBe(true)

    // Range unchanged: refresh used the range that is on screen.
    expect(apiMock.getResourceStatistics).toHaveBeenLastCalledWith(
      'last30Days',
      'provider-1',
      undefined,
    )
    // View unchanged: the quality series is still rendered after the reload.
    const chart = document.querySelector('[data-testid="trend"]')
    expect(chart?.textContent).toContain('firstTokenLatency')
    expect(statisticValues()).toContain('9')
  })

  it('unregisters its refresh handler when the dialog closes', async () => {
    await renderModal()
    expect(await refreshPage()).toBe(true)

    await renderInto({ open: false, scope: null })
    const callsAfterClose = apiMock.getResourceStatistics.mock.calls.length
    expect(await refreshPage()).toBe(false)
    expect(apiMock.getResourceStatistics.mock.calls.length).toBe(callsAfterClose)
  })
})

describe('resource usage modal identity isolation', () => {
  it('ignores a delayed reply for a previous provider scope', async () => {
    const previous = deferred<ResourceUsageStatistics>()
    const current = deferred<ResourceUsageStatistics>()
    apiMock.getResourceStatistics.mockReset()
    apiMock.getResourceStatistics.mockReturnValueOnce(previous.promise)
    apiMock.getResourceStatistics.mockReturnValueOnce(current.promise)

    await renderModal() // provider-1 request stays in flight
    await renderInto({ scope: otherProviderScope })
    expect(apiMock.getResourceStatistics).toHaveBeenLastCalledWith('week', 'provider-2', undefined)

    await act(async () => {
      current.resolve(statistics({ totalRequests: 43, totalTokens: 43 }, { tokens: 43 }))
    })
    expect(statisticValues()).toContain('43')

    // The stale provider-1 reply arrives after the newer query resolved; it
    // must not overwrite provider-2 rows or clear the newer loading state.
    await act(async () => {
      previous.resolve(statistics({ totalRequests: 42, totalTokens: 42 }, { tokens: 42 }))
    })
    expect(statisticValues()).toContain('43')
    expect(statisticValues()).not.toContain('42')
    expect(document.body.textContent).not.toContain('usageDetail.loadFailed')
  })
})

describe('resource usage modal failure states', () => {
  it('shows a distinct error with retry instead of the empty state', async () => {
    apiMock.getResourceStatistics.mockRejectedValueOnce(new Error('ipc unavailable'))
    await renderModal()

    expect(document.body.textContent).toContain('usageDetail.loadFailed')
    expect(document.body.textContent).toContain('usageDetail.loadFailedHint')
    expect(document.body.textContent).not.toContain('usageDetail.noData')
    expect(retryButton()).toBeTruthy()

    apiMock.getResourceStatistics.mockResolvedValueOnce(statistics())
    await act(async () => retryButton().click())

    expect(document.body.textContent).toContain('usageDetail.totalRequests')
    expect(document.body.textContent).not.toContain('usageDetail.loadFailed')
  })

  it('renders the empty state only for a successful zero-request response', async () => {
    apiMock.getResourceStatistics.mockResolvedValueOnce(
      statistics({ totalRequests: 0, totalTokens: 0 }),
    )
    await renderModal()

    expect(document.body.textContent).toContain('usageDetail.noData')
    expect(document.body.textContent).toContain('usageDetail.noDataHint')
    expect(document.body.textContent).not.toContain('usageDetail.loadFailed')
    expect(document.body.textContent).not.toContain('usageDetail.totalRequests')
  })

  it('keeps the last rows visible and marks them stale when a refresh fails', async () => {
    await renderModal()
    expect(statisticValues()).toContain('2')

    apiMock.getResourceStatistics.mockRejectedValueOnce(new Error('refresh failed'))
    expect(await refreshPage()).toBe(true)

    expect(document.body.textContent).toContain('usageDetail.refreshFailed')
    expect(document.body.textContent).toContain('usageDetail.staleData')
    // Old rows stay visible rather than collapsing into the empty state.
    expect(statisticValues()).toContain('2')
    expect(document.body.textContent).not.toContain('usageDetail.noData')
    expect(retryButton()).toBeTruthy()

    apiMock.getResourceStatistics.mockResolvedValueOnce(statistics({ totalRequests: 7 }))
    await act(async () => retryButton().click())

    expect(document.body.textContent).not.toContain('usageDetail.refreshFailed')
    expect(statisticValues()).toContain('7')
  })
})
