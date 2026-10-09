import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import { HomeOutlined, BarChartOutlined, SettingOutlined, KeyOutlined } from '@ant-design/icons'
import { clientWorkspaces } from './workspaceNavigation'
import styles from './WorkspaceLayout.module.css'
import appLogo from '../../assets/icon.svg'

export default function Sidebar() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const link = (path: string, label: string, icon: ReactNode, activePaths = [path]) => (
    <Link
      key={path}
      to={path}
      className={styles.navItem}
      title={label}
      aria-label={label}
      aria-current={activePaths.includes(pathname) ? 'page' : undefined}
    >
      <span className={styles.navIcon}>{icon}</span>
      <span className={styles.navLabel}>{label}</span>
    </Link>
  )

  return (
    <aside className={styles.sidebar} aria-label={t('workspace.navigation')}>
      <div className={styles.trafficSpace} data-tauri-drag-region />
      <div className={styles.brand} data-tauri-drag-region>
        <img className={styles.brandMark} src={appLogo} alt='' />
        <span className={styles.brandName}>cc-use</span>
      </div>
      <nav className={styles.navigation}>
        {link('/', t('workspace.home'), <HomeOutlined />)}
        <div className={styles.group}>
          <span className={styles.groupLabel}>{t('workspace.clients')}</span>
          {clientWorkspaces.map((client) => link(client.path, client.name, client.icon))}
        </div>
        <div className={styles.group}>
          <span className={styles.groupLabel}>{t('workspace.manage')}</span>
          {link('/keys', t('keys.title'), <KeyOutlined />)}
          {link('/stats', t('workspace.activityTitle'), <BarChartOutlined />, [
            '/stats',
            '/console',
          ])}
        </div>
      </nav>
      <div className={styles.footer}>
        {link('/settings', t('common.settings'), <SettingOutlined />)}
      </div>
    </aside>
  )
}
