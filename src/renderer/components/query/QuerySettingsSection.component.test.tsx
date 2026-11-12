// @vitest-environment jsdom
import { act, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import dayjs from 'dayjs'
import { ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import type { QueryScope, QuerySchemeInfo, QueryTestResult } from '@shared/types'
import QuerySettingsSection, {
  type QueryScriptValue,
  type QuerySectionTestInput,
} from './QuerySettingsSection'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const schemesMock = vi.fn()

vi.mock('../../api', () => ({
  getApi: () => ({ balance: { schemes: schemesMock } }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { names?: string }) =>
      values?.names ? `${key}: ${values.names}` : key,
  }),
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

const DEEPSEEK_TEXT = `({
  request: { url: "https://api.deepseek.com/user/balance", method: "GET" },
  extractor: function (response) { return { remaining: response.balance } }
})`
const NEWAPI_TEXT = `({
  request: { url: "{{baseUrl}}/api/user/self", method: "GET" },
  extractor: function (response) { return { remaining: response.data.quota / 500000 } }
})`
const GO_TEXT = `({
  request: { url: "{{baseUrl}}/v1/usage", method: "GET" },
  extractor: function (response) { return { windows: response.windows } }
})`
const KEY_TEXT = `({
  request: { url: "{{baseUrl}}/api/usage/token/", method: "GET" },
  extractor: function (response) { return { remaining: response.quota / 500000 } }
})`
const COMMAND_CODE_TEXT = `({
  request: { url: "https://api.commandcode.ai/alpha/billing/usage", method: "GET",
             headers: { Authorization: "Bearer {{apiKey}}" } },
  extractor: function (response) { return { windows: response.windows } }
})`

const accountSchemes: QuerySchemeInfo[] = [
  {
    id: 'deepseek-account',
    scope: 'account',
    labelKey: 'querySchemes.deepseekAccount',
    descriptionKey: 'querySchemes.deepseekAccountDescription',
    credentialRequirements: ['apiKey'],
    supportsWindows: false,
    script: DEEPSEEK_TEXT,
  },
  {
    id: 'newapi-account',
    scope: 'account',
    labelKey: 'querySchemes.newApiAccount',
    descriptionKey: 'querySchemes.newApiAccountDescription',
    credentialRequirements: ['accessToken', 'userId'],
    supportsWindows: false,
    script: NEWAPI_TEXT,
  },
]

const keySchemes: QuerySchemeInfo[] = [
  {
    id: 'newapi-key',
    scope: 'key',
    labelKey: 'querySchemes.newApiKey',
    descriptionKey: 'querySchemes.newApiKeyDescription',
    credentialRequirements: ['apiKey'],
    supportsWindows: false,
    script: KEY_TEXT,
  },
  {
    id: 'opencode-go-key',
    scope: 'key',
    labelKey: 'querySchemes.openCodeGoKey',
    descriptionKey: 'querySchemes.openCodeGoKeyDescription',
    credentialRequirements: ['apiKey'],
    supportsWindows: true,
    script: GO_TEXT,
  },
  {
    id: 'command-code-key',
    scope: 'key',
    labelKey: 'querySchemes.commandCodeKey',
    descriptionKey: 'querySchemes.commandCodeKeyDescription',
    credentialRequirements: ['apiKey'],
    supportsWindows: true,
    script: COMMAND_CODE_TEXT,
  },
]

let mounted: { root: Root; container: HTMLElement } | null = null

interface HarnessOptions {
  scope?: QueryScope
  onDraftTest?: (input: QuerySectionTestInput) => Promise<QueryTestResult>
}

/** A fixture `QueryTestResult` builder keeps the mock closures typed. */
function asResult(
  patch: Partial<{
    scope: QueryScope
    usage: QueryTestResult['usage']
    isValid: boolean
    invalidMessage: string | null
    error: string | null
  }> = {},
): QueryTestResult {
  const {
    scope = 'account',
    usage = null,
    isValid = false,
    invalidMessage = null,
    error = null,
  } = patch
  return { scope, usage, isValid, invalidMessage, error }
}

/** A failed default the starter tests never reach. */
const neverTest = (): Promise<QueryTestResult> => Promise.resolve(asResult({ error: 'no run' }))

/**
 * Controlled harness: the section gets exactly what a modal would give it, and
 * the current value is mirrored into a data attribute the tests can read.
 */
async function renderSection(
  initial: QueryScriptValue,
  options: HarnessOptions = {},
): Promise<{ changeCalls: QueryScriptValue[] }> {
  // Never leave a previous harness attached: antd portals would carry over.
  if (mounted) {
    await act(async () => {
      mounted!.root.unmount()
    })
    mounted!.container.remove()
    mounted = null
    document.body.innerHTML = ''
  }
  const changeCalls: QueryScriptValue[] = []
  const onDraftTest = options.onDraftTest ?? neverTest
  const scope = options.scope ?? 'account'

  function ModalStub() {
    const [value, setValue] = useState<QueryScriptValue>(initial)
    const record = (next: QueryScriptValue) => {
      changeCalls.push(next)
      setValue(next)
    }
    return (
      <div>
        <span data-value={JSON.stringify(value)} aria-hidden='true' />
        <QuerySettingsSection
          scope={scope}
          value={value}
          onChange={record}
          testVisible
          onDraftTest={onDraftTest}
        />
      </div>
    )
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted = { root, container }
  await act(async () => {
    root.render(
      <StyleProvider layer>
        <ConfigProvider>
          <ModalStub />
        </ConfigProvider>
      </StyleProvider>,
    )
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { changeCalls }
}

function currentValue(): QueryScriptValue {
  const raw = document.body.querySelector('[data-value]')?.getAttribute('data-value') ?? '{}'
  return JSON.parse(raw) as QueryScriptValue
}

async function clickSwitch() {
  const toggle = document.body.querySelector('[role="switch"]')
  expect(toggle).not.toBeNull()
  await act(async () => {
    ;(toggle as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function clickButton(text: string) {
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (item) => item.textContent === text,
  )
  expect(button).toBeDefined()
  await act(async () => {
    ;(button as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function chooseScheme(label: string) {
  const trigger = document.body.querySelector('.ant-select input[role="combobox"]')
  expect(trigger).not.toBeNull()
  await act(async () => {
    ;(trigger as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', keyCode: 40, bubbles: true }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const option = Array.from(document.body.querySelectorAll('.ant-select-item-option')).find(
    (item) => item.textContent === label,
  )
  expect(option).toBeDefined()
  await act(async () => {
    ;(option as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function editor(): HTMLTextAreaElement | undefined {
  const node = document.body.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="querySchemes.customScriptLabel"]',
  )
  return node ?? undefined
}

async function typeInto(element: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(element, text)
    element.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function runTest() {
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (item) => item.textContent === 'querySchemes.test',
  )
  expect(button).toBeDefined()
  await act(async () => {
    ;(button as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function successPanel(): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[role="status"]')).find((node) =>
    node.textContent?.includes('querySchemes.testSuccess'),
  )
}

function alertPanel(): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLElement>('[role="alert"]'))[0]
}

beforeEach(() => {
  schemesMock.mockReset()
  schemesMock.mockImplementation((scope?: QueryScope) =>
    scope === 'key' ? Promise.resolve(keySchemes) : Promise.resolve(accountSchemes),
  )
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

it('does not enable the query on open or while the script text is edited', async () => {
  const { changeCalls } = await renderSection(
    { enabled: false, schemeId: 'custom', script: 'existing text' },
    { scope: 'key' },
  )

  const toggle = document.body.querySelector('[role="switch"]')
  expect(toggle?.getAttribute('aria-checked')).toBe('false')

  await clickButton('querySchemes.customize')
  await typeInto(editor()!, 'new text')

  expect(changeCalls.at(-1)).toMatchObject({ enabled: false, script: 'new text' })
  expect(currentValue().enabled).toBe(false)
})

it('choosing a named scheme enables the query and writes the scheme script in one change', async () => {
  const { changeCalls } = await renderSection(
    { enabled: false, schemeId: '', script: '' },
    { scope: 'account' },
  )

  await chooseScheme('querySchemes.deepseekAccount')

  expect(changeCalls).toHaveLength(1)
  expect(currentValue()).toEqual({
    enabled: true,
    schemeId: 'deepseek-account',
    script: DEEPSEEK_TEXT,
  })
})

it('turning the switch off keeps the scheme and the script text', async () => {
  const { changeCalls } = await renderSection(
    { enabled: true, schemeId: 'deepseek-account', script: DEEPSEEK_TEXT },
    { scope: 'account' },
  )

  await clickSwitch()

  expect(changeCalls.at(-1)).toEqual({
    enabled: false,
    schemeId: 'deepseek-account',
    script: DEEPSEEK_TEXT,
  })
})

it('keeps the code hidden while a scheme is selected and reveals the text through the custom affordance', async () => {
  const { changeCalls } = await renderSection(
    { enabled: true, schemeId: 'deepseek-account', script: DEEPSEEK_TEXT },
    { scope: 'account' },
  )

  expect(editor()).toBeUndefined()
  expect(document.body.textContent).toContain('querySchemes.basedOnScheme')

  await clickButton('querySchemes.basedOnScheme')

  expect(editor()?.value).toBe(DEEPSEEK_TEXT)
  expect(currentValue()).toMatchObject({ schemeId: 'custom', script: DEEPSEEK_TEXT })
  expect(changeCalls.at(-1)?.schemeId).toBe('custom')
})

it('shows the stored text behind the custom entry when the script is not a scheme script', async () => {
  const edited = `${DEEPSEEK_TEXT}\n// mine`
  await renderSection(
    { enabled: true, schemeId: 'deepseek-account', script: edited },
    { scope: 'account' },
  )

  // The stored script is not byte-identical, so the entry is explicit and the
  // original text is displayed in full once entered.
  expect(editor()).toBeUndefined()
  await clickButton('querySchemes.customize')
  expect(editor()?.value).toBe(edited)
})

it('shows scheme capabilities and credentials for the selected scheme', async () => {
  await renderSection(
    { enabled: true, schemeId: 'opencode-go-key', script: GO_TEXT },
    { scope: 'key' },
  )

  expect(document.body.textContent).toContain('querySchemes.capabilityWindows')
  expect(document.body.textContent).toContain('querySchemes.credentialApiKey')
})

it('tags a scheme by its own window capability, not by the scope', async () => {
  await renderSection({ enabled: true, schemeId: 'newapi-key', script: KEY_TEXT }, { scope: 'key' })

  // A key scheme may still be amount-only; the tag follows supportsWindows.
  expect(document.body.textContent).toContain('querySchemes.capabilityAmount')
  expect(document.body.textContent).not.toContain('querySchemes.capabilityWindows')
})

it('renders no scheme description line: the scheme choice is self-named', async () => {
  await renderSection(
    { enabled: true, schemeId: 'deepseek-account', script: '({})' },
    { scope: 'account' },
  )
  expect(document.body.textContent).not.toContain('querySchemes.deepseekAccountDescription')
  await renderSection(
    { enabled: true, schemeId: 'custom', script: '({request:{}})' },
    { scope: 'account' },
  )
  expect(document.body.textContent).not.toContain('querySchemes.customHint')
})

it('disables the test button while no script is configured and explains it', async () => {
  await renderSection({ enabled: false, schemeId: '', script: '' }, { scope: 'key' })

  const button = Array.from(document.body.querySelectorAll('button')).find(
    (item) => item.textContent === 'querySchemes.test',
  )
  expect(button?.hasAttribute('disabled')).toBe(true)
  expect(document.body.textContent).toContain('querySchemes.testNeedScript')
})

it('ignores a testDraft response that resolved after the value changed', async () => {
  let resolveFirst!: (result: QueryTestResult) => void
  const first = new Promise<QueryTestResult>((resolve) => {
    resolveFirst = resolve
  })
  const onDraftTest = vi.fn<NonNullable<HarnessOptions['onDraftTest']>>(async () => {
    if (onDraftTest.mock.calls.length === 1) return first
    return asResult({
      scope: 'key',
      usage: { remaining: 7, unit: 'USD', isUnlimited: false },
      isValid: true,
    })
  })

  await renderSection(
    { enabled: true, schemeId: 'custom', script: KEY_TEXT },
    { scope: 'key', onDraftTest },
  )

  await runTest()
  expect(onDraftTest).toHaveBeenCalledTimes(1)

  // The script text changes while the first run is still pending.
  await clickButton('querySchemes.customize')
  await typeInto(editor()!, `${KEY_TEXT}\n// edited`)
  expect(document.body.textContent).not.toContain('querySchemes.testSuccess')

  await act(async () => {
    resolveFirst({
      scope: 'key',
      usage: { remaining: 1, unit: 'USD', isUnlimited: false },
      isValid: true,
      invalidMessage: null,
      error: null,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  // The stale answer must never land: the panel stays empty of a success.
  expect(successPanel()).toBeUndefined()
  expect(document.body.textContent).not.toContain('$1.00')

  await runTest()
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(successPanel()).toBeDefined()
  expect(document.body.textContent).toContain('$7.00')
})

it('renders a failure as a failure and never as a number', async () => {
  const onDraftTest: HarnessOptions['onDraftTest'] = vi.fn(async () =>
    asResult({ error: '服务报告密钥不可用' }),
  )
  await renderSection(
    { enabled: true, schemeId: 'custom', script: DEEPSEEK_TEXT },
    { scope: 'account', onDraftTest },
  )

  await runTest()

  const alert = alertPanel()
  expect(alert).toBeDefined()
  expect(alert!.textContent).toContain('服务报告密钥不可用')
  expect(document.body.textContent).not.toContain('querySchemes.testSuccess')
})

it('renders unlimited as ∞ and omits an amount the answer never reported', async () => {
  let call = 0
  const onDraftTest: HarnessOptions['onDraftTest'] = vi.fn(async () => {
    call += 1
    return asResult({
      isValid: true,
      usage:
        call === 1
          ? // No remaining field at all: the renderer must not invent a zero,
            // and there is no amount row to print a dash from.
            { unit: 'USD', isUnlimited: false }
          : { unit: 'USD', isUnlimited: true },
    })
  })
  await renderSection(
    { enabled: true, schemeId: 'custom', script: DEEPSEEK_TEXT },
    { scope: 'account', onDraftTest },
  )

  await runTest()
  expect(successPanel()).toBeDefined()
  expect(successPanel()?.textContent).not.toContain('querySchemes.resultRemaining')
  expect(successPanel()?.textContent).not.toContain('—')
  expect(document.body.textContent).not.toContain('$0.00')

  await runTest()
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(successPanel()?.textContent).toContain('∞')
})

it('shows the expiry time the answer carries', async () => {
  const onDraftTest: HarnessOptions['onDraftTest'] = vi.fn(async () =>
    asResult({
      scope: 'key',
      isValid: true,
      usage: { remaining: 2, unit: 'USD', isUnlimited: false, expireAt: '2026-11-20T08:30:00Z' },
    }),
  )
  await renderSection(
    { enabled: true, schemeId: 'custom', script: KEY_TEXT },
    { scope: 'key', onDraftTest },
  )

  await runTest()

  expect(document.body.textContent).toContain('querySchemes.resultExpireAt')
  // The stamp is shown in the local zone through dayjs, so compute the same
  // expectation from the same library instead of hard-coding an offset.
  expect(document.body.textContent).toContain(
    dayjs('2026-11-20T08:30:00Z').format('YYYY-MM-DD HH:mm'),
  )
})

it('renders the metering periods an answer carries, on either scope', async () => {
  const usage = {
    remaining: 4,
    unit: 'USD',
    isUnlimited: false,
    windows: [{ id: 'rolling', label: 'rolling', usedPercent: 40, resetsAt: null, status: 'ok' }],
  }
  await renderSection(
    { enabled: true, schemeId: 'custom', script: DEEPSEEK_TEXT },
    {
      scope: 'account',
      onDraftTest: async () => asResult({ usage, isValid: true }),
    },
  )
  await runTest()
  expect(document.body.querySelectorAll('[role="progressbar"]').length).toBeGreaterThan(0)

  // The key scope keeps windows now: a key answer may be metering periods too.
  await renderSection(
    { enabled: true, schemeId: 'custom', script: KEY_TEXT },
    {
      scope: 'key',
      onDraftTest: async () => asResult({ scope: 'key', usage, isValid: true }),
    },
  )
  await runTest()
  expect(document.body.querySelectorAll('[role="progressbar"]').length).toBeGreaterThan(0)
  expect(successPanel()?.textContent).toContain('$4.00')
})

it('renders a key-scope window-only answer as a success with every period', async () => {
  const usage = {
    windows: ['rolling', 'weekly', 'monthly'].map((id) => ({
      id,
      label: id,
      usedPercent: 42,
      resetsAt: null,
      status: 'ok',
    })),
  }
  await renderSection(
    { enabled: true, schemeId: 'command-code-key', script: COMMAND_CODE_TEXT },
    {
      scope: 'key',
      onDraftTest: async () => asResult({ scope: 'key', usage, isValid: true }),
    },
  )
  await runTest()

  // Windows only: a success with periods, no fabricated amount row.
  expect(successPanel()).toBeDefined()
  expect(document.body.querySelectorAll('[role="progressbar"]')).toHaveLength(3)
  expect(successPanel()?.textContent).toContain('providers.periodRolling')
  expect(successPanel()?.textContent).toContain('providers.periodWeekly')
  expect(successPanel()?.textContent).toContain('providers.periodMonthly')
  expect(successPanel()?.textContent).not.toContain('querySchemes.resultRemaining')
  expect(document.body.textContent).not.toContain('$0.00')
})
