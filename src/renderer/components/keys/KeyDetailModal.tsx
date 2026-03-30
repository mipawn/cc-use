/**
 * KeyDetailModal - 密钥详情弹窗
 * 展示完整配置和操作选项
 */
import { useEffect, useState } from 'react'
import { Modal, Typography, Space, Tag, Button, Input, Divider, theme } from 'antd'

import { getApi } from '../../api'
import { useAppMessage } from '../../hooks/useAppMessage'
import {
  KeyOutlined,
  CopyOutlined,
  CheckOutlined,
  CloudServerOutlined,
  EditOutlined,
  SaveOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import ConfigPreview from '../common/ConfigPreview'
import { useApiKeyStore } from '../../stores/apiKeyStore'
import type { Provider, ApiKey, TerminalLaunchPreview } from '@shared/types'
import styles from './KeyDetailModal.module.css'

const { Text, Title } = Typography

interface KeyDetailModalProps {
  open: boolean
  apiKey: ApiKey
  provider: Provider | null
  proxyPort: number
  onClose: () => void
}

export default function KeyDetailModal({
  open,
  apiKey,
  provider,
  proxyPort: _proxyPort,
  onClose,
}: KeyDetailModalProps) {
  const { t } = useTranslation()
  const message = useAppMessage()
  const { token } = theme.useToken()
  const { updateApiKey } = useApiKeyStore()

  const [editingAlias, setEditingAlias] = useState(false)
  const [newAlias, setNewAlias] = useState(apiKey.alias || '')
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [preview, setPreview] = useState<TerminalLaunchPreview | null>(null)

  useEffect(() => {
    if (!open) return
    const cliType = apiKey.types[0] || 'claude'
    getApi()
      .terminal.getLaunchPreview({ apiKeyId: apiKey.id, cliType })
      .then(setPreview)
      .catch(() => setPreview(null))
  }, [open, apiKey.id, apiKey.types])

  useEffect(() => {
    setNewAlias(apiKey.alias || '')
  }, [apiKey.alias])


  const handleSaveAlias = async () => {
    setSaving(true)
    try {
      await updateApiKey({ id: apiKey.id, alias: newAlias || undefined })
      setEditingAlias(false)
      message.success(t('messages.success'))
    } catch (error) {
      message.error(t('messages.error'))
    } finally {
      setSaving(false)
    }
  }

  const handleCopyKey = async () => {
    try {
      await navigator.clipboard.writeText(apiKey.value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      message.success(t('common.copied') || '已复制')
    } catch (error) {
      message.error(t('messages.error'))
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={520}
      className={styles.modal}
      styles={{
        body: {
          maxHeight: '70vh',
          overflowY: 'auto',
        },
      }}
    >
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerIcon}>
          <KeyOutlined style={{ fontSize: 24, color: token.colorPrimary }} />
        </div>
        <div className={styles.headerContent}>
          {editingAlias ? (
            <Space.Compact className={styles.aliasEdit}>
              <Input
                value={newAlias}
                onChange={(e) => setNewAlias(e.target.value)}
                placeholder={t('apiKeys.keyNamePlaceholder')}
                size='small'
                autoFocus
              />
              <Button
                size='small'
                type='primary'
                icon={<SaveOutlined />}
                loading={saving}
                onClick={handleSaveAlias}
              />
            </Space.Compact>
          ) : (
            <Space>
              <Title level={4} className={styles.headerTitle}>
                {apiKey.alias || `Key ${apiKey.priority + 1}`}
              </Title>
              <Button
                type='text'
                size='small'
                icon={<EditOutlined />}
                onClick={() => {
                  setNewAlias(apiKey.alias || '')
                  setEditingAlias(true)
                }}
              />
            </Space>
          )}
          {provider && (
            <Space size={8} className={styles.headerMeta}>
              <CloudServerOutlined style={{ color: token.colorTextSecondary }} />
              <Text type='secondary'>{provider.name}</Text>
              <Tag color='cyan'>{provider.type}</Tag>
            </Space>
          )}
        </div>
      </div>

      <Divider className={styles.divider} />

      {/* Key Value */}
      <div className={styles.section}>
        <Text type='secondary' className={styles.sectionLabel}>
          {t('apiKeys.apiKey')}
        </Text>
        <div className={styles.keyValueBox}>
          <Input.Password value={apiKey.value} readOnly className={styles.keyValueInput} />
          <Button
            icon={copied ? <CheckOutlined /> : <CopyOutlined />}
            onClick={handleCopyKey}
            type={copied ? 'primary' : 'default'}
          >
            {copied ? t('common.copied') : t('common.copy')}
          </Button>
        </div>
      </div>

      {/* Status */}
      <div className={styles.section}>
        <Text type='secondary' className={styles.sectionLabel}>
          {t('common.status') || '状态'}
        </Text>
        <Space size={12}>
          <Tag color={apiKey.isExhausted ? 'error' : 'success'}>
            {apiKey.isExhausted ? t('keys.exhausted') || '已耗尽' : t('keys.active') || '可用'}
          </Tag>
          <Tag>
            {t('keys.priority') || '优先级'}: {apiKey.priority + 1}
          </Tag>
        </Space>
      </div>

      {/* Config Preview */}
      <div className={styles.section}>
        <Text type='secondary' className={styles.sectionLabel}>
          {t('configPreview.envVars') || '环境变量配置'}
        </Text>
        <ConfigPreview provider={provider} apiKey={apiKey} preview={preview} showCopy showMask />
      </div>
    </Modal>
  )
}
