import { SyncOutlined } from '@ant-design/icons'
import { Tooltip, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { useServiceStatus } from '../../hooks/useServiceStatus'

// Clash-like always-on pill that sits in the title bar:
//   [● :22345  ⟳]
// At a glance users see whether the local proxy is running and on
// which port, and can restart it without navigating to Settings.
// The dot turns red when lastError is set so the user isn't left
// wondering why CLI requests stop working.
export default function ServiceStatusPill() {
  const { token } = theme.useToken()
  const { t } = useTranslation()
  const { status, loading, restart } = useServiceStatus()

  const hasError = Boolean(status.lastError) && !status.isRunning
  const dotColor = hasError
    ? token.colorError
    : status.isRunning
      ? token.colorSuccess
      : token.colorTextDisabled
  const bg = status.isRunning ? token.colorSuccessBg : token.colorFillTertiary

  const statusText = hasError
    ? status.lastError || t('dashboard.proxyStopped') || '已停止'
    : status.isRunning
      ? t('dashboard.proxyRunning') || '运行中'
      : t('dashboard.proxyStopped') || '已停止'

  return (
    <div
      data-tauri-drag-region='false'
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        height: 24,
        padding: '0 10px',
        borderRadius: 12,
        background: bg,
        fontSize: 12,
        color: token.colorText,
        lineHeight: 1,
      }}
    >
      <Tooltip title={statusText}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: dotColor,
            display: 'inline-block',
          }}
        />
      </Tooltip>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>:{status.port}</span>
      <Tooltip title={t('settings.proxyRestart')}>
        <button
          type='button'
          onClick={restart}
          disabled={loading}
          data-tauri-drag-region='false'
          style={{
            border: 'none',
            background: 'transparent',
            cursor: loading ? 'default' : 'pointer',
            padding: 2,
            display: 'flex',
            alignItems: 'center',
            color: token.colorTextSecondary,
            opacity: loading ? 0.5 : 1,
          }}
        >
          <SyncOutlined spin={loading} style={{ fontSize: 12 }} />
        </button>
      </Tooltip>
    </div>
  )
}
