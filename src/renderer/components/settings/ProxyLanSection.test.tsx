// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProxyLanInfo } from '@shared/types'
import ProxyLanSection, { type ProxyLanSectionProps } from './ProxyLanSection'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
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

const lanInfo: ProxyLanInfo = {
  port: 22345,
  scope: 'lan',
  addresses: [
    { ip: '192.168.1.10', url: 'http://192.168.1.10:22345', interface: 'en0' },
    { ip: '10.0.0.8', url: 'http://10.0.0.8:22345', interface: null },
  ],
}

let root: Root | undefined
let container: HTMLDivElement

async function render(overrides: Partial<ProxyLanSectionProps> = {}) {
  const props: ProxyLanSectionProps = {
    info: null,
    loading: false,
    error: null,
    onRefresh: vi.fn(),
    onCopy: vi.fn(),
    ...overrides,
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<ProxyLanSection {...props} />))
  return { onRefresh: props.onRefresh, onCopy: props.onCopy }
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  document.body.innerHTML = ''
})

it('shows the security warning and each LAN entry with copy buttons', async () => {
  const { onCopy } = await render({ info: lanInfo })

  const text = container.textContent ?? ''
  expect(text).toContain('settings.lanWarningTitle')
  expect(text).toContain('settings.lanWarningDesc')
  expect(text).toContain('settings.lanManagementNote')
  expect(text).toContain('http://192.168.1.10:22345')
  expect(text).toContain('http://10.0.0.8:22345')
  expect(text).toContain('en0')

  const copyButtons = container.querySelectorAll('button[aria-label="settings.copyLanUrl"]')
  expect(copyButtons.length).toBe(2)
  await act(async () => {
    ;(copyButtons[0] as HTMLButtonElement).click()
  })
  expect(onCopy).toHaveBeenCalledWith('http://192.168.1.10:22345')
})

it('explains why no LAN entry exists and that IPv6 is not shown yet', async () => {
  await render({ info: { port: 22345, scope: 'lan', addresses: [] } })

  const text = container.textContent ?? ''
  expect(text).toContain('settings.lanWarningTitle')
  expect(text).toContain('settings.lanEmpty')
  expect(text).toContain('settings.lanIpv6Note')
  expect(container.querySelectorAll('button[aria-label="settings.copyLanUrl"]').length).toBe(0)
})

it('shows a load failure inline with a retry that re-reads the addresses', async () => {
  const { onRefresh } = await render({ error: 'network discovery failed' })

  const text = container.textContent ?? ''
  expect(text).toContain('settings.lanWarningTitle')
  expect(text).toContain('settings.lanLoadFailed')
  expect(text).toContain('network discovery failed')

  const retry = Array.from(container.querySelectorAll('button')).find(
    (button) => (button.textContent ?? '').trim() === 'common.retry',
  )
  expect(retry).toBeDefined()
  await act(async () => {
    retry!.click()
  })
  expect(onRefresh).toHaveBeenCalledTimes(1)
})

it('does not flash an empty reason while the first read is in flight', async () => {
  await render({ loading: true })

  const text = container.textContent ?? ''
  expect(text).toContain('common.loading')
  expect(text).not.toContain('settings.lanEmpty')
})
