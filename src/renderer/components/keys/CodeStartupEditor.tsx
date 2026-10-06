import { useCallback, useState } from 'react'
import { Input, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { mergeStartupConfig, otherStartupConfig, readClaudeConfig } from '../../utils/claudeConfig'
import { useModelEditorActions, type ModelEditorActions } from './ModelEditorView'
import ModelHelp from './ModelHelp'
import ModelViewHeader from './ModelViewHeader'
import styles from './ModelMappingEditor.module.css'

const { Text } = Typography
export default function CodeStartupEditor({
  value,
  onCommit,
  initialDraft,
  onBack,
  onActionsChange,
}: {
  value: string
  onCommit: (value: string) => void
  initialDraft?: string
  onBack: (draft: string, dirty: boolean) => void
  onActionsChange: (actions: ModelEditorActions | null) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(() =>
    initialDraft ?? (readClaudeConfig(value).valid ? otherStartupConfig(value) : value),
  )
  const [error, setError] = useState('')
  const confirm = useCallback(() => {
    const merged = mergeStartupConfig(value, draft)
    if (merged === undefined) {
      setError(t('keys.configJsonInvalid'))
      return
    }
    const config = readClaudeConfig(merged).config
    const invalid = Object.keys(config).filter((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    const native = Object.keys(config).filter((key) =>
      ['modelPicker', 'availableModels', 'modelOverrides'].includes(key),
    )
    if (invalid.length || native.length) {
      setError(
        t(native.length ? 'keys.nativeSettingsUnsupported' : 'keys.invalidEnvNames', {
          fields: (native.length ? native : invalid).join(', '),
        }),
      )
      return
    }
    onCommit(merged)
  }, [draft, value, t, onCommit])
  const back = useCallback(() => onBack(draft, mergeStartupConfig(value, draft) !== JSON.stringify(readClaudeConfig(value).config, null, 2)), [draft, value, onBack])
  useModelEditorActions(onActionsChange, {
    confirm,
    back,
    confirmText: t('keys.applyModelDraft'),
  })
  return (
    <div className={styles.manager}>
      <ModelViewHeader title={`Claude Code · ${t('keys.otherStartupSettings')}`} onBack={back} extra={<ModelHelp
          label={t('keys.otherStartupSettings')}
          text={t('keys.otherStartupSettingsHint')}
        />} />
      <Input.TextArea
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          setError('')
        }}
        autoSize={{ minRows: 12, maxRows: 20 }}
        spellCheck={false}
        className={styles.jsonEditor}
        aria-label={t('keys.otherStartupSettings')}
      />
      {error && (
        <Text type='danger' className={styles.inlineNotice}>
          {error}
        </Text>
      )}
    </div>
  )
}
