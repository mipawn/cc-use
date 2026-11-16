import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { isFixtureMode } from './dev/mode'

async function bootstrap() {
  // Dynamic boundary is intentional: not even store/module evaluation may call
  // the real API before fixture injection. Production never imports fixture data.
  if (isFixtureMode) {
    const { installFixturePreview } = await import('./dev/bootstrap')
    installFixturePreview()
  }

  const { installRendererConsoleTap } = await import('./api/consoleBus')
  installRendererConsoleTap()
  // Renderer persistence is a native integration, not part of browser fixtures.
  // Keep the normal console store and its getApi()-backed event/history paths.
  if (!isFixtureMode) {
    const { installRendererLogBridge } = await import('./api/consoleLogBridge')
    installRendererLogBridge()
  }
  const { installConsoleStore } = await import('./api/consoleStore')
  installConsoleStore()

  const [
    { ConfigProvider, App: AntdApp },
    { StyleProvider },
    { default: zhCN },
    { default: enUS },
    { default: dayjs },
    { default: App },
    { useSettingsStore },
    { createWorkspaceTheme },
    { useReducedMotion },
  ] = await Promise.all([
    import('antd'),
    import('@ant-design/cssinjs'),
    import('antd/locale/zh_CN'),
    import('antd/locale/en_US'),
    import('dayjs'),
    import('./App'),
    import('./stores/settingsStore'),
    import('./styles/workspaceTheme'),
    import('./hooks/useReducedMotion'),
    import('dayjs/locale/zh-cn'),
    import('./locales'),
    import('./styles/global.css'),
  ])

  function Root() {
    const reducedMotion = useReducedMotion()
    const { language, resolvedTheme, initSettings } = useSettingsStore()
    const isChinese = language.toLowerCase().startsWith('zh')

    useEffect(() => {
      initSettings()
    }, [initSettings])
    useEffect(() => {
      dayjs.locale(isChinese ? 'zh-cn' : 'en')
    }, [isChinese])

    return (
      <StyleProvider layer>
        <ConfigProvider
          locale={isChinese ? zhCN : enUS}
          theme={createWorkspaceTheme(resolvedTheme === 'dark', reducedMotion)}
        >
          <AntdApp message={{ maxCount: 3, top: 60 }}>
            <App />
          </AntdApp>
        </ConfigProvider>
      </StyleProvider>
    )
  }

  const container = document.getElementById('root')! as HTMLElement & {
    __root?: ReturnType<typeof ReactDOM.createRoot>
  }
  const root = container.__root ?? (container.__root = ReactDOM.createRoot(container))
  root.render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  )
}

void bootstrap().catch((error: unknown) => {
  console.error('Renderer bootstrap failed:', error)
  const container = document.getElementById('root')
  if (container) {
    container.setAttribute('role', 'alert')
    container.textContent = `Bootstrap failed: ${String(error)}`
  }
})
