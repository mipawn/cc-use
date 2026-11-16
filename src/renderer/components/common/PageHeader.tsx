import type { ReactNode } from 'react'
import styles from './PageHeader.module.css'

export default function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <header className={styles.header}>
      <div className={styles.identity}>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
  )
}
