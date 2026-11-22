import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import {
  HomeOutlined,
  BarChartOutlined,
  SettingOutlined,
  KeyOutlined,
  ApiOutlined,
  ConsoleSqlOutlined,
} from '@ant-design/icons'
import ClientIcon from '../common/ClientIcon'
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
          <span className={styles.groupLabel}>{t('clients.groupAccess')}</span>
          {link(
            '/clients/claude-code',
            t('clients.claudeCode'),
            <ClientIcon kind='claude_code' size={16} />,
          )}
          {link(
            '/clients/codex',
            t('clients.codexDesktop'),
            <ClientIcon kind='codex' size={16} />,
          )}
          {link(
            '/clients/claude-desktop',
            t('clients.claudeDesktop'),
            <ClientIcon kind='claude_desktop' size={16} />,
          )}
          {link('/clients/grok', t('clients.grokBuild'), <ClientIcon kind='grok' size={16} />)}
          {link('/gateway', t('clients.apiGateway'), <ApiOutlined />)}
        </div>

        <div className={styles.group}>
          <span className={styles.groupLabel}>{t('clients.groupUpstream')}</span>
          {link('/keys', t('clients.providersAndKeys'), <KeyOutlined />)}
        </div>

        <div className={`${styles.group} ${styles.observationGroup}`}>
          <span className={styles.groupLabel}>{t('clients.groupObserve')}</span>
          {link('/stats', t('statistics.title'), <BarChartOutlined />)}
          {link('/console', t('workspace.liveConsole'), <ConsoleSqlOutlined />)}
        </div>
      </nav>
      <div className={styles.footer}>
        {link('/settings', t('common.settings'), <SettingOutlined />)}
      </div>
    </aside>
  )
}
