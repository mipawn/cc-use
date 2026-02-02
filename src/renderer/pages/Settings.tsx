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
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <Title level={3} style={{ margin: 0, marginBottom: 4 }}>
          {t('settings.title')}
        </Title>
        <Text type="secondary">
          {t('settings.subtitle')}
        </Text>
      </div>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Card
          style={{
            borderRadius: 12,
            border: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Space>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 8,
                  background: token.colorFillTertiary,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <GlobalOutlined style={{ fontSize: 20, color: token.colorText }} />
              </div>
              <div>
                <Text strong>{t('settings.language')}</Text>
                <br />
                <Text type="secondary" style={{ fontSize: 12 }}>{t('settings.languageDesc')}</Text>
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
          style={{
            borderRadius: 12,
            border: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Space>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 8,
                  background: token.colorFillTertiary,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <BgColorsOutlined style={{ fontSize: 20, color: token.colorText }} />
              </div>
              <div>
                <Text strong>{t('settings.theme')}</Text>
                <br />
                <Text type="secondary" style={{ fontSize: 12 }}>{t('settings.themeDesc')}</Text>
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
