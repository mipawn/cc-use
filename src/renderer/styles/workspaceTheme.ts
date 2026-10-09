import { theme, type ThemeConfig } from 'antd'

// Ant Design derives the accent scale; large surfaces stay neutral and bright.
export function createWorkspaceTheme(isDark: boolean, reducedMotion = false): ThemeConfig {
  return {
    algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      motion: !reducedMotion,
      colorPrimary: '#1677ff',
      colorBgBase: isDark ? '#14181f' : '#ffffff',
      colorBgContainer: isDark ? '#1d232d' : '#ffffff',
      colorBgElevated: isDark ? '#242d38' : '#ffffff',
      colorBgLayout: isDark ? '#14181f' : '#f5f7fa',
      colorBorder: isDark ? '#364353' : '#e2e8f0',
      colorBorderSecondary: isDark ? '#2c3643' : '#edf0f5',
      borderRadius: 8,
      borderRadiusLG: 12,
      fontSize: 14,
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
      fontSizeHeading2: 26,
      fontSizeHeading3: 22,
      fontSizeHeading4: 17,
      controlHeight: 36,
      boxShadow: isDark ? '0 8px 32px rgba(0, 0, 0, 0.25)' : '0 8px 32px rgba(35, 55, 80, 0.07)',
    },
    components: {
      Layout: { bodyBg: isDark ? '#14181f' : '#f5f7fa' },
      Button: { primaryShadow: 'none', defaultShadow: 'none', fontWeight: 500 },
      Card: { headerFontSize: 14, headerHeight: 48, paddingLG: 20 },
      Tabs: { horizontalItemGutter: 24, titleFontSize: 14 },
      Table: {
        headerBg: isDark ? '#26303d' : '#f8fafc',
        headerSplitColor: 'transparent',
        cellPaddingBlock: 13,
        cellPaddingInline: 16,
      },
      Modal: { titleFontSize: 17 },
      Segmented: { trackBg: isDark ? '#14181f' : '#f5f7fa' },
    },
  }
}
