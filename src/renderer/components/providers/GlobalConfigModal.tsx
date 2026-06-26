/**
 * GlobalConfigModal - 默认启动参数
 * 编辑 Claude Code 启动时作为默认环境变量注入的 JSON。
 * 只保存在应用数据库，不会写入 ~/.claude 等 CLI 自己的配置文件。
 */
import { useState, useEffect } from 'react'
import { Modal, Typography, Input, Space, Button, theme } from 'antd'
import { useAppMessage } from '../../hooks/useAppMessage'
import { SaveOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import type { CliConfig } from '@shared/types'
import { useSettingsStore } from '../../stores/settingsStore'
import styles from './GlobalConfigModal.module.css'

const { Text } = Typography
const { TextArea } = Input

interface GlobalConfigModalProps {
  open?: boolean
  onClose?: () => void
  embedded?: boolean
}

export default function GlobalConfigModal({ open = true, onClose, embedded = false }: GlobalConfigModalProps) {
  const { t } = useTranslation()
  const message = useAppMessage()
  const { token } = theme.useToken()
  const { globalSettings, updateGlobalSettings } = useSettingsStore()

  const [claudeJson, setClaudeJson] = useState('')
  const [claudeSaving, setClaudeSaving] = useState(false)
  const [claudeError, setClaudeError] = useState<string | null>(null)

  useEffect(() => {
    if (open || embedded) {
      setClaudeJson(JSON.stringify(globalSettings.claudeConfig || {}, null, 2))
      setClaudeError(null)
    }
  }, [open, embedded, globalSettings])

  const validateJson = (json: string): CliConfig | null => {
    try {
      return JSON.parse(json) as CliConfig
    } catch {
      return null
    }
  }

  const handleSaveClaude = async () => {
    const config = validateJson(claudeJson)
    if (config === null) {
      setClaudeError(t('globalConfig.jsonFormatError'))
      return
    }
    setClaudeError(null)
    setClaudeSaving(true)
    try {
      await updateGlobalSettings({ claudeConfig: config })
      message.success(t('globalConfig.claudeConfigSaved'))
    } catch {
      message.error(t('globalConfig.saveFailed'))
    } finally {
      setClaudeSaving(false)
    }
  }

  const handleClaudeChange = (value: string) => {
    setClaudeJson(value)
    if (claudeError) {
      const config = validateJson(value)
      if (config !== null) setClaudeError(null)
    }
  }

  const content = (
    <div className={embedded ? styles.embeddedContent : styles.content}>
      <Text type='secondary' className={styles.subtitle}>
        {t('globalConfig.subtitle')}
      </Text>

      <Space style={{ marginBottom: 16 }}>
        <span
          className={styles.typeIndicator}
          style={{ background: token.colorPrimary }}
        />
        <Text strong>Claude Code</Text>
      </Space>

      <div className={styles.editorSection}>
        <TextArea
          value={claudeJson}
          onChange={(e) => handleClaudeChange(e.target.value)}
          className={`${styles.jsonEditor} ${claudeError ? styles.jsonEditorError : ''}`}
          autoSize={{ minRows: 10, maxRows: 18 }}
          placeholder='{}'
        />
        {claudeError && (
          <Text type='danger' className={styles.errorText}>
            {claudeError}
          </Text>
        )}
        <div className={styles.editorFooter}>
          <Text type='secondary' className={styles.editorHint}>
            {t('globalConfig.jsonConfigHint')}
          </Text>
          <Button
            type='primary'
            icon={<SaveOutlined />}
            loading={claudeSaving}
            onClick={handleSaveClaude}
          >
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  )

  if (embedded) {
    return (
      <SimpleBar style={{ maxHeight: 'calc(100vh - 150px)' }}>
        {content}
      </SimpleBar>
    )
  }

  return (
    <Modal
      title={t('globalConfig.title')}
      open={open}
      onCancel={onClose}
      footer={null}
      width={560}
      destroyOnHidden
      className={styles.modal}
    >
      <SimpleBar style={{ maxHeight: 'calc(80vh - 160px)' }}>
        {content}
      </SimpleBar>
    </Modal>
  )
}
