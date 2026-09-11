// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { UsageWindow } from '@shared/types'
import ProviderUsageWindows from './ProviderUsageWindows'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { percent?: string }) =>
      options?.percent === undefined ? key : `${key} ${options.percent}`,
  }),
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

/** The order the Go endpoint answered in, read the way the card reads it. */
const window = (id: string, label: string, usedPercent: number | null): UsageWindow => ({
  id,
  label,
  usedPercent,
  resetsAt: null,
  status: null,
})

it('shows the periods shortest first and keeps the percentages the provider sent', async () => {
  await act(async () =>
    root.render(
      <ProviderUsageWindows
        windows={[
          window('monthly', 'Monthly', 0.1),
          window('rolling', '5h', 0.6),
          window('weekly', 'Weekly', 0.3),
        ]}
      />,
    ),
  )

  const text = container.textContent ?? ''
  // 5h → 每周 → 每月, the order the dashboard lists them in.
  expect(text.indexOf('providers.periodRolling')).toBeLessThan(
    text.indexOf('providers.periodWeekly'),
  )
  expect(text.indexOf('providers.periodWeekly')).toBeLessThan(
    text.indexOf('providers.periodMonthly'),
  )
  // 0.6% is not 1%, and 0.3% is not 0%.
  expect(text).toContain('providers.usageWindowUsed 0.6')
  expect(text).toContain('providers.usageWindowUsed 0.3')
  expect(text).toContain('providers.usageWindowUsed 0.1')
})

it('says a missing percentage is missing rather than showing it as zero', async () => {
  await act(async () =>
    root.render(<ProviderUsageWindows windows={[window('rolling', '5h', null)]} />),
  )

  const text = container.textContent ?? ''
  expect(text).toContain('providers.usageWindowUnknown')
  expect(text).not.toContain('providers.usageWindowUsed')
})
