// @vitest-environment jsdom
import { act } from 'react'
import { ConfigProvider } from 'antd'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DailyModelUsageItem } from '@shared/types'
import DailyModelUsageChart from './DailyModelUsageChart'
import { formatTrendTick } from './MultiMetricLineChart'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: 'en', language: 'en' },
  }),
}))
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

const data: DailyModelUsageItem[] = [
  { date: '2026-08-10', model: 'deepseek-chat', tokens: 100 },
  { date: '2026-08-10', model: 'deepseek-reasoner', tokens: 200 },
  { date: '2026-08-11', model: 'deepseek-chat', tokens: 300 },
  { date: '2026-08-11', model: 'deepseek-reasoner', tokens: 50 },
]

afterEach(() => {
  document.body.innerHTML = ''
})

describe('DailyModelUsageChart', () => {
  it('renders one legend button per model sorted by total usage', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(
        <ConfigProvider>
          <DailyModelUsageChart
            data={data}
            legendHint='点击图例显示 / 隐藏'
            ariaLabel='模型用量'
            unknownModelLabel='未知模型'
          />
        </ConfigProvider>,
      )
    })

    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.map((button) => button.textContent)).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
    ])
    for (const button of buttons) {
      expect(button.getAttribute('aria-pressed')).toBe('true')
    }

    act(() => root.unmount())
  })

  it('hides a model stack when its legend button is toggled', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(
        <ConfigProvider>
          <DailyModelUsageChart
            data={data}
            legendHint='点击图例显示 / 隐藏'
            ariaLabel='模型用量'
            unknownModelLabel='未知模型'
          />
        </ConfigProvider>,
      )
    })

    const firstButton = container.querySelector('button')
    act(() => firstButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(firstButton?.getAttribute('aria-pressed')).toBe('false')

    act(() => root.unmount())
  })

  it('groups multiple models of the same date into one bar and renders bars per model', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    act(() => {
      root.render(
        <ConfigProvider>
          <DailyModelUsageChart
            data={data}
            legendHint='点击图例显示 / 隐藏'
            ariaLabel='模型用量'
            unknownModelLabel='未知模型'
          />
        </ConfigProvider>,
      )
    })

    // 2 dates × 2 models = 4 stacked segments; recharts renders each as a rect.
    expect(container.querySelectorAll('.recharts-rectangle').length).toBe(4)

    act(() => root.unmount())
  })

  it('formats ticks for the backend-selected granularity', () => {
    expect(formatTrendTick('2026-08-12', 'day')).toBe('8/12')
    expect(formatTrendTick('2026-08-10', 'week')).toBe('8/10')
    expect(formatTrendTick('2026-08-01', 'month')).toBe('2026/08')
  })
})
