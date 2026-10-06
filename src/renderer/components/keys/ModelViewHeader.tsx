import type { ReactNode } from 'react'
import { Button, Typography } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import styles from './ModelMappingEditor.module.css'

export default function ModelViewHeader({ title, onBack, extra }: { title: string; onBack: () => void; extra?: ReactNode }) {
  const { t } = useTranslation()
  return <>
    <Button type='text' size='small' icon={<ArrowLeftOutlined />} onClick={onBack} className={styles.backButton}>{t('keys.backToModels')}</Button>
    <div className={styles.viewHead}><Typography.Text strong>{title}</Typography.Text>{extra}</div>
  </>
}
