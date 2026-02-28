import { useEffect, useState } from 'react'
import { theme } from 'antd'
import { MinusOutlined, BorderOutlined, CloseOutlined } from '@ant-design/icons'

export default function TitleBar() {
  const [platform, setPlatform] = useState<string>('')
  const { token } = theme.useToken()

  useEffect(() => {
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<string>('system_get_platform').then(setPlatform)
    })
  }, [])

  const handleMinimize = async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    getCurrentWindow().minimize()
  }

  const handleMaximize = async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    getCurrentWindow().toggleMaximize()
  }

  const handleClose = async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    getCurrentWindow().close()
  }

  if (!platform) return <div style={{ height: 36 }} />

  const isWindows = platform === 'windows' || platform === 'win32'

  return (
    <div
      data-tauri-drag-region
      style={{
        height: 36,
        display: 'flex',
        alignItems: 'center',
        justifyContent: isWindows ? 'flex-end' : 'center',
        position: 'relative',
        flexShrink: 0,
        // macOS: leave space for traffic lights
        paddingLeft: isWindows ? 0 : 80,
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      {isWindows && (
        <div style={{ display: 'flex', height: '100%' }}>
          <button
            onClick={handleMinimize}
            style={{
              width: 46,
              height: '100%',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: token.colorText,
              fontSize: 12,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = token.colorFillSecondary
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <MinusOutlined />
          </button>
          <button
            onClick={handleMaximize}
            style={{
              width: 46,
              height: '100%',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: token.colorText,
              fontSize: 12,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = token.colorFillSecondary
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <BorderOutlined />
          </button>
          <button
            onClick={handleClose}
            style={{
              width: 46,
              height: '100%',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: token.colorText,
              fontSize: 12,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#e81123'
              e.currentTarget.style.color = '#fff'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.color = token.colorText
            }}
          >
            <CloseOutlined />
          </button>
        </div>
      )}
    </div>
  )
}
