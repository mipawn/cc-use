import { useEffect, useState } from 'react'
import { Button, Input, Select } from 'antd'
import { useTranslation } from 'react-i18next'
import { getApi } from '../api'
import { useAppMessage } from '../hooks/useAppMessage'
import { USER_AGENT_PRESETS, userAgentOptions } from '../utils/userAgentOptions'

interface Props {
  value: string
  placeholder: string
  onChange: (value: string) => void
  onApply?: (value: string) => void
  disabled?: boolean
  /** Associates an explicit caller-rendered <label htmlFor>; harmless next to the aria-label. */
  inputId?: string
  /** Control-level error state (red border); the caller still renders the error text. */
  invalid?: boolean
  /** Whether this entry may write and delete entries in the shared UA library.
   * Default true (keys/model list). The gateway dialog reads only. */
  libraryActions?: boolean
}

export default function UserAgentField({
  value,
  placeholder,
  onChange,
  onApply,
  disabled = false,
  inputId,
  invalid,
  libraryActions = true,
}: Props) {
  const { t } = useTranslation()
  const message = useAppMessage()
  const [saved, setSaved] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    getApi()
      .userAgent.list()
      .then((values) => {
        if (!cancelled) setSaved(values)
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      setSaved(await getApi().userAgent.save(value))
      message.success(t('keys.uaSaved'))
    } catch (reason) {
      setError(String(reason))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    setDeleting(true)
    setError('')
    try {
      setSaved(await getApi().userAgent.delete(value.trim()))
      message.success(t('keys.uaDeleted'))
    } catch (reason) {
      setError(String(reason))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Input
          aria-label='User-Agent'
          id={inputId}
          status={invalid ? 'error' : undefined}
          style={{ flex: '1 1 220px' }}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          allowClear
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => onApply?.(value)}
          onPressEnter={(event) => {
            event.preventDefault()
            onApply?.(value)
          }}
        />
        <Select
          aria-label={t('keys.uaChoose')}
          style={{ width: 120 }}
          value={null}
          disabled={disabled}
          placeholder={t('keys.uaChoose')}
          popupMatchSelectWidth={420}
          styles={{ popup: { root: { maxWidth: 'calc(100vw - 32px)' } } }}
          options={userAgentOptions(saved, {
            builtin: t('keys.uaBuiltin'),
            saved: t('keys.uaLocal'),
          })}
          onOpenChange={(open) => {
            if (open)
              void getApi()
                .userAgent.list()
                .then(setSaved)
                .catch((reason) => setError(String(reason)))
          }}
          onChange={(next: string) => {
            onChange(next)
            onApply?.(next)
          }}
        />
        {libraryActions && (
          <>
            <Button
              loading={saving}
              disabled={
                disabled ||
                deleting ||
                !value.trim() ||
                USER_AGENT_PRESETS.some((preset) => preset.value === value.trim()) ||
                saved.includes(value.trim())
              }
              onClick={() => void save()}
            >
              {t('keys.uaSave')}
            </Button>
            {saved.includes(value.trim()) && (
              <Button
                danger
                loading={deleting}
                disabled={disabled || saving}
                onClick={() => void remove()}
              >
                {t('keys.uaDelete')}
              </Button>
            )}
          </>
        )}
      </div>
      {error && (
        <div role='alert' style={{ color: 'var(--ant-color-error)', marginTop: 4 }}>
          {error}
        </div>
      )}
    </div>
  )
}
