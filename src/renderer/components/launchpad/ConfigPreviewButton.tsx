import { useState } from 'react'
import { Button, Modal, Tooltip } from 'antd'
import { EyeOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { getApi } from '../../api'
import { useAppMessage } from '../../hooks/useAppMessage'
import type { ClientKind } from '@shared/types'

interface ConfigPreviewButtonProps {
  clientKind: Extract<ClientKind, 'codex' | 'claude_desktop'>
}

export default function ConfigPreviewButton({ clientKind }: ConfigPreviewButtonProps) {
  const { t } = useTranslation()
  const message = useAppMessage()
  const [preview, setPreview] = useState({
    open: false,
    content: '',
    loading: false,
  })

  const title = clientKind === 'codex' ? 'Codex Desktop 配置' : 'Claude Desktop 配置'

  const handleOpen = async () => {
    setPreview({ open: true, content: '', loading: true })

    try {
      const content = clientKind === 'codex'
        ? await getApi().configTakeover.readCodex()
        : await getApi().configTakeover.readClaudeDesktop()
      setPreview({ open: true, content: content || '(空配置)', loading: false })
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      setPreview({ open: true, content: messageText, loading: false })
      message.error(messageText)
    }
  }

  const handleClose = () => {
    setPreview((prev) => ({ ...prev, open: false }))
  }

  return (
    <>
      <Tooltip title='查看配置'>
        <Button type='default' size='small' icon={<EyeOutlined />} onClick={handleOpen}>
          查看配置
        </Button>
      </Tooltip>
      <Modal
        title={title}
        open={preview.open}
        onCancel={handleClose}
        footer={[
          <Button key='close' onClick={handleClose}>
            {t('common.close') || '关闭'}
          </Button>,
        ]}
        width={720}
        loading={preview.loading}
        destroyOnHidden
      >
        <pre
          style={{
            maxHeight: '56vh',
            margin: 0,
            padding: 12,
            overflow: 'auto',
            border: '1px solid var(--border-subtle, rgba(0, 0, 0, 0.06))',
            borderRadius: 8,
            background: 'var(--surface-sunken, #f8fafc)',
            color: 'var(--ant-color-text)',
            fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
            fontSize: 12,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {preview.content}
        </pre>
      </Modal>
    </>
  )
}
