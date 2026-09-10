// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import type { ApiKey, Provider } from '@shared/types'
import KeyEditModal from './KeyEditModal'
import { buildDuplicatedKeyDraft, type KeyEditMode } from '../../utils/apiKeyEditor'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../api', () => ({
  getApi: () => ({
    terminal: { getLaunchPreview: async () => null },
  }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh' } }),
}))
vi.mock('../../hooks/useAppMessage', () => ({
  useAppMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: () => ({ globalSettings: {} }),
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

let mounted: { root: Root; container: HTMLElement } | null = null

afterEach(async () => {
  if (mounted) {
    await act(async () => {
      mounted!.root.unmount()
    })
    mounted!.container.remove()
    mounted = null
  }
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

const deepseekProvider: Provider = {
  id: 'provider-1',
  name: 'deepseek',
  baseUrl: 'https://api.deepseek.com/anthropic',
  httpProxy: null,
  website: null,
  remark: null,
  token: null,
  icon: 'deepseek',
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
}

function sourceKey(): ApiKey {
  return {
    id: 'key-1',
    providerId: 'provider-1',
    alias: 'daily',
    value: 'sk-source-credential',
    types: ['claude_code'],
    priority: 2,
    isExhausted: false,
    isActive: true,
    usageType: 'custom',
    usageUrl: 'https://quota.example.com',
    usagePath: 'data.remaining',
    usageHeaders: null,
    cachedUsage: null,
    lastUsageCheckedAt: null,
    modelMapping: JSON.stringify({ haiku: 'source-haiku', sonnet: 'source-sonnet' }),
    clientConfigs: {
      claude_code: { baseUrl: 'https://source.example.com/anthropic', authScheme: 'bearer' },
    },
    cooldownUntil: null,
    lastErrorAt: null,
    lastErrorKind: null,
    consecutiveErrors: 0,
  }
}

async function render(mode: KeyEditMode, apiKey: ApiKey | null, onSave = vi.fn()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted = { root, container }
  await act(async () => {
    root.render(
      <StyleProvider layer>
        <ConfigProvider>
          <KeyEditModal
            open
            mode={mode}
            apiKey={apiKey}
            providers={[deepseekProvider]}
            defaultProviderId='provider-1'
            onClose={() => {}}
            onSave={onSave}
          />
        </ConfigProvider>
      </StyleProvider>,
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return onSave
}

const query = (selector: string) => document.body.querySelector<HTMLInputElement>(selector)

/** Tabs render their pane lazily, so an inactive tab has to be opened first. */
async function openTab(label: string) {
  const tab = Array.from(document.body.querySelectorAll('.ant-tabs-tab')).find((node) =>
    node.textContent?.includes(label),
  )
  expect(tab).toBeDefined()
  await act(async () => {
    ;(tab as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

it('fills every tab from the source key when duplicating', async () => {
  await render('duplicate', buildDuplicatedKeyDraft(sourceKey(), '（副本）'))

  expect(query('input[type="password"]')?.value).toBe('sk-source-credential')
  expect(query('input#alias')?.value).toBe('daily（副本）')

  // Quota settings travel with the copy instead of resetting to the defaults.
  const fieldValues = Array.from(document.body.querySelectorAll('input, textarea')).map(
    (field) => (field as HTMLInputElement | HTMLTextAreaElement).value,
  )
  expect(fieldValues).toContain('https://quota.example.com')
  expect(fieldValues).toContain('data.remaining')

  // The copy opens on the model mapping so it can be re-pointed immediately.
  expect(document.body.querySelector('.ant-tabs-tab-active')?.textContent).toContain('模型映射')
  expect(query('input[placeholder="claude-haiku-4-5"]')?.value).toBe('source-haiku')
  expect(query('input[placeholder="claude-sonnet-4-5"]')?.value).toBe('source-sonnet')
})

it('keeps provider defaults out of the duplicated draft', async () => {
  await render('duplicate', buildDuplicatedKeyDraft(sourceKey()))

  expect(query('input[placeholder="claude-haiku-4-5"]')?.value).not.toBe('deepseek-v4-flash')
  expect(query('input[placeholder="claude-opus-4-7"]')?.value).toBe('')
})

it('still starts a plain create from provider defaults', async () => {
  await render('create', null)

  expect(query('input[type="password"]')?.value).toBe('')
  expect(document.body.querySelector('.ant-tabs-tab-active')?.textContent).toContain('基础')

  await openTab('模型映射')
  expect(query('input[placeholder="claude-haiku-4-5"]')?.value).toBe('deepseek-v4-flash')
})

it('saves the copy as a new record without the source id', async () => {
  const onSave = await render('duplicate', buildDuplicatedKeyDraft(sourceKey()))

  const saveButton = Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.textContent === 'common.confirm',
  )
  expect(saveButton).toBeDefined()
  await act(async () => {
    saveButton!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  expect(onSave).toHaveBeenCalledTimes(1)
  expect(onSave.mock.calls[0][0]).toMatchObject({
    mode: 'duplicate',
    providerId: 'provider-1',
    value: 'sk-source-credential',
  })
  // No id means the save path inserts a new record; the source stays untouched.
  expect(onSave.mock.calls[0][0].id).toBeUndefined()
})

it('saves an edit against the existing id', async () => {
  const source = sourceKey()
  const onSave = await render('edit', source)

  const saveButton = Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.textContent === 'common.confirm',
  )
  await act(async () => {
    saveButton!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  expect(onSave.mock.calls[0][0]).toMatchObject({ mode: 'edit', id: 'key-1' })
})
