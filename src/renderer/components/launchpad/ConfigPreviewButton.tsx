import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Modal } from 'antd'
import { EyeOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { getApi } from '../../api'
import { getClientKindLabel, type DesktopClientKind } from '@shared/types'
import { redactConfigPreview } from '../../utils/configPreview'

export default function ConfigPreviewButton({ clientKind }: { clientKind: DesktopClientKind }) {
  const { t } = useTranslation()
  const [preview, setPreview] = useState({
    open: false,
    content: '',
    loading: false,
    failed: false,
  })
  const revision = useRef(0)
  useEffect(
    () => () => {
      ++revision.current
    },
    [clientKind],
  )
  const handleOpen = async () => {
    const request = ++revision.current
    setPreview({ open: true, content: '', loading: true, failed: false })
    try {
      const content =
        clientKind === 'codex'
          ? await getApi().configTakeover.readCodex()
          : await getApi().configTakeover.readClaudeDesktop()
      if (request !== revision.current) return
      setPreview({
        open: true,
        content: redactConfigPreview(content || ''),
        loading: false,
        failed: false,
      })
    } catch {
      if (request === revision.current)
        setPreview({ open: true, content: '', loading: false, failed: true })
    }
  }
  const handleClose = () => {
    ++revision.current
    setPreview((prev) => ({ ...prev, open: false }))
  }
  return (
    <>
      <Button icon={<EyeOutlined />} onClick={() => void handleOpen()}>
        {t('desktopAccess.preview')}
      </Button>
      <Modal
        title={`${getClientKindLabel(clientKind)} · ${t('desktopAccess.preview')}`}
        open={preview.open}
        onCancel={handleClose}
        footer={<Button onClick={handleClose}>{t('common.close')}</Button>}
        width={720}
        loading={preview.loading}
        destroyOnHidden
      >
        <p>{t('desktopAccess.previewHint')}</p>
        {preview.failed ? (
          <Alert
            type='error'
            showIcon
            title={t('desktopAccess.previewFailed')}
            action={<Button onClick={() => void handleOpen()}>{t('common.retry')}</Button>}
          />
        ) : (
          <pre
            style={{
              maxHeight: '56vh',
              margin: 0,
              padding: 12,
              overflow: 'auto',
              border: '1px solid var(--border-subtle)',
              borderRadius: 8,
              background: 'var(--surface-sunken)',
              color: 'var(--ant-color-text)',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {preview.content || t('desktopAccess.emptyConfig')}
          </pre>
        )}
      </Modal>
    </>
  )
}
