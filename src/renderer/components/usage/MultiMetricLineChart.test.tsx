// @vitest-environment jsdom
import { act } from 'react'
import { ConfigProvider } from 'antd'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import MultiMetricLineChart, {
  MAX_RENDERED_POINTS,
  sampleEvenly,
  type LineAxisDefinition,
  type LineSeries,
} from './MultiMetricLineChart'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

class ResizeObserverMock implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.callback(
      [
        {
          target,
          contentRect: {
            width: 800,
            height: 286,
            top: 0,
            right: 800,
            bottom: 286,
            left: 0,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          },
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      this,
    )
  }

  unobserve() {}
  disconnect() {}
  takeRecords(): ResizeObserverEntry[] {
    return []
  }
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock)

interface Day {
  date: string
  tokens: number
  requests: number
}

const data: Day[] = [
  { date: '2026-08-10', tokens: 100, requests: 2 },
  { date: '2026-08-11', tokens: 300, requests: 5 },
]

const series: LineSeries<Day>[] = [
  {
    key: 'tokens',
    label: 'Token',
    color: '#1677ff',
    axisKey: 'tokens',
    value: (item) => item.tokens,
    format: (value) => `${value} Token`,
  },
  {
    key: 'requests',
    label: '请求',
    color: '#faad14',
    axisKey: 'requests',
    value: (item) => item.requests,
    format: (value) => `${value} 次`,
  },
]

const axes: LineAxisDefinition[] = [
  {
    key: 'tokens',
    label: 'Token',
    orientation: 'left',
    formatTick: (value) => String(value),
  },
  {
    key: 'requests',
    label: '请求数',
    orientation: 'right',
    formatTick: (value) => String(value),
  },
]

afterEach(() => {
  document.body.innerHTML = ''
})

describe('MultiMetricLineChart', () => {
  it('uses real unit axes and lets the legend toggle each line', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(
        <ConfigProvider>
          <MultiMetricLineChart
            data={data}
            series={series}
            axes={axes}
            getDate={(item) => item.date}
            ariaLabel='多指标趋势'
            legendHint='点击图例显示 / 隐藏'
            sampledHint={(shown, total) => `展示 ${shown} / ${total}`}
          />
        </ConfigProvider>,
      )
    })

    const tokenLegend = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Token',
    )
    expect(tokenLegend?.getAttribute('aria-pressed')).toBe('true')
    expect(container.textContent).toContain('请求数')
    expect(container.textContent?.match(/Token/g)).toHaveLength(2)

    act(() => tokenLegend?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(tokenLegend?.getAttribute('aria-pressed')).toBe('false')
    expect(container.textContent?.match(/Token/g)).toHaveLength(1)

    act(() => root.unmount())
  })

  it('caps rendered points while preserving both ends of a large range', () => {
    const largeRange = Array.from({ length: 2_000 }, (_, index) => index)
    const sampled = sampleEvenly(largeRange)

    expect(sampled).toHaveLength(MAX_RENDERED_POINTS)
    expect(sampled[0]).toBe(0)
    expect(sampled.at(-1)).toBe(1_999)
  })
})
