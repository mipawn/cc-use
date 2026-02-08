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
  message,
} from 'antd'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import { useSettingsStore, ThemeMode } from '../stores/settingsStore'
import {
  GlobalOutlined,
  BgColorsOutlined,
  ApiOutlined,
  CodeOutlined,
  CloudServerOutlined,
  InfoCircleOutlined,
  SyncOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons'
import styles from './Settings.module.css'
import type { UpdateCheckResult } from '@shared/types'

const { Title, Text } = Typography

export default function Settings() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
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

  useEffect(() => {
    fetchGlobalSettings()
    fetchProxyStatus()
    window.api.app.getVersion().then(setAppVersion)

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
    return () => { unsubscribe() }
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
    try {
      const result: UpdateCheckResult = await window.api.app.checkUpdate()
      if (result.hasUpdate) {
        Modal.confirm({
          title: t('settings.newVersionAvailable'),
          content: (
            <div>
              <p>{t('settings.newVersionDesc', { version: result.latestVersion })}</p>
              {result.releaseNotes && (
                <div>
                  <p style={{ fontWeight: 500, marginBottom: 4 }}>{t('settings.releaseNotes')}:</p>
                  <div
                    style={{
                      maxHeight: 200,
                      overflow: 'auto',
                      padding: '8px 12px',
                      background: token.colorFillTertiary,
                      borderRadius: 6,
                      fontSize: 13,
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {result.releaseNotes}
                  </div>
                </div>
              )}
            </div>
          ),
          okText: t('settings.goToDownload'),
          cancelText: t('common.cancel'),
          onOk: () => {
            window.api.system.openExternal(result.releaseUrl)
          },
        })
      } else {
        message.success(t('settings.latestVersion'))
      }
    } catch {
      message.error(t('settings.checkFailed'))
    } finally {
      setCheckingUpdate(false)
    }
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
        <Title level={3} className="!m-0 !mb-1">
          {t('settings.title')}
        </Title>
        <Text type="secondary">{t('settings.subtitle')}</Text>
      </div>

      {/* Content - Scrollable */}
      <div className={styles.content}>
        <SimpleBar className={styles.scrollContent} style={{ maxHeight: '100%' }}>
          <div className={styles.settingsSpace}>
            {/* Language */}
            <Card className={styles.settingCard} variant="outlined">
              <div className={styles.settingRow}>
                <Space>
                  <div
                    className={styles.iconBox}
                    style={{ background: token.colorFillTertiary }}
                  >
                    <GlobalOutlined
                      className={styles.settingIcon}
                      style={{ color: token.colorText }}
                    />
                  </div>
                  <div>
                    <Text strong>{t('settings.language')}</Text>
                    <br />
                    <Text type="secondary" className={styles.settingDesc}>
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
            <Card className={styles.settingCard} variant="outlined">
              <div className={styles.settingRow}>
                <Space>
                  <div
                    className={styles.iconBox}
                    style={{ background: token.colorFillTertiary }}
                  >
                    <BgColorsOutlined
                      className={styles.settingIcon}
                      style={{ color: token.colorText }}
                    />
                  </div>
                  <div>
                    <Text strong>{t('settings.theme')}</Text>
                    <br />
                    <Text type="secondary" className={styles.settingDesc}>
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
            <Card className={styles.settingCard} variant="outlined">
              <div className={styles.settingRow}>
                <Space>
                  <div
                    className={styles.iconBox}
                    style={{ background: token.colorFillTertiary }}
                  >
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
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          :{proxyStatus.port}
                        </Text>
                      )}
                    </Space>
                    <br />
                    <Text type="secondary" className={styles.settingDesc}>
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
            <Card className={styles.settingCard} variant="outlined">
              <div className={styles.settingRow}>
                <Space>
                  <div
                    className={styles.iconBox}
                    style={{ background: token.colorFillTertiary }}
                  >
                    <MinusCircleOutlined
                      className={styles.settingIcon}
                      style={{ color: token.colorText }}
                    />
                  </div>
                  <div>
                    <Text strong>{t('settings.closeToTray')}</Text>
                    <br />
                    <Text type="secondary" className={styles.settingDesc}>
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
            <Card className={styles.settingCard} variant="outlined">
              <div className={styles.settingRow}>
                <Space>
                  <div
                    className={styles.iconBox}
                    style={{ background: token.colorFillTertiary }}
                  >
                    <CodeOutlined
                      className={styles.settingIcon}
                      style={{ color: token.colorText }}
                    />
                  </div>
                  <div>
                    <Text strong>{t('settings.defaultTerminal')}</Text>
                    <br />
                    <Text type="secondary" className={styles.settingDesc}>
                      {t('settings.defaultTerminalDesc')}
                    </Text>
                  </div>
                </Space>
                <Select
                  value={globalSettings.defaultTerminalType}
                  onChange={(value) =>
                    updateGlobalSettings({ defaultTerminalType: value })
                  }
                  options={terminalOptions}
                  style={{ width: 160 }}
                />
              </div>
            </Card>

            {/* Proxy Port */}
            <Card className={styles.settingCard} variant="outlined">
              <div className={styles.settingRow}>
                <Space>
                  <div
                    className={styles.iconBox}
                    style={{ background: token.colorFillTertiary }}
                  >
                    <ApiOutlined
                      className={styles.settingIcon}
                      style={{ color: token.colorText }}
                    />
                  </div>
                  <div>
                    <Text strong>{t('settings.proxyPort')}</Text>
                    <br />
                    <Text type="secondary" className={styles.settingDesc}>
                      {t('settings.proxyPortDesc')}
                    </Text>
                  </div>
                </Space>
                <InputNumber
                  value={globalSettings.proxyPort}
                  onChange={(value) =>
                    value && updateGlobalSettings({ proxyPort: value })
                  }
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
            <Card className={styles.settingCard} variant="outlined">
              <div className={styles.settingRow}>
                <Space>
                  <div
                    className={styles.iconBox}
                    style={{ background: token.colorFillTertiary }}
                  >
                    <InfoCircleOutlined
                      className={styles.settingIcon}
                      style={{ color: token.colorText }}
                    />
                  </div>
                  <div>
                    <Text strong>CC Use {appVersion ? `v${appVersion}` : ''}</Text>
                    <br />
                    <Text type="secondary" className={styles.settingDesc}>
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
            </Card>
          </div>
        </SimpleBar>
      </div>
    </div>
  )
}
