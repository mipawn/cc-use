// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import ResourceUsageModal from './ResourceUsageModal'
import type { ResourceUsageTrendItem } from '@shared/types'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const measurements = vi.hoisted(() => ({ speed: 100 as number | null }))
vi.mock('../../api', () => ({
  getApi: () => ({
    requestLog: {
      getResourceStatistics: async () => ({
        summary: {
          totalTokens: 1200,
          totalRequests: 2,
          failedRequests: 0,
          successRate: 1,
          cacheHitRate: 0.5,
          avgLatencyMs: 12000,
          avgFirstTokenMs: 2000,
          avgOutputTokensPerSecond: measurements.speed,
        },
        dailyTrend: [
          {
            date: '2026-10-16',
            avgOutputTokensPerSecond: measurements.speed,
            avgFirstTokenMs: 2000,
          },
        ],
        trendGranularity: 'day',
      }),
    },
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

const container = document.createElement('div')
let root: ReturnType<typeof createRoot> | undefined
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container.remove()
  measurements.speed = 100
})

async function renderModal() {
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <ResourceUsageModal
        open
        scope={{ type: 'provider', providerId: 'provider', name: 'Example' }}
        onClose={() => {}}
      />,
    )
  })
}

it('shows average output speed and plots it separately from percent metrics', async () => {
  await renderModal()
  expect(document.body.textContent).toContain('100.0 t/s')
  const speedTab = Array.from(document.querySelectorAll('.ant-segmented-item')).find(
    (item) => item.textContent === 'usageDetail.speedTrend',
  )
  expect(speedTab).toBeTruthy()
  await act(async () => (speedTab as HTMLElement).click())
  const chart = document.querySelector('[data-testid="trend"]')
  expect(chart?.textContent).toContain('outputSpeed:100')
  expect(chart?.textContent).toContain('firstTokenLatency:2000')
  expect(chart?.textContent).not.toContain('successRate')
})

it('shows a dash when the selected range has no valid speed measurements', async () => {
  measurements.speed = null
  await renderModal()
  const card = Array.from(document.querySelectorAll('.ant-statistic')).find((item) =>
    item.textContent?.includes('statistics.avgOutputSpeed'),
  )
  expect(card?.textContent).toContain('—')
  expect(card?.textContent).not.toContain('0.0 t/s')
})
