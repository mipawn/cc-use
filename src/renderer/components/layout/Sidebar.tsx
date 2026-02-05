import { useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import {
  HomeOutlined,
  KeyOutlined,
  FolderOutlined,
  BarChartOutlined,
  SettingOutlined,
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
      key: '/keys',
      icon: <KeyOutlined />,
      label: t('keys.title') || 'API 密钥',
    },
    {
      key: '/projects',
      icon: <FolderOutlined />,
      label: t('common.projects'),
    },
    {
      key: '/statistics',
      icon: <BarChartOutlined />,
      label: t('statistics.title') || '使用统计',
    },
    {
      key: '/settings',
      icon: <SettingOutlined />,
      label: t('common.settings'),
    },
  ]

  // Map /providers to /keys for backward compatibility
  const selectedKey = location.pathname === '/providers' ? '/keys' : location.pathname

  return (
    <Sider
      width={220}
      className="pt-12"
      style={{
        background: token.colorBgContainer,
        borderRight: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <div className="drag-region absolute top-0 left-0 right-0 h-12 flex items-center justify-start" />
      <Menu
        mode="inline"
        selectedKeys={[selectedKey]}
        items={menuItems}
        onClick={({ key }) => navigate(key)}
        style={{
          background: 'transparent',
          borderRight: 'none',
        }}
      />
    </Sider>
  )
}
