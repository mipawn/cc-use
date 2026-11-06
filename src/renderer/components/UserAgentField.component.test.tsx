// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
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
async function render(
  value = '',
  failLoad = false,
  saved: string[] = [],
  extra: Partial<ComponentProps<typeof UserAgentField>> = {},
) {
  if (failLoad) api.list.mockRejectedValue(new Error('load failed'))
  else api.list.mockResolvedValue(saved)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  function Harness() {
    const [current, setCurrent] = useState(value)
    return (
      <UserAgentField
        value={current}
        placeholder='Keep client UA'
        onChange={setCurrent}
        {...extra}
      />
    )
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

it('leaves id and status alone when the optional props are absent', async () => {
  await render('claude-cli/2.1.161 (external, cli)', false, ['custom-agent/1.0'])
  const input = container.querySelector<HTMLInputElement>('input[aria-label="User-Agent"]')!
  expect(input.hasAttribute('id')).toBe(false)
  expect(input.className).not.toContain('ant-input-status-error')
})

it('passes inputId to the inner input so an external label can target it', async () => {
  const label = document.createElement('label')
  label.htmlFor = 'gateway-user-agent'
  await render('', false, [], { inputId: 'gateway-user-agent' })
  const input = container.querySelector<HTMLInputElement>('#gateway-user-agent')!
  expect(input).not.toBeNull()
  expect(input.id).toBe('gateway-user-agent')
  expect(label.htmlFor).toBe(input.id)
})

it('shows the error status only when invalid is set', async () => {
  await render('line\nbreak', false, [], { invalid: true })
  const input = container.querySelector<HTMLInputElement>('input[aria-label="User-Agent"]')!
  // antd marks the affix wrapper, not the bare input.
  const wrapper = input.closest('.ant-input-affix-wrapper')!
  expect(wrapper.className).toContain('ant-input-status-error')
  await render('plain-value')
  const plain = container.querySelector<HTMLInputElement>('input[aria-label="User-Agent"]')!
  expect(plain.closest('.ant-input-affix-wrapper')!.className).not.toContain(
    'ant-input-status-error',
  )
})

it('offers no library writing or deleting when libraryActions is off', async () => {
  // The gateway entry reads the shared library; it must not mutate it.
  await render('custom-agent/1.0', false, ['custom-agent/1.0'], { libraryActions: false })

  // The antd Select is a combobox, not a <button>; the input's clear icon is
  // not an ant-btn. With the library controls off, no ant-btn remains.
  expect([...container.querySelectorAll('button.ant-btn')]).toEqual([])
  // Typing still works; the value only travels through onChange.
  const input = container.querySelector<HTMLInputElement>('input[aria-label="User-Agent"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'gateway-agent/9.9',
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(api.save).not.toHaveBeenCalled()
  expect(api.delete).not.toHaveBeenCalled()
  expect(container.querySelector('[role="combobox"]')).not.toBeNull()
})
