// @vitest-environment jsdom
import { act } from 'react'
import { ConfigProvider } from 'antd'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import MultiMetricLineChart, { type LineSeries } from './MultiMetricLineChart'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

interface Day {
  date: string
  tokens: number
  requests: number
  cacheHitRate: number
}

const data: Day[] = [
  { date: '2026-08-10', tokens: 100, requests: 2, cacheHitRate: 0.25 },
  { date: '2026-08-11', tokens: 300, requests: 5, cacheHitRate: 0.75 },
]

const series: LineSeries<Day>[] = [
  {
    key: 'tokens',
    label: 'Token',
    color: '#1677ff',
    value: (item) => item.tokens,
    format: (value) => `${value} Token`,
  },
  {
    key: 'requests',
    label: '请求',
    color: '#faad14',
    value: (item) => item.requests,
    format: (value) => `${value} 次`,
  },
  {
    key: 'cache',
    label: '缓存命中率',
    color: '#9254de',
    value: (item) => item.cacheHitRate,
    format: (value) => `${Number(value) * 100}%`,
    domainMax: 1,
  },
]

afterEach(() => {
  document.body.innerHTML = ''
})

describe('MultiMetricLineChart', () => {
  it('renders every metric as a line and shows all values on pointer hover', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(
        <ConfigProvider>
          <MultiMetricLineChart
            data={data}
            series={series}
            getDate={(item) => item.date}
            ariaLabel='多指标趋势'
            relativeScaleLabel='独立量程'
          />
        </ConfigProvider>,
      )
    })

    expect(container.querySelectorAll('path')).toHaveLength(3)
    const hitArea = container.querySelector('rect')
    expect(hitArea).not.toBeNull()
    if (!hitArea) return
    hitArea.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 100 }) as DOMRect

    act(() => {
      hitArea.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 100, clientY: 50 }),
      )
    })

    const tooltip = container.querySelector('[role="tooltip"]')
    expect(tooltip?.textContent).toContain('2026-08-11')
    expect(tooltip?.textContent).toContain('300 Token')
    expect(tooltip?.textContent).toContain('5 次')
    expect(tooltip?.textContent).toContain('75%')

    act(() => root.unmount())
  })
})
