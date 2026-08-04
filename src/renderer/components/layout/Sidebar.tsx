import { useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import {
  HomeOutlined,
  BarChartOutlined,
  SettingOutlined,
  MonitorOutlined,
  CodeOutlined,
  DesktopOutlined,
  RocketOutlined,
  AppstoreOutlined,
  KeyOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'

const { Sider } = Layout

export default function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const menuItems = [
    {
      key: '/',
      icon: <HomeOutlined />,
      label: t('common.dashboard'),
    },
    {
      key: 'launch',
      icon: <RocketOutlined />,
      label: t('launchpad.title') || '启动台',
      children: [
        {
          key: '/claude-code',
          icon: <CodeOutlined />,
          label: 'Claude Code',
        },
        {
          key: '/grok-build',
          icon: <ThunderboltOutlined />,
          label: 'Grok Build',
        },
        {
          key: '/codex',
          icon: <AppstoreOutlined />,
          label: 'Codex Desktop',
        },
        {
          key: '/claude-desktop',
          icon: <DesktopOutlined />,
          label: 'Claude Desktop',
        },
      ],
    },
    {
      key: '/keys',
      icon: <KeyOutlined />,
      label: '供应商密钥',
    },
    {
      key: '/stats',
      icon: <BarChartOutlined />,
      label: t('statistics.title') || '用量统计',
    },
    {
      key: '/console',
      icon: <MonitorOutlined />,
      label: t('console.title') || '控制台',
    },
    {
      key: '/settings',
      icon: <SettingOutlined />,
      label: t('common.settings'),
    },
  ]

  const selectedKey = location.pathname

  return (
    <Sider
      width={220}
      style={{
        background: token.colorBgContainer,
        borderRight: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <div data-tauri-drag-region style={{ height: 52, flexShrink: 0 }} />
      <Menu
        mode='inline'
        selectedKeys={[selectedKey]}
        items={menuItems}
        onClick={({ key }) => {
          if (key !== 'launch') navigate(key)
        }}
        style={{
          background: 'transparent',
          borderRight: 'none',
        }}
      />
    </Sider>
  )
}
