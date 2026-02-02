import { Typography, Card, Select, Space, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { useSettingsStore, ThemeMode } from '../stores/settingsStore'
import { GlobalOutlined, BgColorsOutlined } from '@ant-design/icons'

const { Title, Text } = Typography

export default function Settings() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { language, themeMode, setLanguage, setThemeMode } = useSettingsStore()

  const languageOptions = [
    { value: 'en', label: 'English' },
    { value: 'zh', label: '中文' },
  ]

  const themeOptions = [
    { value: 'system', label: t('settings.themeSystem') },
    { value: 'light', label: t('settings.themeLight') },
    { value: 'dark', label: t('settings.themeDark') },
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
      </Space>
    </div>
  )
}
