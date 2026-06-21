import { useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import {
  HomeOutlined,
  KeyOutlined,
  BarChartOutlined,
  SettingOutlined,
  MonitorOutlined,
  CodeOutlined,
  DesktopOutlined,
  RocketOutlined,
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
          key: '/codex',
          icon: <CodeOutlined />,
          label: 'Codex',
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
      label: t('keys.title') || 'API 密钥',
    },
    {
      key: '/stats',
      icon: <BarChartOutlined />,
      label: t('statistics.title') || '费用统计',
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

  const selectedKey = (() => {
    const p = location.pathname
    if (p === '/statistics') return '/stats'
    if (p === '/projects' || p === '/instances' || p === '/sessions') return '/claude-code'
    return p
  })()

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
