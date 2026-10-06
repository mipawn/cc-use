import { useState } from 'react'
import { Button, Input, Select } from 'antd'
import { CheckOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { CliConfig } from '@shared/types'
import type { ClientModel } from '../../utils/modelMapping'
import { readClaudeConfig } from '../../utils/claudeConfig'
import styles from './ModelMappingEditor.module.css'

interface Props {
  envKey: string
  label: string
  configJson: string
  globalConfig: CliConfig
  models: ClientModel[]
  aliases?: boolean
  invalid?: boolean
  onChange: (json: string) => void
}
const INHERIT = 'source:global'
const CLIENT = 'source:client'

export default function CodeModelField({
  envKey,
  label,
  configJson,
  globalConfig,
  models,
  aliases = false,
  invalid = false,
  onChange,
}: Props) {
  const { t } = useTranslation()
  const [manual, setManual] = useState('')
  const [open, setOpen] = useState(false)
  const { config, valid } = readClaudeConfig(configJson)
  const own = Object.prototype.hasOwnProperty.call(config, envKey)
  const current = !own
    ? INHERIT
    : config[envKey] === null
      ? CLIENT
      : `model:${String(config[envKey])}`
  const choices = new Map<string, string>(
    models.map((model) => [model.id, model.displayName || model.id]),
  )
  if (aliases)
    for (const alias of ['sonnet', 'opus', 'haiku'])
      if (!choices.has(alias)) choices.set(alias, alias)
  if (own && typeof config[envKey] === 'string' && config[envKey])
    choices.set(
      config[envKey] as string,
      choices.get(config[envKey] as string) || (config[envKey] as string),
    )
  const global = typeof globalConfig[envKey] === 'string' ? String(globalConfig[envKey]) : ''
  const apply = (value: string) => {
    if (!valid) return
    const next = { ...config }
    if (value === INHERIT) delete next[envKey]
    else next[envKey] = value === CLIENT ? null : value.slice('model:'.length)
    onChange(JSON.stringify(next, null, 2))
    setOpen(false)
    setManual('')
  }
  const applyManual = () => {
    if (manual.trim()) apply(`model:${manual.trim()}`)
  }
  return (
    <Select
      value={current}
      disabled={!valid}
      status={invalid ? 'error' : undefined}
      open={open}
      onOpenChange={setOpen}
      className={styles.fullWidth}
      aria-label={`Claude Code ${envKey}`}
      onChange={apply}
      showSearch={{ optionFilterProp: 'label' }}
      options={[
        {
          value: INHERIT,
          label: global ? t('keys.inheritWithModel', { model: global }) : t('keys.configInherit'),
        },
        { value: CLIENT, label: t('keys.clientNativeDefault') },
        ...Array.from(choices, ([id, name]) => ({
          value: `model:${id}`,
          label: name === id ? id : `${name} · ${id}`,
        })),
      ]}
      popupRender={(menu) => (
        <>
          {menu}
          <div className={styles.manualModelEntry}>
            <Input
              value={manual}
              onChange={(event) => setManual(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === 'Enter') {
                  event.preventDefault()
                  applyManual()
                }
              }}
              placeholder={t('keys.clientModelManualHint')}
              aria-label={`${label} ${t('keys.manualEntry')}`}
            />
            <Button
              type='text'
              icon={<CheckOutlined />}
              disabled={!manual.trim()}
              aria-label={t('keys.useEnteredModel')}
              onClick={applyManual}
            />
          </div>
        </>
      )}
    />
  )
}
