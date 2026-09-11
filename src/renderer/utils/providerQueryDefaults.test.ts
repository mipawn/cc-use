import { expect, it } from 'vitest'
import { ROLLING_WINDOW_ACCOUNT_SCRIPT } from './providerQueryDefaults'

it('maps a rolling window without inventing a reset time or percentage', () => {
  const script = new Function(`return ${ROLLING_WINDOW_ACCOUNT_SCRIPT}`)()
  const data = { five_hour: { used: 30, limit: 120, resets_at: '2026-09-11T15:00:00Z' } }
  expect(script.extractor({ data }).windows).toEqual([
    {
      id: 'rolling_5h',
      label: '5h',
      usedPercent: 25,
      resetsAt: data.five_hour.resets_at,
    },
  ])
  expect(script.extractor({ data: { five_hour: { used: 0, limit: 0 } } }).windows[0]).toMatchObject(
    { usedPercent: null, resetsAt: null },
  )
})
