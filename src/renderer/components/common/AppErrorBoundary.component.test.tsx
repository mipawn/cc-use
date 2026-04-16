// @vitest-environment jsdom
import React, { act } from 'react'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { App as AntdApp, ConfigProvider } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import { createRoot } from 'react-dom/client'
import AppErrorBoundary from './AppErrorBoundary'

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true

function renderComponent(ui: React.ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)

  const root = createRoot(container)

  act(() => {
    root.render(
      <StyleProvider layer>
        <ConfigProvider>
          <AntdApp>{ui}</AntdApp>
        </ConfigProvider>
      </StyleProvider>,
    )
  })

  return {
    container,
    unmount() {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

function ThrowRenderError(): never {
  throw new Error('boom from component test')
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

afterAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

describe('AppErrorBoundary component', () => {
  it('renders child content when no error is thrown', () => {
    const view = renderComponent(
      <AppErrorBoundary>
        <div>component test ready</div>
      </AppErrorBoundary>,
    )

    expect(view.container.textContent).toContain('component test ready')

    view.unmount()
  })

  it('renders the fallback result when a child render throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const view = renderComponent(
      <AppErrorBoundary>
        <ThrowRenderError />
      </AppErrorBoundary>,
    )

    expect(view.container.textContent).toContain('页面渲染异常')
    expect(view.container.textContent).toContain('boom from component test')
    expect(view.container.querySelector('button')).not.toBeNull()
    expect(consoleError).toHaveBeenCalled()

    view.unmount()
  })
})
