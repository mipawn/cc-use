import { beforeEach, expect, it, vi } from 'vitest'
import type { Provider } from '@shared/types'
const refresh = vi.fn()
const get = vi.fn()
vi.mock('../api', () => ({ getApi: () => ({ balance: { refresh }, provider: { get } }) }))
import { useProviderStore } from './providerStore'

beforeEach(() => {
  vi.resetAllMocks()
  useProviderStore.setState({ providers: [] })
})
it('reloads period-only usage after a successful Go query', async () => {
  const provider = {
    id: 'go',
    cachedUsage: { windows: [{ id: 'weekly', usedPercent: 42 }] },
  } as Provider
  refresh.mockResolvedValue({
    balance: null,
    isValid: true,
    error: null,
    windows: provider.cachedUsage!.windows,
  })
  get.mockResolvedValue(provider)
  await useProviderStore.getState().refreshBalance('go')
  expect(useProviderStore.getState().providers[0].cachedUsage?.windows?.[0].usedPercent).toBe(42)
})
it('keeps the previous cache on an invalid account response', async () => {
  refresh.mockResolvedValue({ balance: null, isValid: false, error: null })
  await useProviderStore.getState().refreshBalance('go')
  expect(get).not.toHaveBeenCalled()
})
