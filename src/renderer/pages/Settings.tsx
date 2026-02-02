import { useEffect } from 'react'
import { Typography, Card, Select, Space, theme, Switch, InputNumber, Divider } from 'antd'
import { useTranslation } from 'react-i18next'
import { useSettingsStore, ThemeMode } from '../stores/settingsStore'
import { GlobalOutlined, BgColorsOutlined, CloudServerOutlined, ApiOutlined, ThunderboltOutlined } from '@ant-design/icons'

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

  const providerTypeOptions = [
    { value: 'claude', label: t('providers.typeClaude') },
    { value: 'codex', label: t('providers.typeCodex') },
  ]

  return (
    <div className="page-container-sm">
      <div className="mb-6">
        <Title level={3} className="!m-0 !mb-1">
          {t('settings.title')}
        </Title>
        <Text type="secondary">
          {t('settings.subtitle')}
        </Text>
      </div>
      <Space direction="vertical" size="middle" className="w-full">
        <Card
          className="rounded-ant-lg"
          style={{ border: `1px solid ${token.colorBorderSecondary}` }}
        >
          <div className="flex justify-between items-center">
            <Space>
              <div
                className="icon-box"
                style={{ background: token.colorFillTertiary }}
              >
                <GlobalOutlined className="text-xl" style={{ color: token.colorText }} />
              </div>
              <div>
                <Text strong>{t('settings.language')}</Text>
                <br />
                <Text type="secondary" className="text-xs">{t('settings.languageDesc')}</Text>
              </div>
            </Space>
            <Select
              value={language}
              onChange={setLanguage}
              options={languageOptions}
              style={{ width: 140 }}
            />
          </div>
        </Card>
        <Card
          className="rounded-ant-lg"
          style={{ border: `1px solid ${token.colorBorderSecondary}` }}
        >
          <div className="flex justify-between items-center">
            <Space>
              <div
                className="icon-box"
                style={{ background: token.colorFillTertiary }}
              >
                <BgColorsOutlined className="text-xl" style={{ color: token.colorText }} />
              </div>
              <div>
                <Text strong>{t('settings.theme')}</Text>
                <br />
                <Text type="secondary" className="text-xs">{t('settings.themeDesc')}</Text>
              </div>
            </Space>
            <Select
              value={themeMode}
              onChange={(value) => setThemeMode(value as ThemeMode)}
              options={themeOptions}
              style={{ width: 140 }}
            />
          </div>
        </Card>

        <Divider className="!my-4" />

        <Title level={4} className="!m-0 !mb-2">
          {t('settings.globalConfig')}
        </Title>

        <Card
          className="rounded-ant-lg"
          style={{ border: `1px solid ${token.colorBorderSecondary}` }}
        >
          <div className="flex justify-between items-center">
            <Space>
              <div
                className="icon-box"
                style={{ background: token.colorFillTertiary }}
              >
                <CloudServerOutlined className="text-xl" style={{ color: token.colorText }} />
              </div>
              <div>
                <Text strong>{t('settings.defaultProviderType')}</Text>
                <br />
                <Text type="secondary" className="text-xs">{t('settings.defaultProviderTypeDesc')}</Text>
              </div>
            </Space>
            <Select
              value={globalSettings.defaultProviderType}
              onChange={(value) => updateGlobalSettings({ defaultProviderType: value })}
              options={providerTypeOptions}
              style={{ width: 140 }}
            />
          </div>
        </Card>

        <Card
          className="rounded-ant-lg"
          style={{ border: `1px solid ${token.colorBorderSecondary}` }}
        >
          <div className="flex justify-between items-center">
            <Space>
              <div
                className="icon-box"
                style={{ background: token.colorFillTertiary }}
              >
                <ApiOutlined className="text-xl" style={{ color: token.colorText }} />
              </div>
              <div>
                <Text strong>{t('settings.proxyPort')}</Text>
                <br />
                <Text type="secondary" className="text-xs">{t('settings.proxyPortDesc')}</Text>
              </div>
            </Space>
            <InputNumber
              value={globalSettings.proxyPort}
              onChange={(value) => value && updateGlobalSettings({ proxyPort: value })}
              min={1024}
              max={65535}
              style={{ width: 140 }}
            />
          </div>
        </Card>

        <Card
          className="rounded-ant-lg"
          style={{ border: `1px solid ${token.colorBorderSecondary}` }}
        >
          <div className="flex justify-between items-center">
            <Space>
              <div
                className="icon-box"
                style={{ background: token.colorFillTertiary }}
              >
                <ThunderboltOutlined className="text-xl" style={{ color: token.colorText }} />
              </div>
              <div>
                <Text strong>{t('settings.autoStartProxy')}</Text>
                <br />
                <Text type="secondary" className="text-xs">{t('settings.autoStartProxyDesc')}</Text>
              </div>
            </Space>
            <Switch
              checked={globalSettings.autoStartProxy}
              onChange={(checked) => updateGlobalSettings({ autoStartProxy: checked })}
            />
          </div>
        </Card>
      </Space>
    </div>
  )
}
