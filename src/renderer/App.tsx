import { getApi } from './api'
import { HashRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { Layout, theme, App as AntdApp, Alert, Button, Modal } from 'antd'
import { useState, useEffect, useCallback } from 'react'
import Sidebar from './components/layout/Sidebar'
import TitleBar from './components/layout/TitleBar'
import Dashboard from './pages/Dashboard'
import Keys from './pages/Keys'
import Projects from './pages/Projects'
import Statistics from './pages/Statistics'
import Settings from './pages/Settings'
import { useAntdTokenSync } from './hooks/useAntdTokenSync'
import { setGlobalMessage } from './hooks/useAppMessage'
import { useTranslation } from 'react-i18next'
import AppErrorBoundary from './components/common/AppErrorBoundary'

const { Content } = Layout

function UpdateBanner() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [updateInfo, setUpdateInfo] = useState<{
    available: boolean
    version?: string
    body?: string
  } | null>(null)

  useEffect(() => {
    const lastCheckRef = { time: 0 }

    // Check on startup (delayed)
    const timer = setTimeout(() => {
      lastCheckRef.time = Date.now()
      getApi()
        .app.checkUpdate()
        .then((result) => {
          if (result.available) setUpdateInfo(result)
        })
        .catch(() => {})
    }, 5000)

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const elapsed = Date.now() - lastCheckRef.time
        if (elapsed >= 24 * 60 * 60 * 1000) {
          lastCheckRef.time = Date.now()
          getApi()
            .app.checkUpdate()
            .then((result) => {
              if (result.available) setUpdateInfo(result)
            })
            .catch(() => {})
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  if (!updateInfo) return null

  return (
    <Alert
      message={t('settings.newVersionAvailable')}
      description={t('settings.newVersionDesc', { version: updateInfo.version })}
      type='info'
      showIcon
      closable
      onClose={() => setUpdateInfo(null)}
      action={
        <Button
          size='small'
          type='primary'
          onClick={() => {
            navigate('/settings')
            setUpdateInfo(null)
          }}
        >
          {t('settings.goToDownload')}
        </Button>
      }
      style={{ marginBottom: 16 }}
    />
  )
}

function MigrationModal() {
  const { t } = useTranslation()
  const { message } = AntdApp.useApp()
  const [visible, setVisible] = useState(false)
  const [migrating, setMigrating] = useState(false)

  useEffect(() => {
    let unlisten: (() => void) | null = null
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<boolean>('app:migrationAvailable', () => {
        setVisible(true)
      }).then((fn) => {
        unlisten = fn
      })
    })
    return () => {
      unlisten?.()
    }
  }, [])

  const handleMigrate = useCallback(async () => {
    setMigrating(true)
    try {
      const result = await getApi().importExport.migrateFromElectron()
      if (result.success) {
        message.success(
          t('migration.successDetail', {
            providers: result.providers,
            apiKeys: result.apiKeys,
            projects: result.projects,
          }),
        )
        setVisible(false)
        // Reload to pick up migrated data
        setTimeout(() => window.location.reload(), 500)
      }
    } catch (e) {
      message.error(`${t('migration.failed')}: ${e}`)
    } finally {
      setMigrating(false)
    }
  }, [message, t])

  return (
    <Modal
      title={t('migration.title')}
      open={visible}
      onOk={handleMigrate}
      onCancel={() => setVisible(false)}
      okText={t('migration.confirm')}
      cancelText={t('migration.cancel')}
      confirmLoading={migrating}
      closable={!migrating}
      maskClosable={!migrating}
      focusable={{ focusTriggerAfterClose: false }}
    >
      <p>{t('migration.description')}</p>
    </Modal>
  )
}

function AppContent() {
  const { token } = theme.useToken()
  const { message } = AntdApp.useApp()
  useAntdTokenSync()

  // Initialize global message reference for non-component code
  setGlobalMessage(message)

  return (
    <Layout className='min-h-screen'>
      <Sidebar />
      <Layout style={{ background: token.colorBgLayout }}>
        <TitleBar />
        <Content
          style={{
            padding: 24,
            overflow: 'hidden',
            height: 'calc(100vh - 36px)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <UpdateBanner />
          <MigrationModal />
          <Routes>
            <Route path='/' element={<Dashboard />} />
            <Route path='/keys' element={<Keys />} />
            <Route path='/providers' element={<Keys />} />
            <Route path='/projects' element={<Projects />} />
            <Route path='/statistics' element={<Statistics />} />
            <Route path='/settings' element={<Settings />} />
            <Route path='*' element={<Navigate to='/' replace />} />
          </Routes>
        </Content>
      </Layout>
      {import.meta.env.DEV && (
        <div
          style={{
            position: 'fixed',
            right: 12,
            bottom: 12,
            padding: '2px 8px',
            fontSize: 11,
            fontWeight: 600,
            fontFamily: 'JetBrains Mono, monospace',
            color: '#fff',
            background: token.colorPrimary,
            borderRadius: 4,
            opacity: 0.75,
            zIndex: 9999,
            pointerEvents: 'none',
            userSelect: 'none',
            letterSpacing: 0.5,
          }}
        >
          DEV
        </div>
      )}
    </Layout>
  )
}

export default function App() {
  return (
    <HashRouter>
      <AppErrorBoundary>
        <AppContent />
      </AppErrorBoundary>
    </HashRouter>
  )
}
