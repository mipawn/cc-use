import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, App as AntdApp } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import App from './App'
import { useSettingsStore } from './stores/settingsStore'
import { installRendererConsoleTap } from './api/consoleBus'
import { installConsoleStore } from './api/consoleStore'
import './locales'
import './styles/global.css'
import { createWorkspaceTheme } from './styles/workspaceTheme'
import { useReducedMotion } from './hooks/useReducedMotion'

// Install the console tap as early as possible so every `console.*` call
// from React / stores / app bootstrap is already funneled into the Console
// page's event stream by the time the user opens it.
installRendererConsoleTap()
// Process-long buffer: events start accumulating immediately, survive
// navigation away from the Console page, and only reset on full app reload.
installConsoleStore()

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

const container = document.getElementById('root')!
const root =
  (container as any).__root ?? ((container as any).__root = ReactDOM.createRoot(container))

root.render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
