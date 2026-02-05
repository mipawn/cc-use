/**
 * Settings - 简化的设置页面
 * 只保留：语言、主题、代理端口、默认终端
 */
import { useEffect } from 'react'
import {
  Typography,
  Card,
  Select,
  Space,
  theme,
  InputNumber,
  Divider,
} from 'antd'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import { useSettingsStore, ThemeMode } from '../stores/settingsStore'
import {
  GlobalOutlined,
  BgColorsOutlined,
  ApiOutlined,
  CodeOutlined,
} from '@ant-design/icons'
import styles from './Settings.module.css'

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

  useEffect(() => {
    fetchGlobalSettings()
  }, [fetchGlobalSettings])

  const languageOptions = [
    { value: 'en', label: 'English' },
    { value: 'zh', label: '中文' },
  ]

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
          </div>
        </SimpleBar>
      </div>
    </div>
  )
}
