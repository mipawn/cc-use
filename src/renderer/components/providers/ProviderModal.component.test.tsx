// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import type { Provider, ProviderPreset } from '@shared/types'
import ProviderModal from './ProviderModal'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const presets = vi.fn()

vi.mock('../../api', () => ({
  getApi: () => ({
    provider: { presets },
    icon: { upload: async () => '' },
  }),
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

const deepseek: ProviderPreset = {
  id: 'deepseek',
  defaultName: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  icon: 'deepseek',
  requiresSiteAddress: false,
  needsAccountCredential: false,
  walletBalanceType: 'deepseek',
  walletBalanceUrl: 'https://api.deepseek.com/user/balance',
  usageType: 'none',
  usageUrl: null,
  requestAdapter: 'none',
  defaultKeyConfig: {
    types: ['claude_code', 'codex'],
    clientConfigs: { claude_code: { baseUrl: 'https://api.deepseek.com/anthropic' } },
    modelMapping: '{"haiku":"deepseek-v4-flash"}',
  },
}

const custom: ProviderPreset = {
  id: 'custom',
  defaultName: '',
  baseUrl: '',
  icon: 'custom',
  requiresSiteAddress: false,
  needsAccountCredential: false,
  walletBalanceType: 'none',
  walletBalanceUrl: null,
  usageType: 'none',
  usageUrl: null,
  requestAdapter: 'none',
  defaultKeyConfig: { types: ['claude_code'] },
}

let mounted: { root: Root; container: HTMLElement } | null = null

beforeEach(() => {
  presets.mockReset()
  presets.mockResolvedValue([custom, deepseek])
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

/** antd form controls carry the field name as their element id. */
function fieldValue(name: string): string | undefined {
  return document.body.querySelector<HTMLInputElement>(`input#${name}`)?.value
}

async function render(provider: Provider | null, onSave = vi.fn()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted = { root, container }
  await act(async () => {
    root.render(
      <StyleProvider layer>
        <ConfigProvider>
          <ProviderModal open provider={provider} onClose={() => {}} onSave={onSave} />
        </ConfigProvider>
      </StyleProvider>,
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return onSave
}

async function clickPreset(index: number) {
  const icons = document.body.querySelectorAll('[class*="iconItem"]')
  // The first ones belong to the preset picker; the icon picker follows.
  await act(async () => {
    ;(icons[index] as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** The advanced panel is collapsed by default; open it before asserting. */
async function openAdvanced() {
  const header = document.body.querySelector('.ant-collapse-header')
  expect(header).toBeDefined()
  await act(async () => {
    ;(header as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function submit() {
  const ok = Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.textContent === 'common.confirm',
  )
  expect(ok).toBeDefined()
  await act(async () => {
    ok!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

it('offers the catalogue on a new provider', async () => {
  await render(null)
  expect(presets).toHaveBeenCalled()
  expect(document.body.querySelectorAll('[class*="iconItem"]').length).toBeGreaterThanOrEqual(
    2 + 4, // preset picker + icon picker
  )
})

it('fills the address, name and query settings from the chosen preset', async () => {
  await render(null)

  await clickPreset(1) // deepseek

  expect(fieldValue('baseUrl')).toBe('https://api.deepseek.com')
  expect(fieldValue('name')).toBe('deepseek')

  // Opening the advanced panel shows the template's query settings rather than
  // a blank default; the values themselves are asserted on the save payload.
  await openAdvanced()
  expect(document.body.querySelectorAll('.ant-select').length).toBeGreaterThanOrEqual(2)
})

it('sends the template origin and its key defaults when creating', async () => {
  const onSave = await render(null)
  await clickPreset(1)
  await submit()

  expect(onSave).toHaveBeenCalledTimes(1)
  const input = onSave.mock.calls[0][0]
  expect(input).toMatchObject({
    presetId: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    name: 'deepseek',
    // Section 2 never opened the advanced panel, yet the template's query
    // settings and adapter still reach the save payload.
    walletBalanceType: 'deepseek',
    walletBalanceUrl: 'https://api.deepseek.com/user/balance',
    usageType: 'none',
  })
  expect(input.defaultKeyConfig).toMatchObject({ types: ['claude_code', 'codex'] })
})

it('keeps the stored origin when editing, without re-applying a template', async () => {
  const provider: Provider = {
    id: 'provider-1',
    name: 'my gateway',
    baseUrl: 'https://custom.example.com',
    httpProxy: null,
    website: null,
    remark: null,
    token: null,
    icon: 'newapi',
    walletBalanceType: 'none',
    walletBalanceUrl: null,
    walletBalancePath: null,
    walletBalanceHeaders: null,
    walletBalanceUserId: null,
    cachedWalletBalance: null,
    lastBalanceCheckedAt: null,
    usageType: 'none',
    usageUrl: null,
    usagePath: null,
    usageHeaders: null,
    cachedUsage: null,
    lastUsageCheckedAt: null,
    isActive: true,
    sortOrder: 0,
    presetId: 'newapi',
    defaultKeyConfig: { types: ['claude_code'] },
  }

  const onSave = await render(provider)
  // No preset picker on edit: the stored config is the source of truth.
  expect(document.body.querySelectorAll('[class*="iconItem"]').length).toBe(4 + 1)
  await submit()

  expect(onSave.mock.calls[0][0]).toMatchObject({
    id: 'provider-1',
    presetId: 'newapi',
    baseUrl: 'https://custom.example.com',
  })
  expect(onSave.mock.calls[0][0].defaultKeyConfig).toMatchObject({ types: ['claude_code'] })
})
