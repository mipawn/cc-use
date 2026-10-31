import { useState } from 'react'
import { Button, Input, Select } from 'antd'
import { useTranslation } from 'react-i18next'
import type { ClientModel } from '@shared/types'
import styles from './ModelMappingEditor.module.css'

/** Upstream targets are not limited by the client's exposed catalog. */
export default function ModelTargetField({
  value,
  models,
  label,
  onChange,
}: {
  value: string
  models: ClientModel[]
  label: string
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const [manual, setManual] = useState('')
  const [open, setOpen] = useState(false)
  const choices = new Map(models.map((model) => [model.id, model]))
  if (value && !choices.has(value)) choices.set(value, { id: value, displayName: value })
  const valid = Boolean(
    manual.trim() && !/\s/u.test(manual.trim()) && !/^https?:\/\//iu.test(manual.trim()),
  )
  const apply = () => {
    if (!valid) return
    onChange(manual.trim())
    setManual('')
    setOpen(false)
  }
  return (
    <Select
      allowClear
      value={value || undefined}
      className={styles.fullWidth}
      aria-label={label}
      placeholder={t('keys.clientModelId')}
      open={open}
      onOpenChange={setOpen}
      showSearch={{ optionFilterProp: 'label' }}
      options={[...choices.values()].map((model) => ({
        value: model.id,
        label:
          model.displayName && model.displayName !== model.id
            ? `${model.displayName} · ${model.id}`
            : model.id,
      }))}
      onChange={(next) => onChange(next ?? '')}
      popupRender={(menu) => (
        <>
          {menu}
          <div className={styles.manualModelEntry}>
            <Input
              value={manual}
              aria-label={`${label} ${t('keys.manualEntry')}`}
              placeholder={t('keys.clientModelManualHint')}
              onChange={(event) => setManual(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === 'Enter') {
                  event.preventDefault()
                  apply()
                }
              }}
            />
            <Button disabled={!valid} onClick={apply}>
              {t('keys.clientModelAdd')}
            </Button>
          </div>
        </>
      )}
    />
  )
}
