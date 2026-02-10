/**
 * Settings - 简化的设置页面
 * 只保留：语言、主题、代理端口、默认终端、代理开关
 */
import { useEffect, useState, useCallback } from 'react'
import {
  Typography,
  Card,
  Select,
  Space,
  theme,
  InputNumber,
  Divider,
  Switch,
  Tag,
  Modal,
  Button,
  Progress,
  message,
} from 'antd'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import { useSettingsStore, ThemeMode } from '../stores/settingsStore'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import {
  GlobalOutlined,
  BgColorsOutlined,
  ApiOutlined,
  CodeOutlined,
  CloudServerOutlined,
  InfoCircleOutlined,
  SyncOutlined,
  MinusCircleOutlined,
  DownloadOutlined,
} from '@ant-design/icons'
import styles from './Settings.module.css'
import type { UpdateCheckResult, UpdateProgressInfo } from '@shared/types'

const { Title, Text } = Typography

export default function Settings() {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const markdownComponents: Components = {
    h1: ({ children }) => (
      <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 8 }}>
        {children}
      </Text>
    ),
    h2: ({ children }) => (
      <Text strong style={{ display: 'block', fontSize: 14, marginBottom: 8 }}>
        {children}
      </Text>
    ),
    h3: ({ children }) => (
      <Text strong style={{ display: 'block', fontSize: 13, marginTop: 8, marginBottom: 6 }}>
        {children}
      </Text>
    ),
    h4: ({ children }) => (
      <Text strong style={{ display: 'block', fontSize: 13, marginTop: 8, marginBottom: 6 }}>
        {children}
      </Text>
    ),
    p: ({ children }) => (
      <Text style={{ display: 'block', marginBottom: 6, lineHeight: 1.6 }}>{children}</Text>
    ),
    ul: ({ children }) => (
      <ul style={{ paddingInlineStart: 18, margin: '4px 0 8px 0' }}>{children}</ul>
    ),
    ol: ({ children }) => (
      <ol style={{ paddingInlineStart: 18, margin: '4px 0 8px 0' }}>{children}</ol>
    ),
    li: ({ children }) => <li style={{ marginBottom: 4, lineHeight: 1.6 }}>{children}</li>,
    strong: ({ children }) => <Text strong>{children}</Text>,
    em: ({ children }) => <Text italic>{children}</Text>,
    code: ({ children }) => <Text code>{children}</Text>,
    pre: ({ children }) => (
      <pre
        style={{
          margin: '8px 0',
          padding: '8px 10px',
          background: token.colorFillTertiary,
          borderRadius: 6,
          overflow: 'auto',
          fontSize: 12,
          lineHeight: 1.6,
        }}
      >
        {children}
      </pre>
    ),
    a: ({ href, children }) => (
      <a
        href={href}
        style={{ color: token.colorLink }}
        onClick={(e) => {
          e.preventDefault()
          if (href) window.api.system.openExternal(href)
        }}
      >
        {children}
      </a>
    ),
  }
  const {
    language,
    themeMode,
    globalSettings,
    setLanguage,
    setThemeMode,
    fetchGlobalSettings,
    updateGlobalSettings,
  } = useSettingsStore()

  // Proxy status
  const [proxyStatus, setProxyStatus] = useState<{ isRunning: boolean; port: number }>({
    isRunning: false,
    port: 12345,
  })
  const [proxyLoading, setProxyLoading] = useState(false)

  // Version & update
  const [appVersion, setAppVersion] = useState('')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null)
  const [updateDownloading, setUpdateDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [downloadSpeed, setDownloadSpeed] = useState(0)
  const [updateDownloaded, setUpdateDownloaded] = useState(false)
  const [platform, setPlatform] = useState<string>('')
  const [cacheSize, setCacheSize] = useState(0)
  const [cacheFiles, setCacheFiles] = useState<string[]>([])
  const [clearingCache, setClearingCache] = useState(false)

  const fetchCacheInfo = async () => {
    const info = await window.api.app.getUpdatesCacheInfo()
    setCacheSize(info.size)
    setCacheFiles(info.files)
  }

  useEffect(() => {
    fetchGlobalSettings()
    fetchProxyStatus()
    fetchCacheInfo()
    window.api.app.getVersion().then(setAppVersion)
    window.api.system.getPlatform().then(setPlatform)

    const unsubscribe = window.api.proxy.onStatusChanged((data) => {
      setProxyStatus({ isRunning: data.isRunning, port: data.port })
      if (data.source === 'tray') {
        if (data.isRunning) {
          message.success(t('projects.proxyStarted'))
        } else {
          message.info(t('projects.proxyStopped'))
        }
      }
    })

    const unsubProgress = window.api.app.onUpdateProgress((info: UpdateProgressInfo) => {
      setDownloadProgress(Math.round(info.percent))
      setDownloadSpeed(info.bytesPerSecond / 1024 / 1024)
    })

    const unsubDownloaded = window.api.app.onUpdateDownloaded(() => {
      setUpdateDownloaded(true)
      setUpdateDownloading(false)
      fetchCacheInfo()
    })

    // Listen for auto update check results
    const unsubUpdateAvailable = window.api.app.onUpdateAvailable((result: UpdateCheckResult) => {
      setUpdateResult(result)
    })

    return () => {
      unsubscribe()
      unsubProgress()
      unsubDownloaded()
      unsubUpdateAvailable()
    }
  }, [fetchGlobalSettings])

  // Fetch proxy status
  const fetchProxyStatus = useCallback(async () => {
    try {
      const status = await window.api.proxy.status()
      setProxyStatus(status)
    } catch (error) {
      console.error('Failed to fetch proxy status:', error)
    }
  }, [])

  // Toggle proxy
  const handleToggleProxy = async (checked: boolean) => {
    if (proxyLoading) return

    // If turning off, show confirmation
    if (!checked) {
      Modal.confirm({
        title: t('settings.proxyStopConfirm') || '确认关闭代理？',
        content: t('settings.proxyStopWarning') || '关闭后，无法记录使用量',
        okText: t('common.confirm') || '确认',
        cancelText: t('common.cancel') || '取消',
        onOk: async () => {
          setProxyLoading(true)
          try {
            await window.api.proxy.stop()
            await fetchProxyStatus()
          } catch (error) {
            console.error('Failed to stop proxy:', error)
          } finally {
            setProxyLoading(false)
          }
        },
      })
      return
    }

    // Turn on proxy
    setProxyLoading(true)
    try {
      await window.api.proxy.start()
      await fetchProxyStatus()
    } catch (error) {
      console.error('Failed to start proxy:', error)
    } finally {
      setProxyLoading(false)
    }
  }

  const languageOptions = [
    { value: 'en', label: 'English' },
    { value: 'zh', label: '中文' },
  ]

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true)
    setUpdateResult(null)
    setUpdateDownloading(false)
    setUpdateDownloaded(false)
    setDownloadProgress(0)
    try {
      const result: UpdateCheckResult = await window.api.app.checkUpdate()
      if (result.hasUpdate) {
        setUpdateResult(result)
      } else {
        message.success(t('settings.latestVersion'))
      }
    } catch {
      message.error(t('settings.checkFailed'))
    } finally {
      setCheckingUpdate(false)
    }
  }

  const handleDownloadUpdate = async () => {
    setUpdateDownloading(true)
    setDownloadProgress(0)
    try {
      await window.api.app.downloadUpdate()
    } catch {
      setUpdateDownloading(false)
      message.error(t('settings.downloadFailed'))
      // Fallback: open browser
      if (updateResult?.releaseUrl) {
        window.api.system.openExternal(updateResult.releaseUrl)
      }
    }
  }

  const handleInstallUpdate = async () => {
    const result = await window.api.app.installUpdate()
    if (result && !result.success) {
      message.error(result.error || t('settings.downloadFailed'))
    } else if (result?.success) {
      message.success(t('settings.installerOpened'))
    }
  }

  const handleClearCache = async () => {
    setClearingCache(true)
    try {
      const count = await window.api.app.clearUpdatesCache()
      message.success(t('settings.cacheCleared', { count }))
      setCacheSize(0)
      setCacheFiles([])
    } finally {
      setClearingCache(false)
    }
  }

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
  }

  const themeOptions = [
    { value: 'system', label: t('settings.themeSystem') },
    { value: 'light', label: t('settings.themeLight') },
    { value: 'dark', label: t('settings.themeDark') },
  ]

  const terminalOptions = [
    { value: 'iterm2', label: 'iTerm2' },
    { value: 'terminal', label: 'Terminal (macOS)' },
    { value: 'wt', label: 'Windows Terminal' },
    { value: 'cmd', label: 'cmd' },
  ]

  return (
    <div className={styles.container}>
      {/* Header - Fixed */}
      <div className={styles.header}>
        <Title level={3} className='!m-0 !mb-1'>
          {t('settings.title')}
        </Title>
        <Text type='secondary'>{t('settings.subtitle')}</Text>
      </div>

      {/* Content - Scrollable */}
      <div className={styles.content}>
        <SimpleBar className={styles.scrollContent} style={{ maxHeight: '100%' }}>
          <div className={styles.settingsSpace}>
            {/* Language */}
            <Card className={styles.settingCard} variant='outlined'>
              <div className={styles.settingRow}>
                <Space>
                  <div className={styles.iconBox} style={{ background: token.colorFillTertiary }}>
                    <GlobalOutlined
                      className={styles.settingIcon}
                      style={{ color: token.colorText }}
                    />
                  </div>
                  <div>
                    <Text strong>{t('settings.language')}</Text>
                    <br />
                    <Text type='secondary' className={styles.settingDesc}>
                      {t('settings.languageDesc')}
                    </Text>
                  </div>
                </Space>
                <Select
                  value={language}
                  onChange={setLanguage}
                  options={languageOptions}
                  style={{ width: 160 }}
                />
              </div>
            </Card>

            {/* Theme */}
            <Card className={styles.settingCard} variant='outlined'>
              <div className={styles.settingRow}>
                <Space>
                  <div className={styles.iconBox} style={{ background: token.colorFillTertiary }}>
                    <BgColorsOutlined
                      className={styles.settingIcon}
                      style={{ color: token.colorText }}
                    />
                  </div>
                  <div>
                    <Text strong>{t('settings.theme')}</Text>
                    <br />
                    <Text type='secondary' className={styles.settingDesc}>
                      {t('settings.themeDesc')}
                    </Text>
                  </div>
                </Space>
                <Select
                  value={themeMode}
                  onChange={(value) => setThemeMode(value as ThemeMode)}
                  options={themeOptions}
                  style={{ width: 160 }}
                />
              </div>
            </Card>

            <Divider className={styles.divider} />

            <Title level={4} className={styles.sectionTitle}>
              {t('settings.globalConfig')}
            </Title>

            {/* Proxy Status */}
            <Card className={styles.settingCard} variant='outlined'>
              <div className={styles.settingRow}>
                <Space>
                  <div className={styles.iconBox} style={{ background: token.colorFillTertiary }}>
                    <CloudServerOutlined
                      className={styles.settingIcon}
                      style={{ color: token.colorText }}
                    />
                  </div>
                  <div>
                    <Space>
                      <Text strong>{t('settings.proxyStatus')}</Text>
                      <Tag color={proxyStatus.isRunning ? 'success' : 'default'}>
                        {proxyStatus.isRunning
                          ? t('dashboard.proxyRunning') || '运行中'
                          : t('dashboard.proxyStopped') || '已停止'}
                      </Tag>
                      {proxyStatus.isRunning && (
                        <Text type='secondary' style={{ fontSize: 12 }}>
                          :{proxyStatus.port}
                        </Text>
                      )}
                    </Space>
                    <br />
                    <Text type='secondary' className={styles.settingDesc}>
                      {t('settings.proxyStatusDesc')}
                    </Text>
                  </div>
                </Space>
                <Switch
                  checked={proxyStatus.isRunning}
                  onChange={handleToggleProxy}
                  loading={proxyLoading}
                />
              </div>
            </Card>

            {/* Close to Tray */}
            <Card className={styles.settingCard} variant='outlined'>
              <div className={styles.settingRow}>
                <Space>
                  <div className={styles.iconBox} style={{ background: token.colorFillTertiary }}>
                    <MinusCircleOutlined
                      className={styles.settingIcon}
                      style={{ color: token.colorText }}
                    />
                  </div>
                  <div>
                    <Text strong>{t('settings.closeToTray')}</Text>
                    <br />
                    <Text type='secondary' className={styles.settingDesc}>
                      {t('settings.closeToTrayDesc')}
                    </Text>
                  </div>
                </Space>
                <Switch
                  checked={globalSettings.closeToTray}
                  onChange={(checked) => updateGlobalSettings({ closeToTray: checked })}
                />
              </div>
            </Card>

            {/* Default Terminal */}
            <Card className={styles.settingCard} variant='outlined'>
              <div className={styles.settingRow}>
                <Space>
                  <div className={styles.iconBox} style={{ background: token.colorFillTertiary }}>
                    <CodeOutlined
                      className={styles.settingIcon}
                      style={{ color: token.colorText }}
                    />
                  </div>
                  <div>
                    <Text strong>{t('settings.defaultTerminal')}</Text>
                    <br />
                    <Text type='secondary' className={styles.settingDesc}>
                      {t('settings.defaultTerminalDesc')}
                    </Text>
                  </div>
                </Space>
                <Select
                  value={globalSettings.defaultTerminalType}
                  onChange={(value) => updateGlobalSettings({ defaultTerminalType: value })}
                  options={terminalOptions}
                  style={{ width: 160 }}
                />
              </div>
            </Card>

            {/* Proxy Port */}
            <Card className={styles.settingCard} variant='outlined'>
              <div className={styles.settingRow}>
                <Space>
                  <div className={styles.iconBox} style={{ background: token.colorFillTertiary }}>
                    <ApiOutlined
                      className={styles.settingIcon}
                      style={{ color: token.colorText }}
                    />
                  </div>
                  <div>
                    <Text strong>{t('settings.proxyPort')}</Text>
                    <br />
                    <Text type='secondary' className={styles.settingDesc}>
                      {t('settings.proxyPortDesc')}
                    </Text>
                  </div>
                </Space>
                <InputNumber
                  value={globalSettings.proxyPort}
                  onChange={(value) => value && updateGlobalSettings({ proxyPort: value })}
                  min={1024}
                  max={65535}
                  style={{ width: 160 }}
                />
              </div>
            </Card>

            <Divider className={styles.divider} />

            <Title level={4} className={styles.sectionTitle}>
              {t('settings.about')}
            </Title>

            {/* About / Version */}
            <Card className={styles.settingCard} variant='outlined'>
              <div className={styles.settingRow}>
                <Space>
                  <div className={styles.iconBox} style={{ background: token.colorFillTertiary }}>
                    <InfoCircleOutlined
                      className={styles.settingIcon}
                      style={{ color: token.colorText }}
                    />
                  </div>
                  <div>
                    <Text strong>CC Use {appVersion ? `v${appVersion}` : ''}</Text>
                    <br />
                    <Text type='secondary' className={styles.settingDesc}>
                      {t('settings.version')}: {appVersion || '-'}
                    </Text>
                  </div>
                </Space>
                <Button
                  icon={<SyncOutlined spin={checkingUpdate} />}
                  loading={checkingUpdate}
                  onClick={handleCheckUpdate}
                >
                  {checkingUpdate ? t('settings.checking') : t('settings.checkUpdate')}
                </Button>
              </div>

              {/* Update available */}
              {updateResult && (
                <div
                  style={{
                    marginTop: 16,
                    padding: '12px 16px',
                    background: token.colorFillTertiary,
                    borderRadius: 8,
                  }}
                >
                  <Text strong style={{ fontSize: 14 }}>
                    {t('settings.newVersionDesc', { version: updateResult.latestVersion })}
                  </Text>

                  {updateResult.releaseNotes && (
                    <div
                      style={{
                        maxHeight: 150,
                        overflow: 'auto',
                        padding: '8px 12px',
                        marginTop: 8,
                        background: token.colorBgContainer,
                        borderRadius: 6,
                        fontSize: 13,
                      }}
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                        {updateResult.releaseNotes}
                      </ReactMarkdown>
                    </div>
                  )}

                  {/* Download progress */}
                  {updateDownloading && (
                    <div style={{ marginTop: 12 }}>
                      <Progress percent={downloadProgress} size='small' status='active' />
                      <Text type='secondary' style={{ fontSize: 12 }}>
                        {t('settings.downloadSpeed', { speed: downloadSpeed.toFixed(1) })}
                      </Text>
                    </div>
                  )}

                  {/* Action buttons */}
                  <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                    {!updateDownloading && !updateDownloaded && (
                      <>
                        <Button
                          type='primary'
                          icon={<DownloadOutlined />}
                          onClick={handleDownloadUpdate}
                        >
                          {t('settings.downloadUpdate')}
                        </Button>
                        <Button
                          onClick={() => window.api.system.openExternal(updateResult.releaseUrl)}
                        >
                          {t('settings.goToDownload')}
                        </Button>
                      </>
                    )}

                    {updateDownloaded && (
                      <Button type='primary' onClick={handleInstallUpdate}>
                        {platform === 'win32'
                          ? t('settings.installAndRestart')
                          : t('settings.openInstaller')}
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {/* Update cache info */}
              {cacheFiles.length > 0 && (
                <div
                  style={{
                    marginTop: 16,
                    paddingTop: 16,
                    borderTop: `1px solid ${token.colorBorderSecondary}`,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <Text type='secondary'>{t('settings.updateCache')}</Text>
                      <Text style={{ marginLeft: 8 }}>
                        {cacheFiles.length} {t('settings.cacheFileCount')} ({formatBytes(cacheSize)}
                        )
                      </Text>
                    </div>
                    <Button size='small' loading={clearingCache} onClick={handleClearCache}>
                      {t('settings.clearCache')}
                    </Button>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    {cacheFiles.map((file) => (
                      <Tag key={file} style={{ marginBottom: 4 }}>
                        {file}
                      </Tag>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          </div>
        </SimpleBar>
      </div>
    </div>
  )
}
