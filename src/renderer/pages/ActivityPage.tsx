import { Tabs } from 'antd'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import styles from './ActivityPage.module.css'

export default function ActivityPage() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const isConsole = pathname === '/console'

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h2>{t('workspace.activityTitle')}</h2>
        <p>{t(isConsole ? 'console.subtitle' : 'statistics.subtitle')}</p>
      </header>
      <Tabs
        activeKey={isConsole ? '/console' : '/stats'}
        onChange={(path) => navigate(path)}
        items={[
          { key: '/stats', label: t('statistics.title') },
          { key: '/console', label: t('workspace.liveConsole') },
        ]}
      />
      <div className={styles.content}>
        <Outlet />
      </div>
    </div>
  )
}
