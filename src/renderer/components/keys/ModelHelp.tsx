import { Tooltip } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'
import styles from './ModelMappingEditor.module.css'

export default function ModelHelp({ label, text }: { label: string; text: string }) {
  return (
    <Tooltip title={text} trigger={['hover', 'focus', 'click']}>
      <button type='button' className={styles.helpButton} aria-label={label}>
        <InfoCircleOutlined />
      </button>
    </Tooltip>
  )
}
