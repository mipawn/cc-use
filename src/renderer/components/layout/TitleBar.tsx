import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons'
import ServiceStatusPill from './ServiceStatusPill'
import { clientWorkspaces } from './workspaceNavigation'
import styles from './WorkspaceLayout.module.css'

export default function TitleBar({
  collapsed,
  onToggleSidebar,
}: {
  collapsed: boolean
  onToggleSidebar: () => void
}) {
  const { pathname } = useLocation()
  const { t } = useTranslation()
  const client = clientWorkspaces.find((item) => item.path === pathname)
  const pages: Record<string, string> = {
    '/': 'workspace.home',
    '/keys': 'keys.title',
    '/stats': 'workspace.activityTitle',
    '/console': 'workspace.activityTitle',
    '/settings': 'common.settings',
  }

  return (
    <header className={styles.titlebar} data-tauri-drag-region>
      <div className={styles.breadcrumb}>
        <button
          type='button'
          className={styles.iconButton}
          onClick={onToggleSidebar}
          aria-label={t(collapsed ? 'workspace.expandSidebar' : 'workspace.collapseSidebar')}
          aria-expanded={!collapsed}
        >
          {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
        </button>
        <span>cc-use</span>
        <span className={styles.separator}>/</span>
        <span className={styles.breadcrumbTitle}>
          {client?.name || t(pages[pathname] || 'workspace.home')}
        </span>
      </div>
      <ServiceStatusPill />
    </header>
  )
}
