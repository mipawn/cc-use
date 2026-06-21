import { useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import {
  HomeOutlined,
  KeyOutlined,
  FolderOutlined,
  BarChartOutlined,
  SettingOutlined,
  DatabaseOutlined,
  DeploymentUnitOutlined,
  MonitorOutlined,
  RocketOutlined,
  ApiOutlined,
  CloudServerOutlined,
} from '@ant-design/icons'

const { Sider } = Layout

export default function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const menuItems = [
    // ── 概览 ──
    {
      type: 'group' as const,
      label: t('sidebar.overview') || '概览',
      children: [
        {
          key: '/',
          icon: <HomeOutlined />,
          label: t('common.dashboard'),
        },
      ],
    },
    // ── 接入 ──
    {
      type: 'group' as const,
      label: t('sidebar.access') || '接入',
      children: [
        {
          key: '/launch',
          icon: <RocketOutlined />,
          label: t('sidebar.launchpad') || '启动台',
        },
        {
          key: '/integrations',
          icon: <ApiOutlined />,
          label: t('sidebar.integrations') || '接入点',
        },
        {
          key: '/projects',
          icon: <FolderOutlined />,
          label: t('common.projects'),
        },
        {
          key: '/instances',
          icon: <DeploymentUnitOutlined />,
          label: t('instances.title'),
        },
        {
          key: '/sessions',
          icon: <DatabaseOutlined />,
          label: t('sidebar.sessions') || '会话',
        },
      ],
    },
    // ── 上游 ──
    {
      type: 'group' as const,
      label: t('sidebar.upstream') || '上游',
      children: [
        {
          key: '/providers',
          icon: <CloudServerOutlined />,
          label: t('sidebar.providers') || '供应商',
        },
        {
          key: '/keys',
          icon: <KeyOutlined />,
          label: t('sidebar.keys') || '密钥',
        },
      ],
    },
    // ── 观测 ──
    {
      type: 'group' as const,
      label: t('sidebar.observe') || '观测',
      children: [
        {
          key: '/stats',
          icon: <BarChartOutlined />,
          label: t('sidebar.stats') || '费用统计',
        },
        {
          key: '/console',
          icon: <MonitorOutlined />,
          label: t('console.title'),
        },
      ],
    },
    // ── 系统 ──
    {
      type: 'group' as const,
      label: t('sidebar.system') || '系统',
      children: [
        {
          key: '/settings',
          icon: <SettingOutlined />,
          label: t('common.settings'),
        },
      ],
    },
  ]

  // Backward compatibility: map old paths to new ones
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
      {/* Drag region for sidebar top area (macOS traffic lights sit here) */}
      <div data-tauri-drag-region style={{ height: 52, flexShrink: 0 }} />
      <Menu
        mode='inline'
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
