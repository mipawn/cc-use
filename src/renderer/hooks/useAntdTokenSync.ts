import { useEffect } from 'react'
import { theme } from 'antd'
import { useSettingsStore } from '../stores/settingsStore'

export function useAntdTokenSync() {
  const { token } = theme.useToken()
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme)
  }, [resolvedTheme])

  useEffect(() => {
    const root = document.documentElement

    root.style.setProperty('--ant-color-primary', token.colorPrimary)
    root.style.setProperty('--ant-color-primary-bg', token.colorPrimaryBg)
    root.style.setProperty('--ant-color-primary-border', token.colorPrimaryBorder)
    root.style.setProperty('--ant-color-success', token.colorSuccess)
    root.style.setProperty('--ant-color-success-bg', token.colorSuccessBg)
    root.style.setProperty('--ant-color-success-border', token.colorSuccessBorder)
    root.style.setProperty('--ant-color-error', token.colorError)
    root.style.setProperty('--ant-color-error-bg', token.colorErrorBg)
    root.style.setProperty('--ant-color-warning', token.colorWarning)
    root.style.setProperty('--ant-color-warning-bg', token.colorWarningBg)
    root.style.setProperty('--ant-color-text', token.colorText)
    root.style.setProperty('--ant-color-text-secondary', token.colorTextSecondary)
    root.style.setProperty('--ant-color-text-tertiary', token.colorTextTertiary)
    root.style.setProperty('--ant-color-text-quaternary', token.colorTextQuaternary)
    root.style.setProperty('--ant-color-bg-container', token.colorBgContainer)
    root.style.setProperty('--ant-color-bg-layout', token.colorBgLayout)
    root.style.setProperty('--ant-color-bg-text-hover', token.colorBgTextHover)
    root.style.setProperty('--ant-color-border', token.colorBorder)
    root.style.setProperty('--ant-color-border-secondary', token.colorBorderSecondary)
    root.style.setProperty('--ant-color-fill-secondary', token.colorFillSecondary)
    root.style.setProperty('--ant-color-fill-tertiary', token.colorFillTertiary)
    root.style.setProperty('--ant-border-radius', `${token.borderRadius}px`)
    root.style.setProperty('--ant-border-radius-lg', `${token.borderRadiusLG}px`)
  }, [token])
}
