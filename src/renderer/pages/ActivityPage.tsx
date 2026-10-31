import { Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import styles from './ActivityPage.module.css'

export default function ActivityPage() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const title = pathname === '/console' ? 'console.title' : 'statistics.title'
  const subtitle = pathname === '/console' ? 'console.subtitle' : 'statistics.subtitle'

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h2>{t(title)}</h2>
        <p>{t(subtitle)}</p>
      </header>
      <div className={styles.content}>
        <Outlet />
      </div>
    </div>
  )
}
