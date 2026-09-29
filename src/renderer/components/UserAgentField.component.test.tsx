// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import UserAgentField from './UserAgentField'

const api = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), delete: vi.fn() }))
vi.mock('../api', () => ({ getApi: () => ({ userAgent: api }) }))
vi.mock('../hooks/useAppMessage', () => ({ useAppMessage: () => ({ success: vi.fn() }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
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
let root: Root
let container: HTMLDivElement
async function render(value = '', failLoad = false, saved: string[] = []) {
  if (failLoad) api.list.mockRejectedValue(new Error('load failed'))
  else api.list.mockResolvedValue(saved)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  function Harness() {
    const [current, setCurrent] = useState(value)
    return <UserAgentField value={current} placeholder='Keep client UA' onChange={setCurrent} />
  }
  await act(async () => root.render(<Harness />))
}
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  document.body.innerHTML = ''
  vi.resetAllMocks()
})

it('lets a blank UA be edited directly and saves only on explicit click', async () => {
  await render()
  const input = container.querySelector<HTMLInputElement>('input[aria-label="User-Agent"]')!
  expect(input).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'custom-agent/1.0',
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(api.save).not.toHaveBeenCalled()
  api.save.mockResolvedValue(['custom-agent/1.0'])
  const button = container.querySelector<HTMLButtonElement>('button.ant-btn')!
  await act(async () => button.click())
  expect(api.save).toHaveBeenCalledWith('custom-agent/1.0')
  expect(button.disabled).toBe(true)
})

it('keeps built-in presets available when local loading fails', async () => {
  await render('claude-cli/2.1.161 (external, cli)', true)
  expect(container.querySelector<HTMLButtonElement>('button.ant-btn')!.disabled).toBe(true)
  const combobox = container.querySelector('[role="combobox"]')!
  await act(async () => combobox.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  expect(document.body.textContent).toContain('claude-cli/2.1.161 (external, cli)')
  expect(document.body.textContent).toContain('keys.uaBuiltin')
})

it('shows persistence errors without losing the entered value', async () => {
  await render('custom-agent/2.0')
  api.save.mockRejectedValue(new Error('database unavailable'))
  await act(async () => container.querySelector<HTMLButtonElement>('button.ant-btn')!.click())
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('database unavailable')
  expect(container.querySelector<HTMLInputElement>('input[aria-label="User-Agent"]')!.value).toBe(
    'custom-agent/2.0',
  )
})

it('removes a saved UA without clearing the current configuration', async () => {
  await render('custom-agent/1.0', false, ['custom-agent/1.0'])
  api.delete.mockResolvedValue([])
  const remove = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'keys.uaDelete',
  )!
  await act(async () => remove.click())
  expect(api.delete).toHaveBeenCalledWith('custom-agent/1.0')
  expect(container.textContent).not.toContain('keys.uaDelete')
  expect(container.querySelector<HTMLInputElement>('input[aria-label="User-Agent"]')!.value).toBe(
    'custom-agent/1.0',
  )
  expect(container.querySelector<HTMLButtonElement>('button.ant-btn')!.disabled).toBe(false)
})

it('retains the saved value and reports an error if deletion fails', async () => {
  await render('custom-agent/1.0', false, ['custom-agent/1.0'])
  api.delete.mockRejectedValue(new Error('delete failed'))
  const remove = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'keys.uaDelete',
  )!
  await act(async () => remove.click())
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('delete failed')
  expect(container.textContent).toContain('keys.uaDelete')
})
