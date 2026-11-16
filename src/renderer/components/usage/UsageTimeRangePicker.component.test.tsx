// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import { createRoot, type Root } from 'react-dom/client'
import type { StatsTimeRange } from '@shared/types'
import UsageTimeRangePicker from './UsageTimeRangePicker'
;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
Object.defineProperty(window, 'matchMedia', {
  writable: true,
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

let root: Root | undefined
let container: HTMLDivElement
const onChange = vi.fn<(value: StatsTimeRange) => void>()
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
function element(value: StatsTimeRange) {
  return (
    <StyleProvider layer>
      <ConfigProvider theme={{ token: { motion: false } }}>
        <UsageTimeRangePicker value={value} onChange={onChange} />
      </ConfigProvider>
    </StyleProvider>
  )
}
async function rerender(value: StatsTimeRange) {
  await act(async () => root!.render(element(value)))
  await flush()
}
async function render(value: StatsTimeRange) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await rerender(value)
}
function inputValues() {
  return Array.from(container.querySelectorAll<HTMLInputElement>('.ant-picker input')).map(
    (input) => input.value,
  )
}
function selectedMode() {
  return container.querySelector('.ant-segmented-item-selected')?.textContent
}
async function selectMode(label: string) {
  const option = Array.from(container.querySelectorAll<HTMLElement>('.ant-segmented-item')).find(
    (item) => item.textContent === label,
  )
  expect(option, label).toBeDefined()
  await act(async () => option!.click())
  await flush()
}
async function pickDate(date: string) {
  const cell = document.querySelector<HTMLElement>(
    `.ant-picker-dropdown td[title="${date}"] .ant-picker-cell-inner`,
  )
  expect(cell, date).not.toBeNull()
  await act(async () => cell!.click())
  await flush()
}
async function openCalendar() {
  const start = container.querySelector<HTMLInputElement>(
    'input[placeholder="statistics.startDate"]',
  )!
  await act(async () => {
    start.focus()
    start.click()
  })
  await flush()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 4, 16, 0, 15))
  onChange.mockReset()
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = undefined
  container?.remove()
  vi.useRealTimers()
})

describe('UsageTimeRangePicker controlled observation scope', () => {
  it.each([
    ['today', '2026-05-16'],
    ['yesterday', '2026-05-15'],
  ] as const)(
    'displays %s as its local calendar day without adding a preset',
    async (value, date) => {
      await render(value)
      expect(selectedMode()).toBe('statistics.custom')
      expect(inputValues()).toEqual([date, date])
      expect(container.querySelectorAll('.ant-segmented-item')).toHaveLength(8)
      expect(onChange).not.toHaveBeenCalled()
    },
  )

  it('follows external today and yesterday query changes without emitting a replacement query', async () => {
    await render('all')
    await rerender('today')
    expect(selectedMode()).toBe('statistics.custom')
    expect(inputValues()).toEqual(['2026-05-16', '2026-05-16'])
    await rerender('yesterday')
    expect(selectedMode()).toBe('statistics.custom')
    expect(inputValues()).toEqual(['2026-05-15', '2026-05-15'])
    expect(onChange).not.toHaveBeenCalled()
  })

  it.each([
    [new Date(2026, 2, 9, 0, 15), '2026-03-08'],
    [new Date(2026, 10, 1, 23, 45), '2026-10-31'],
  ] as const)(
    'uses the previous calendar date across DST boundaries at %s',
    async (now, yesterday) => {
      vi.setSystemTime(now)
      await render('yesterday')
      expect(inputValues()).toEqual([yesterday, yesterday])
      expect(onChange).not.toHaveBeenCalled()
    },
  )

  it('updates a relative day on the first render after local midnight', async () => {
    await render('today')
    vi.setSystemTime(new Date(2026, 4, 17, 0, 15))
    await rerender('today')
    expect(inputValues()).toEqual(['2026-05-17', '2026-05-17'])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows both local calendar dates from an initial custom deep link', async () => {
    await render('custom:2026-05-10:2026-05-12')
    expect(selectedMode()).toBe('statistics.custom')
    expect(inputValues()).toEqual(['2026-05-10', '2026-05-12'])
    expect(onChange).not.toHaveBeenCalled()
  })

  it('updates displayed dates when an external URL value changes', async () => {
    await render('custom:2026-05-10:2026-05-12')
    await rerender('custom:2026-04-01:2026-04-03')
    expect(inputValues()).toEqual(['2026-04-01', '2026-04-03'])
    expect(selectedMode()).toBe('statistics.custom')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('displays and allows choosing all time instead of disguising it as a week', async () => {
    await render('all')
    expect(selectedMode()).toBe('statistics.all')
    expect(container.querySelector('.ant-picker')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    await rerender('week')
    await selectMode('statistics.all')
    expect(onChange).toHaveBeenCalledExactlyOnceWith('all')
    await rerender('all')
    expect(selectedMode()).toBe('statistics.all')
  })

  it('retains unfinished custom selection without changing the query on a parent rerender', async () => {
    await render('week')
    await selectMode('statistics.custom')
    expect(inputValues()).toEqual(['', ''])
    expect(onChange).not.toHaveBeenCalled()
    await openCalendar()
    await pickDate('2026-05-10')
    expect(onChange).not.toHaveBeenCalled()
    await rerender('week')
    expect(selectedMode()).toBe('statistics.custom')
    expect(inputValues()[0]).toBe('2026-05-10')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('commits a complete local date pair and follows the accepted controlled value', async () => {
    await render('week')
    // Model a controlled parent accepting the committed query in the same event.
    onChange.mockImplementation((value: StatsTimeRange) => root!.render(element(value)))
    await selectMode('statistics.custom')
    await openCalendar()
    await pickDate('2026-05-10')
    await pickDate('2026-05-12')
    expect(onChange).toHaveBeenCalledExactlyOnceWith('custom:2026-05-10:2026-05-12')
    await rerender('custom:2026-05-10:2026-05-12')
    expect(inputValues()).toEqual(['2026-05-10', '2026-05-12'])
  })
})
