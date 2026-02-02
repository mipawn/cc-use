import { useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import {
  HomeOutlined,
  CloudServerOutlined,
  FolderOutlined,
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
      key: '/providers',
      icon: <CloudServerOutlined />,
      label: t('common.providers'),
    },
    {
      key: '/projects',
      icon: <FolderOutlined />,
      label: t('common.projects'),
    },
    {
      key: '/settings',
      icon: <SettingOutlined />,
      label: t('common.settings'),
    },
  ]

  return (
    <Sider
      width={220}
      style={{
        background: token.colorBgContainer,
        borderRight: `1px solid ${token.colorBorderSecondary}`,
        paddingTop: 48,
      }}
    >
      <div
        className="drag-region"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 48,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
        }}
      >
      </div>
      <Menu
        mode="inline"
        selectedKeys={[location.pathname]}
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
