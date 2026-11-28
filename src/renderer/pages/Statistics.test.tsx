// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import Statistics from './Statistics'
import { MemoryRouter } from 'react-router-dom'
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
          avgFirstTokenMs: 20,
          avgOutputTokensPerSecond: 62.5,
        },
        dailyModelUsage: [],
        keyUsage: [],
        projectUsage: [],
      }),
      syncAntigravity: async () => ({
        scannedFiles: 0,
        updatedConversations: 0,
        removedFiles: 0,
      }),
      onAntigravityUpdated: () => () => {},
      getRecentPaginated: async () => ({
        items: [
          {
            id: 'auto',
            requestKind: 'auto_mode',
            outcome: 'success',
            firstTokenMs: 20,
            outputTokensPerSecond: 62.5,
          },
          { id: 'failed', requestKind: 'auto_mode', outcome: 'upstream_error', statusCode: 503 },
          { id: 'ordinary', requestKind: null, outcome: 'success' },
          // The backend always sends a number for Antigravity rows, so `0` is the
          // realistic "never retried" value and pins the `> 0` guard.
          { id: 'legacy', outcome: 'success', retryCount: 0 },
          // `retryCount` is Antigravity-only; this row drives the drawer's
          // "shown only when > 0" branch without changing the ledger headers.
          { id: 'retried', requestKind: null, outcome: 'success', retryCount: 3 },
        ].map((row) => ({
          model: 'deepseek-v4-flash',
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          latencyMs: 100,
          firstTokenMs: null,
          outputTokensPerSecond: null,
          createdAt: '2026-09-08T00:00:00Z',
          ...row,
        })),
        page: 1,
        pageSize: 10,
        total: 5,
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
            <MemoryRouter>
              <Statistics />
            </MemoryRouter>
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
            <MemoryRouter>
              <Statistics />
            </MemoryRouter>
          </ConfigProvider>
        </StyleProvider>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // Request timing and output rate are visible without opening details.
    const headers = Array.from(container.querySelectorAll('th')).map(
      (cell) => cell.textContent ?? '',
    )
    for (const expected of [
      'statistics.time',
      'statistics.model',
      'statistics.route',
      'statistics.tokens',
      'statistics.outputSpeed',
      'statistics.firstTokenLatency',
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

    const cells = autoRow?.querySelectorAll('td')
    expect(cells?.[4].textContent).toContain('62.5 tok/s')
    expect(cells?.[5].textContent).toContain('20 ms')
    expect(cells?.[6].textContent).toContain('100 ms')
    // Proxy rows label the end-to-end latency and expose no thinking/response split.
    expect(cells?.[6].textContent).toContain('statistics.latency')
    expect(cells?.[3].textContent).not.toContain('observation.thinkingTokens')
    const legacyCells = container.querySelector('[data-row-key="legacy"]')?.querySelectorAll('td')
    expect(legacyCells?.[4].textContent).toBe('—')
    expect(legacyCells?.[5].textContent).toBe('—')
    expect(
      container.querySelector('[data-row-key="failed"]')?.querySelectorAll('td')[4].textContent,
    ).toBe('—')

    await act(async () => {
      ;(autoRow?.querySelector('button') as HTMLButtonElement).click()
    })
    const drawer = document.querySelector('.ant-drawer-body')
    expect(drawer?.textContent).toContain('statistics.outputSpeed')
    expect(drawer?.textContent).toContain('62.5 tok/s')
    expect(drawer?.textContent).toContain('20 ms')
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

it('explains a retried generation only when it was actually retried', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  // Descriptions labels are table headers inside the drawer; the value is the cell after it.
  const drawerLabels = () =>
    Array.from(document.querySelectorAll('.ant-drawer-body th')).map((cell) => cell.textContent)
  const retryLabel = () => drawerLabels().indexOf('observation.retryCount')
  try {
    await act(async () => {
      root.render(
        <StyleProvider layer>
          <ConfigProvider>
            <MemoryRouter>
              <Statistics />
            </MemoryRouter>
          </ConfigProvider>
        </StyleProvider>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // A five-attempt chain that ended in success looks slow, not broken.
    await act(async () => {
      ;(container.querySelector('[data-row-key="retried"] button') as HTMLButtonElement).click()
    })
    const labels = drawerLabels()
    const index = retryLabel()
    expect(index).toBeGreaterThan(0)
    expect(labels[index - 1]).toBe('statistics.latency')
    const retryCell = document.querySelectorAll('.ant-drawer-body th')[index]
    expect(retryCell.nextElementSibling?.textContent).toBe('3')

    // A generation that was never retried gets no row at all, and `retryCount: 0`
    // (what the backend actually sends) must not print "0".
    await act(async () => {
      ;(container.querySelector('[data-row-key="legacy"] button') as HTMLButtonElement).click()
    })
    expect(retryLabel()).toBe(-1)
    expect(document.querySelectorAll('.ant-drawer-body th').length).toBe(labels.length - 1)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})
