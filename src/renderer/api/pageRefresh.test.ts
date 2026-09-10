import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  hasPageRefresh,
  refreshCurrentPage,
  registerPageRefresh,
  type PageRefreshHandler,
} from './pageRefresh'

const unregisters: Array<() => void> = []

function register(handler: PageRefreshHandler) {
  const off = registerPageRefresh(handler)
  unregisters.push(off)
  return off
}

afterEach(() => {
  while (unregisters.length) unregisters.pop()!()
})

describe('page refresh registry', () => {
  it('reports nothing to refresh when no page is mounted', async () => {
    expect(hasPageRefresh()).toBe(false)
    await expect(refreshCurrentPage()).resolves.toBe(false)
  })

  it('runs every mounted data source, not just the last one', async () => {
    const shell = vi.fn()
    const embedded = vi.fn()
    register(shell)
    register(embedded)

    await expect(refreshCurrentPage()).resolves.toBe(true)

    expect(shell).toHaveBeenCalledTimes(1)
    expect(embedded).toHaveBeenCalledTimes(1)
  })

  it('awaits async handlers before resolving', async () => {
    let finished = false
    register(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      finished = true
    })

    await refreshCurrentPage()

    expect(finished).toBe(true)
  })

  it('keeps refreshing the others when one source fails', async () => {
    const failing = vi.fn(() => {
      throw new Error('source unavailable')
    })
    const healthy = vi.fn()
    register(failing)
    register(healthy)

    await expect(refreshCurrentPage()).resolves.toBe(true)

    expect(failing).toHaveBeenCalledTimes(1)
    expect(healthy).toHaveBeenCalledTimes(1)
  })

  it('stops refreshing an unmounted source', async () => {
    const mounted = vi.fn()
    const off = register(mounted)

    off()

    expect(hasPageRefresh()).toBe(false)
    await expect(refreshCurrentPage()).resolves.toBe(false)
    expect(mounted).not.toHaveBeenCalled()
  })
})
