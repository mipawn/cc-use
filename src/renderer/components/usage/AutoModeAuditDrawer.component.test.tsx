// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import type { AutoModeAudit } from '@shared/types'
import AutoModeAuditDrawer from './AutoModeAuditDrawer'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const list = vi.fn()
const tools = vi.fn()

vi.mock('../../api', () => ({
  getApi: () => ({ autoModeAudit: { list, tools, get: vi.fn() } }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh' } }),
}))
vi.mock('../../hooks/useAppMessage', () => ({
  useAppMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
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

function audit(overrides: Partial<AutoModeAudit>): AutoModeAudit {
  return {
    requestId: 'req-1',
    createdAt: '2026-09-11T00:00:00Z',
    updatedAt: '2026-09-11T00:00:01Z',
    sessionRef: 'cc-use-abc',
    sessionSource: 'cc_use_session',
    clientKind: 'claude_code',
    toolName: 'Bash',
    toolUseId: 'tool-1',
    actionSummary: 'Bash · git status',
    actionTruncated: false,
    requestModel: 'claude-3-5-sonnet',
    forwardedModel: 'deepseek-v4-flash',
    thinking: 'low',
    classifierStage: null,
    verdict: 'no_block',
    verdictReason: null,
    parseOk: true,
    stopReason: 'stop_sequence',
    requestState: 'completed',
    statusCode: 200,
    errorMessage: null,
    clientOutcome: null,
    completedAt: '2026-09-11T00:00:01Z',
    ...overrides,
  }
}

let mounted: { root: Root; container: HTMLElement } | null = null

beforeEach(() => {
  list.mockReset()
  tools.mockReset()
  tools.mockResolvedValue(['Bash'])
})

afterEach(async () => {
  if (mounted) {
    await act(async () => {
      mounted!.root.unmount()
    })
    mounted!.container.remove()
    mounted = null
  }
  document.body.innerHTML = ''
})

async function render() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted = { root, container }
  await act(async () => {
    root.render(
      <StyleProvider layer>
        <ConfigProvider>
          <AutoModeAuditDrawer open timeRange='week' onClose={() => {}} />
        </ConfigProvider>
      </StyleProvider>,
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  // The drawer renders into a portal on document.body, not into the container.
  return document.body
}

it('shows the reviewed action, the model that answered, and the verdict', async () => {
  list.mockResolvedValue([audit({})])
  const body = await render()

  const text = body.textContent ?? ''
  expect(text).toContain('Bash · git status')
  expect(text).toContain('deepseek-v4-flash')
  // The verdict and the transport state are separate facts, shown separately.
  expect(text).toContain('statistics.verdictNoBlock')
  // The mocked `t` returns the key, so the state falls back to its raw value.
  expect(text).toContain('completed')
  // The proxy cannot see whether the client ran the tool.
  expect(text).toContain('statistics.autoAuditNotObserved')
})

it('keeps an unparseable answer visibly unknown rather than showing it as allowed', async () => {
  list.mockResolvedValue([
    audit({ verdict: 'unknown', parseOk: false, verdictReason: null, actionSummary: null }),
  ])
  const container = await render()

  const text = container.textContent ?? ''
  expect(text).toContain('statistics.verdictUnknown')
  expect(text).toContain('statistics.autoAuditUnknownAction')
  expect(text).not.toContain('statistics.verdictNoBlock')
})

it('shows an interrupted request as interrupted, not as a decision', async () => {
  list.mockResolvedValue([audit({ requestState: 'interrupted', verdict: null, parseOk: false })])
  const container = await render()

  const text = container.textContent ?? ''
  expect(text).toContain('interrupted')
  expect(text).toContain('statistics.verdictUnknown')
})

it('offers only the tools that actually appear in range', async () => {
  list.mockResolvedValue([audit({})])
  tools.mockResolvedValue(['Bash', 'Write'])
  await render()

  expect(tools).toHaveBeenCalledWith('week')
})
