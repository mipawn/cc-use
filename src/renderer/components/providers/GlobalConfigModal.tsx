/**
 * GlobalConfigModal - 全局配置弹窗
 * 用于配置 Claude Code / Codex CLI 的全局参数
 * 每个 tab 独立保存
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
      const claudeConfig = globalSettings.claudeConfig || {}
      const codexConfig = globalSettings.codexConfig || {}
      setClaudeJson(JSON.stringify(claudeConfig, null, 2) || '{}')
      setCodexJson(JSON.stringify(codexConfig, null, 2) || '{}')
      setClaudeError(null)
      setCodexError(null)
    }
  }, [open, globalSettings])

  // 验证 JSON
  const validateJson = (json: string): CliConfig | null => {
    try {
      return JSON.parse(json) as CliConfig
    } catch {
      return null
    }
  }

  // 保存 Claude 配置
  const handleSaveClaude = async () => {
    const config = validateJson(claudeJson)
    if (config === null) {
      setClaudeError('JSON 格式错误')
      return
    }
    setClaudeError(null)
    setClaudeSaving(true)
    try {
      await updateGlobalSettings({ claudeConfig: config })
      message.success('Claude Code 配置已保存')
    } catch {
      message.error('保存失败')
    } finally {
      setClaudeSaving(false)
    }
  }

  // 保存 Codex 配置
  const handleSaveCodex = async () => {
    const config = validateJson(codexJson)
    if (config === null) {
      setCodexError('JSON 格式错误')
      return
    }
    setCodexError(null)
    setCodexSaving(true)
    try {
      await updateGlobalSettings({ codexConfig: config })
      message.success('Codex CLI 配置已保存')
    } catch {
      message.error('保存失败')
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
      title={t('globalConfig.title') || '全局配置'}
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
            {t('globalConfig.subtitle') ||
              '配置 CLI 工具的默认参数，将应用于所有使用对应类型的密钥'}
          </Text>

          {/* Type Selector */}
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

          {/* Claude Config */}
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
                  {t('globalConfig.jsonConfigHint') || '配置将应用于所有 Claude Code 类型的密钥'}
                </Text>
                <Button
                  type='primary'
                  icon={<SaveOutlined />}
                  loading={claudeSaving}
                  onClick={handleSaveClaude}
                >
                  {t('common.save') || '保存'}
                </Button>
              </div>
            </div>
          )}

          {/* Codex Config */}
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
                  {t('globalConfig.jsonConfigHint') || '配置将应用于所有 Codex CLI 类型的密钥'}
                </Text>
                <Button
                  type='primary'
                  icon={<SaveOutlined />}
                  loading={codexSaving}
                  onClick={handleSaveCodex}
                >
                  {t('common.save') || '保存'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </SimpleBar>
    </Modal>
  )
}
