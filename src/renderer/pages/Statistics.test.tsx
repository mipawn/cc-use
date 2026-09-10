// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import Statistics from './Statistics'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../api', () => ({
  getApi: () => ({
    requestLog: {
      getStatistics: async () => ({
        summary: {
          totalRequests: 3,
          totalTokens: 30,
          failedRequests: 1,
          cacheHitRate: 0,
          avgLatencyMs: 100,
        },
        dailyModelUsage: [],
        keyUsage: [],
        projectUsage: [],
      }),
      getRecentPaginated: async () => ({
        items: [
          { id: 'auto', requestKind: 'auto_mode', outcome: 'success' },
          { id: 'failed', requestKind: 'auto_mode', outcome: 'upstream_error', statusCode: 503 },
          { id: 'ordinary', requestKind: null, outcome: 'success' },
          { id: 'legacy', outcome: 'success' },
        ].map((row) => ({
          model: 'deepseek-v4-flash',
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          latencyMs: 100,
          createdAt: '2026-09-08T00:00:00Z',
          ...row,
        })),
        page: 1,
        pageSize: 10,
        total: 4,
      }),
    },
  }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh' } }),
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

it('marks successful and failed classifiers, leaving normal and historical requests unlabeled', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <StyleProvider layer>
          <ConfigProvider>
            <Statistics />
          </ConfigProvider>
        </StyleProvider>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    for (const id of ['auto', 'failed']) {
      expect(container.querySelector(`[data-row-key="${id}"]`)?.textContent).toContain('Auto')
    }
    for (const id of ['ordinary', 'legacy']) {
      const row = container.querySelector(`[data-row-key="${id}"]`)
      expect(row?.textContent).toContain('deepseek-v4-flash')
      expect(row?.textContent).not.toContain('Auto')
    }
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

it('keeps the list to the columns a user scans, with the Auto tag in the model cell', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <StyleProvider layer>
          <ConfigProvider>
            <Statistics />
          </ConfigProvider>
        </StyleProvider>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // Seven columns: the detail drawer holds the rest.
    const headers = Array.from(container.querySelectorAll('th')).map(
      (cell) => cell.textContent ?? '',
    )
    for (const expected of [
      'statistics.time',
      'statistics.model',
      'statistics.route',
      'statistics.tokens',
      'statistics.latency',
      'statistics.status',
      'statistics.detail',
    ]) {
      expect(headers).toContain(expected)
    }
    expect(headers).not.toContain('statistics.inputTokens')
    expect(headers).not.toContain('statistics.project')

    // The Auto label sits in the same cell as the model, not on its own row.
    const autoRow = container.querySelector('[data-row-key="auto"]')
    // Time is the first column, so the model cell is the second.
    const modelCell = autoRow?.querySelectorAll('td')[1]
    expect(modelCell?.textContent).toContain('deepseek-v4-flash')
    expect(modelCell?.textContent).toContain('Auto')
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})
