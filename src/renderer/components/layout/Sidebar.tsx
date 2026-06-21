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
      key: '/claude-code',
      icon: <CodeOutlined />,
      label: 'Claude Code',
      children: [
        {
          key: '/projects',
          label: t('common.projects') || '项目',
        },
        {
          key: '/instances',
          label: t('instances.title') || '实例',
        },
        {
          key: '/sessions',
          label: '会话',
        },
      ],
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
          // 只导航叶子节点，父级菜单只展开/折叠
          const isParent = menuItems.some((item) => item.key === key && 'children' in item && item.children != null)
          if (!isParent) navigate(key)
        }}
        style={{
          background: 'transparent',
          borderRight: 'none',
        }}
      />
    </Sider>
  )
}
