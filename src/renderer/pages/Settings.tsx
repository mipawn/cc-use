import { getApi } from '../api'
/**
 * Settings - 简化的设置页面
 * 只保留：语言、主题、代理端口、默认终端、代理状态（只读+重启）
 */
import { useEffect, useState } from 'react'
import {
  Typography,
  Card,
  Select,
  Space,
  theme,
  InputNumber,
  Input,
  Divider,
  Switch,
  Tag,
  Modal,
  Button,
  Progress,
  message,
  Checkbox,
} from 'antd'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import { useSettingsStore, ThemeMode } from '../stores/settingsStore'
import { useServiceStatus } from '../hooks/useServiceStatus'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import {
  GlobalOutlined,
  BgColorsOutlined,
  CodeOutlined,
  CloudServerOutlined,
  InfoCircleOutlined,
  SyncOutlined,
  MinusCircleOutlined,
  DownloadOutlined,
  UploadOutlined,
  PoweroffOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import styles from './Settings.module.css'

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
          if (href) getApi().system.openExternal(href)
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

  // Service status (shared hook)
  const { status: proxyStatus, loading: proxyLoading, restart: restartService } = useServiceStatus()

  // Version & update
  const [appVersion, setAppVersion] = useState('')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateResult, setUpdateResult] = useState<{
    available: boolean
    version?: string
    body?: string
  } | null>(null)
  const [updateDownloading, setUpdateDownloading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [updateInstalled, setUpdateInstalled] = useState(false)

  // Import/Export
  const [exportingData, setExportingData] = useState(false)
  const [importingData, setImportingData] = useState(false)
  const [overwriteOnImport, setOverwriteOnImport] = useState(true)
  const [exportSelections, setExportSelections] = useState<string[]>([
    'providers',
    'usageLogs',
    'requestLogs',
  ])
  const [backupModalOpen, setBackupModalOpen] = useState(false)

  // System integration: launch-at-login + global shortcut
  const [launchAtLogin, setLaunchAtLogin] = useState(false)
  const [launchAtLoginLoading, setLaunchAtLoginLoading] = useState(false)
  const [shortcutCombo, setShortcutCombo] = useState('')
  const [recording, setRecording] = useState(false)

  useEffect(() => {
    fetchGlobalSettings()
    getApi().app.getVersion().then(setAppVersion)
    // Load launch-at-login + show-window-shortcut state in parallel with the
    // other settings so the toggles are populated by the time the page renders.
    Promise.all([
      getApi().systemExt.autoLaunchIsEnabled().catch(() => false),
      getApi().systemExt.showWindowGetShortcut().catch(() => ''),
    ]).then(([enabled, combo]) => {
      setLaunchAtLogin(enabled)
      setShortcutCombo(combo || '')
    })
  }, [fetchGlobalSettings])

  const handleToggleLaunchAtLogin = async (checked: boolean) => {
    setLaunchAtLoginLoading(true)
    try {
      await getApi().systemExt.autoLaunchSetEnabled(checked)
      setLaunchAtLogin(checked)
    } catch {
      message.error(t('settings.launchAtLoginToggleFailed'))
      // Revert optimistic state on failure so the switch reflects reality.
      setLaunchAtLogin(!checked)
    } finally {
      setLaunchAtLoginLoading(false)
    }
  }

  // Normalize a DOM KeyboardEvent into the Tauri/accelerator combo string the
  // global-shortcut plugin expects, e.g. "Alt+Space", "CommandOrControl+Shift+P".
  // Returns null when the key press isn't a valid binding (no modifier, or a
  // bare modifier press).
  const formatCombo = (e: KeyboardEvent): string | null => {
    const mods: string[] = []
    if (e.metaKey) mods.push('Super')
    if (e.ctrlKey) mods.push('Control')
    if (e.altKey) mods.push('Alt')
    if (e.shiftKey) mods.push('Shift')
    if (mods.length === 0) return null

    // Ignore lone modifier presses — require a real key.
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return null

    let keyName = e.key
    if (keyName === ' ') keyName = 'Space'
    else if (keyName.length === 1) keyName = keyName.toUpperCase()
    // Normalize macOS Cmd to the cross-platform alias so combos work on Win/Linux too.
    const normalizedMods = mods.map((m) => (m === 'Super' ? 'CommandOrControl' : m))
    // Deduplicate CommandOrControl if both Super+Control were somehow held.
    const uniqueMods = Array.from(new Set(normalizedMods))
    return [...uniqueMods, keyName].join('+')
  }

  const startRecording = () => {
    setRecording(true)
    // The capture happens via a window keydown listener installed below while
    // `recording` is true. ESC aborts without changing anything.
  }

  const commitCombo = async (combo: string) => {
    try {
      await getApi().systemExt.showWindowSetShortcut(combo)
      setShortcutCombo(combo)
    } catch {
      message.error(t('settings.shortcutUpdateFailed'))
    } finally {
      setRecording(false)
    }
  }

  // While recording, intercept every keypress at the window level so we can
  // capture combos the OS would otherwise swallow (e.g. Space).
  useEffect(() => {
    if (!recording) return
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        return
      }
      const combo = formatCombo(e)
      if (combo) {
        void commitCombo(combo)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording])

  const languageOptions = [
    { value: 'en', label: 'English' },
    { value: 'zh', label: '中文' },
  ]

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true)
    setUpdateResult(null)
    setUpdateDownloading(false)
    setUpdateInstalled(false)
    setDownloadProgress(0)
    try {
      const result = await getApi().app.checkUpdate()
      if (result.available) {
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

  const handleDownloadAndInstall = async () => {
    setUpdateDownloading(true)
    setDownloadProgress(0)
    try {
      await getApi().app.downloadAndInstall((progress) => {
        if (progress.total > 0) {
          setDownloadProgress(Math.round((progress.downloaded / progress.total) * 100))
        }
      })
      setUpdateDownloading(false)
      setUpdateInstalled(true)
    } catch {
      setUpdateDownloading(false)
      message.error(t('settings.downloadFailed'))
    }
  }

  const handleRelaunch = async () => {
    await getApi().app.relaunch()
  }

  const handleExportData = async () => {
    if (exportingData) return
    if (exportSelections.length === 0) {
      message.warning(t('settings.exportSelectAtLeastOne') || '请至少选择一项导出内容')
      return
    }

    setExportingData(true)
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const today = new Date().toISOString().slice(0, 10)
      const path = (await save({
        defaultPath: `cc-use-backup-${today}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })) as string | null
      if (!path) return

      await getApi().importExport.exportToFile(path, {
        includeProviders: exportSelections.includes('providers'),
        includeUsageLogs: exportSelections.includes('usageLogs'),
        includeRequestLogs: exportSelections.includes('requestLogs'),
      })
      message.success(t('settings.exportSuccess') || '导出成功')
      setBackupModalOpen(false)
    } catch (e) {
      console.error('Export failed:', e)
      message.error(t('settings.exportFailed') || '导出失败')
    } finally {
      setExportingData(false)
    }
  }

  const handleImportData = async () => {
    if (importingData) return
    setImportingData(true)
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      const path = (Array.isArray(selected) ? selected[0] : selected) as string | null
      if (!path) return

      const result = await getApi().importExport.importFromFile(path, {
        overwrite: overwriteOnImport,
      })

      message.success(
        `${t('settings.importSuccess') || '导入成功'}: ${t('providers.importedCount', { count: result.imported })}`,
      )

      if (result.errors?.length) {
        Modal.error({
          title: t('settings.importErrors') || '导入有部分失败',
          content: (
            <div style={{ maxHeight: 240, overflow: 'auto' }}>
              {result.errors.map((err, idx) => (
                <div key={idx} style={{ marginBottom: 6 }}>
                  <Text type='secondary'>{err}</Text>
                </div>
              ))}
            </div>
          ),
        })
      }

      // Ensure UI reflects newly imported data.
      window.location.reload()
    } catch (e) {
      console.error('Import failed:', e)
      message.error(t('settings.importFailed') || '导入失败')
    } finally {
      setImportingData(false)
    }
  }

  const openBackupModal = () => {
    setBackupModalOpen(true)
  }

  const themeOptions = [
    { value: 'system', label: t('settings.themeSystem') },
    { value: 'light', label: t('settings.themeLight') },
    { value: 'dark', label: t('settings.themeDark') },
  ]

  const terminalOptions = [
    { value: 'iterm2', label: 'iTerm2' },
    { value: 'terminal', label: 'Terminal (macOS)' },
  ]

  return (
    <div className={styles.container}>
      {/* Header - Fixed */}
      <div className={styles.header}>
        <Title level={3} className='m-0! mb-1!'>
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

            {/* Local Proxy Service — merged status + port + restart in one row */}
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
                    <Text strong>{t('settings.proxyStatus')}</Text>
                    <br />
                    <Text type='secondary' className={styles.settingDesc}>
                      {t('settings.proxyStatusDesc')}
                    </Text>
                  </div>
                </Space>
                <Space>
                  <Tag color={proxyStatus.isRunning ? 'success' : 'default'}>
                    {proxyStatus.isRunning
                      ? t('dashboard.proxyRunning') || '运行中'
                      : t('dashboard.proxyStopped') || '已停止'}
                  </Tag>
                  <InputNumber
                    value={globalSettings.proxyPort}
                    onChange={(value) => value && updateGlobalSettings({ proxyPort: value })}
                    min={1024}
                    max={65535}
                    prefix=':'
                    style={{ width: 110 }}
                  />
                  <Button
                    size='small'
                    icon={<SyncOutlined />}
                    onClick={restartService}
                    loading={proxyLoading}
                  >
                    {t('settings.proxyRestart')}
                  </Button>
                </Space>
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

            {/* Launch at login */}
            <Card className={styles.settingCard} variant='outlined'>
              <div className={styles.settingRow}>
                <Space>
                  <div className={styles.iconBox} style={{ background: token.colorFillTertiary }}>
                    <PoweroffOutlined
                      className={styles.settingIcon}
                      style={{ color: token.colorText }}
                    />
                  </div>
                  <div>
                    <Text strong>{t('settings.launchAtLogin')}</Text>
                    <br />
                    <Text type='secondary' className={styles.settingDesc}>
                      {t('settings.launchAtLoginDesc')}
                    </Text>
                  </div>
                </Space>
                <Switch
                  checked={launchAtLogin}
                  loading={launchAtLoginLoading}
                  onChange={handleToggleLaunchAtLogin}
                />
              </div>
            </Card>

            {/* Show-window global shortcut */}
            <Card className={styles.settingCard} variant='outlined'>
              <div className={styles.settingRow}>
                <Space>
                  <div className={styles.iconBox} style={{ background: token.colorFillTertiary }}>
                    <ThunderboltOutlined
                      className={styles.settingIcon}
                      style={{ color: token.colorText }}
                    />
                  </div>
                  <div>
                    <Text strong>{t('settings.showWindowShortcut')}</Text>
                    <br />
                    <Text type='secondary' className={styles.settingDesc}>
                      {t('settings.showWindowShortcutDesc')}
                    </Text>
                  </div>
                </Space>
                <Space>
                  <Input
                    readOnly
                    value={recording ? t('settings.recording') : shortcutCombo}
                    placeholder={t('settings.showWindowShortcutPlaceholder')}
                    style={{ width: 180 }}
                  />
                  {shortcutCombo && !recording && (
                    <Button
                      size='small'
                      onClick={() => void commitCombo('')}
                    >
                      {t('settings.shortcutClear')}
                    </Button>
                  )}
                  <Button
                    size='small'
                    type={recording ? 'default' : 'primary'}
                    danger={recording}
                    onClick={() => (recording ? setRecording(false) : startRecording())}
                  >
                    {recording ? t('settings.recordCancel') : t('settings.recordShortcut')}
                  </Button>
                </Space>
              </div>
              {recording && (
                <div style={{ marginTop: 8 }}>
                  <Text type='secondary' style={{ fontSize: 12 }}>
                    {t('settings.recordHint')}
                  </Text>
                </div>
              )}
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

            <Divider className={styles.divider} />

            <Title level={4} className={styles.sectionTitle}>
              {t('settings.dataBackup') || '数据导入/导出'}
            </Title>

            <Card className={styles.settingCard} variant='outlined'>
              <div className={styles.settingRow}>
                <Space>
                  <div className={styles.iconBox} style={{ background: token.colorFillTertiary }}>
                    <DownloadOutlined
                      className={styles.settingIcon}
                      style={{ color: token.colorText }}
                    />
                  </div>
                  <div>
                    <Text strong>{t('settings.dataBackup') || '数据导入/导出'}</Text>
                    <br />
                    <Text type='secondary' className={styles.settingDesc}>
                      {t('settings.dataBackupDesc') ||
                        '导出/导入：使用记录、密钥、供应商（不包含项目）'}
                    </Text>
                  </div>
                </Space>

                <Space>
                  <Button
                    icon={<DownloadOutlined />}
                    loading={exportingData}
                    onClick={openBackupModal}
                  >
                    {t('settings.dataBackup') || '数据导入/导出'}
                  </Button>
                </Space>
              </div>
            </Card>

            <Modal
              title={t('settings.dataBackup') || '数据导入/导出'}
              open={backupModalOpen}
              onCancel={() => setBackupModalOpen(false)}
              footer={null}
              destroyOnClose
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <Text strong>{t('settings.exportData') || '导出'}</Text>
                  <div style={{ marginTop: 8 }}>
                    <Text type='secondary' style={{ fontSize: 12 }}>
                      {t('settings.exportInclude') || '导出内容'}
                    </Text>
                    <div style={{ marginTop: 6 }}>
                      <Checkbox.Group
                        value={exportSelections}
                        onChange={(values) => setExportSelections(values as string[])}
                        options={[
                          {
                            label: t('settings.exportOptionProvidersKeys') || '供应商 + 密钥',
                            value: 'providers',
                          },
                          {
                            label: t('settings.exportOptionUsageLogs') || '使用记录',
                            value: 'usageLogs',
                          },
                          {
                            label: t('settings.exportOptionRequestLogs') || '请求记录',
                            value: 'requestLogs',
                          },
                        ]}
                      />
                    </div>
                  </div>
                  <div style={{ marginTop: 12, textAlign: 'right' }}>
                    <Button
                      icon={<DownloadOutlined />}
                      loading={exportingData}
                      onClick={handleExportData}
                    >
                      {t('settings.exportData') || '导出'}
                    </Button>
                  </div>
                </div>

                <Divider style={{ margin: '4px 0' }} />

                <div>
                  <Text strong>{t('settings.importData') || '导入'}</Text>
                  <div style={{ marginTop: 10 }}>
                    <Space size={8}>
                      <Text type='secondary' style={{ fontSize: 12 }}>
                        {t('settings.overwriteOnImport') || '导入时覆盖同名供应商'}
                      </Text>
                      <Switch
                        checked={overwriteOnImport}
                        onChange={setOverwriteOnImport}
                        size='small'
                      />
                    </Space>
                    <Text type='secondary' style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                      {t('settings.overwriteOnImportHelp') ||
                        '关闭后：遇到同名供应商将跳过导入（含其密钥）'}
                    </Text>
                  </div>
                  <div style={{ marginTop: 12, textAlign: 'right' }}>
                    <Button
                      type='default'
                      icon={<UploadOutlined />}
                      loading={importingData}
                      onClick={handleImportData}
                    >
                      {t('settings.importData') || '导入'}
                    </Button>
                  </div>
                </div>
              </div>
            </Modal>

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
                    {t('settings.newVersionDesc', { version: updateResult.version })}
                  </Text>

                  {updateResult.body && (
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
                        {updateResult.body}
                      </ReactMarkdown>
                    </div>
                  )}

                  {/* Download progress */}
                  {updateDownloading && (
                    <div style={{ marginTop: 12 }}>
                      <Progress percent={downloadProgress} size='small' status='active' />
                    </div>
                  )}

                  {/* Action buttons */}
                  <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                    {!updateDownloading && !updateInstalled && (
                      <Button
                        type='primary'
                        icon={<DownloadOutlined />}
                        onClick={handleDownloadAndInstall}
                      >
                        {t('settings.installAndRestart')}
                      </Button>
                    )}

                    {updateInstalled && (
                      <Button type='primary' onClick={handleRelaunch}>
                        {t('settings.restartToUpdate')}
                      </Button>
                    )}
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
