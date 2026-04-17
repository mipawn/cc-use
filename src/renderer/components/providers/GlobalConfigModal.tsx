/**
 * GlobalConfigModal - 默认启动参数
 * 编辑 Claude Code / Codex CLI 启动时作为默认环境变量注入的 JSON。
 * 只保存在应用数据库，不会写入 ~/.claude 等 CLI 自己的配置文件。
 */
import { useState, useEffect } from 'react'
import { Modal, Typography, Input, Segmented, Space, Button, theme } from 'antd'
import { useAppMessage } from '../../hooks/useAppMessage'
import { SaveOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import type { CliConfig, ProviderType } from '@shared/types'
import { useSettingsStore } from '../../stores/settingsStore'
import styles from './GlobalConfigModal.module.css'

const { Text } = Typography
const { TextArea } = Input

interface GlobalConfigModalProps {
  open: boolean
  onClose: () => void
}

export default function GlobalConfigModal({ open, onClose }: GlobalConfigModalProps) {
  const { t } = useTranslation()
  const message = useAppMessage()
  const { token } = theme.useToken()
  const { globalSettings, updateGlobalSettings } = useSettingsStore()

  const [activeType, setActiveType] = useState<ProviderType>('claude')
  const [claudeJson, setClaudeJson] = useState('')
  const [codexJson, setCodexJson] = useState('')
  const [claudeSaving, setClaudeSaving] = useState(false)
  const [codexSaving, setCodexSaving] = useState(false)
  const [claudeError, setClaudeError] = useState<string | null>(null)
  const [codexError, setCodexError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setClaudeJson(JSON.stringify(globalSettings.claudeConfig || {}, null, 2))
      setCodexJson(JSON.stringify(globalSettings.codexConfig || {}, null, 2))
      setClaudeError(null)
      setCodexError(null)
    }
  }, [open, globalSettings])

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

  const handleSaveCodex = async () => {
    const config = validateJson(codexJson)
    if (config === null) {
      setCodexError(t('globalConfig.jsonFormatError'))
      return
    }
    setCodexError(null)
    setCodexSaving(true)
    try {
      await updateGlobalSettings({ codexConfig: config })
      message.success(t('globalConfig.codexConfigSaved'))
    } catch {
      message.error(t('globalConfig.saveFailed'))
    } finally {
      setCodexSaving(false)
    }
  }

  const handleClaudeChange = (value: string) => {
    setClaudeJson(value)
    if (claudeError) {
      const config = validateJson(value)
      if (config !== null) setClaudeError(null)
    }
  }

  const handleCodexChange = (value: string) => {
    setCodexJson(value)
    if (codexError) {
      const config = validateJson(value)
      if (config !== null) setCodexError(null)
    }
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
        <div className={styles.content}>
          <Text type='secondary' className={styles.subtitle}>
            {t('globalConfig.subtitle')}
          </Text>

          <Segmented
            value={activeType}
            onChange={(value) => setActiveType(value as ProviderType)}
            options={[
              {
                value: 'claude',
                label: (
                  <Space>
                    <span
                      className={styles.typeIndicator}
                      style={{ background: token.colorPrimary }}
                    />
                    <span>Claude Code</span>
                  </Space>
                ),
              },
              {
                value: 'codex',
                label: (
                  <Space>
                    <span
                      className={styles.typeIndicator}
                      style={{ background: token.colorSuccess }}
                    />
                    <span>Codex CLI</span>
                  </Space>
                ),
              },
            ]}
            block
            className={styles.typeSegmented}
          />

          {activeType === 'claude' && (
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
          )}

          {activeType === 'codex' && (
            <div className={styles.editorSection}>
              <TextArea
                value={codexJson}
                onChange={(e) => handleCodexChange(e.target.value)}
                className={`${styles.jsonEditor} ${codexError ? styles.jsonEditorError : ''}`}
                autoSize={{ minRows: 10, maxRows: 18 }}
                placeholder='{}'
              />
              {codexError && (
                <Text type='danger' className={styles.errorText}>
                  {codexError}
                </Text>
              )}
              <div className={styles.editorFooter}>
                <Text type='secondary' className={styles.editorHint}>
                  {t('globalConfig.jsonConfigHint')}
                </Text>
                <Button
                  type='primary'
                  icon={<SaveOutlined />}
                  loading={codexSaving}
                  onClick={handleSaveCodex}
                >
                  {t('common.save')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </SimpleBar>
    </Modal>
  )
}
