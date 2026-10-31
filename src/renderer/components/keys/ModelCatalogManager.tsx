import { useCallback, useMemo, useState } from 'react'
import { Button, Checkbox, Input, Tooltip, Typography } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type {
  CatalogMode,
  ClientCatalog,
  ClientModel,
  ClientModelConfig,
} from '../../utils/modelMapping'
import { useModelEditorActions, type ModelEditorActions } from './ModelEditorView'
import styles from './ModelMappingEditor.module.css'

const { Text } = Typography
const EMPTY_MODELS: ClientModel[] = []
const unique = (models: ClientModel[]) => [
  ...new Map(models.map((model) => [model.id, model])).values(),
]
export interface ModelManualEntry {
  id: string
  displayName: string
}
export interface ModelCatalogDraft {
  strategy: CatalogMode
  models: ClientModel[]
  manual: ModelManualEntry | null
  search: string
  selectedOnly: boolean
}
interface Props {
  label: string
  value: ClientModelConfig
  initialDraft?: ModelCatalogDraft
  catalog?: ClientCatalog
  /** Provider management persists a list, not a client's runtime catalog strategy. */
  providerManagement?: boolean
  disabled?: boolean
  onCommit: (patch: Pick<ClientModelConfig, 'catalogMode' | 'models'>) => void
  onBack: (draft: ModelCatalogDraft, dirty: boolean) => void
  onActionsChange: (actions: ModelEditorActions | null) => void
}
export default function ModelCatalogManager({
  value,
  initialDraft,
  catalog,
  providerManagement = false,
  disabled = false,
  onCommit,
  onBack,
  onActionsChange,
}: Props) {
  const { t } = useTranslation()
  const strategy = initialDraft?.strategy ?? value.catalogMode
  const [models, setModels] = useState<ClientModel[]>(initialDraft?.models ?? value.models)
  const [manual, setManual] = useState<ModelManualEntry | null>(initialDraft?.manual ?? null)
  const [renaming, setRenaming] = useState<string>()
  const [search, setSearch] = useState(initialDraft?.search ?? '')
  const [selectedOnly, setSelectedOnly] = useState(initialDraft?.selectedOnly ?? false)
  const [error, setError] = useState('')
  const base = catalog?.models ?? EMPTY_MODELS
  const rows = useMemo(() => unique([...base, ...models]), [base, models])
  const ids = useMemo(() => new Set(models.map((model) => model.id)), [models])
  const suppliedIds = useMemo(() => new Set(base.map((model) => model.id)), [base])
  const setOne = (model: ClientModel) => setModels((previous) => unique([...previous, model]))
  const removeOne = (id: string) =>
    setModels((previous) => previous.filter((model) => model.id !== id))
  const replaceOne = (model: ClientModel) =>
    setModels((previous) => unique([...previous.filter((entry) => entry.id !== model.id), model]))
  const confirm = useCallback(() => {
    if (disabled) return
    // Keep selection independently of strategy. Provider mode ignores it at runtime,
    // but a later explicit switch must not destroy the user's selection draft.
    const next = models.map(({ id, displayName, supports1m }) => ({
      id: id.trim(),
      displayName: displayName.trim() || id.trim(),
      ...(supports1m ? { supports1m: true } : {}),
    }))
    if (!providerManagement && strategy === 'custom' && !next.length) {
      setError(t('keys.clientModelsRequired'))
      return
    }
    if (next.some(({ id }) => !id || /\s/u.test(id) || /^https?:\/\//iu.test(id))) {
      setError(t('keys.clientModelIdRequired'))
      return
    }
    if (new Set(next.map(({ id }) => id)).size !== next.length) {
      setError(t('keys.clientModelDuplicate'))
      return
    }
    onCommit({ catalogMode: strategy, models: next })
  }, [disabled, models, providerManagement, strategy, t, onCommit])
  const back = useCallback(() => {
    const dirty =
      strategy !== value.catalogMode ||
      JSON.stringify(models) !== JSON.stringify(value.models) ||
      Boolean(manual && (manual.id.trim() || manual.displayName.trim()))
    onBack({ strategy, models, manual, search, selectedOnly }, dirty)
  }, [strategy, value.catalogMode, value.models, models, manual, search, selectedOnly, onBack])
  useModelEditorActions(onActionsChange, {
    confirm,
    back,
    confirmText: t(providerManagement ? 'keys.catalogSave' : 'keys.applyModelDraft'),
  })
  const visible = rows.filter(
    (model) =>
      (!selectedOnly || ids.has(model.id)) &&
      `${model.id} ${model.displayName} ${models.find((entry) => entry.id === model.id)?.displayName ?? ''}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  )
  const addManual = () => {
    if (disabled) return
    const id = manual?.id.trim() ?? ''
    if (!id || /\s/u.test(id) || /^https?:\/\//iu.test(id)) {
      setError(t('keys.clientModelIdRequired'))
      return
    }
    if (ids.has(id)) {
      setError(t('keys.clientModelDuplicate'))
      return
    }
    const supplied = base.find((model) => model.id === id)
    setOne({
      id,
      displayName: manual?.displayName.trim() || id,
      ...(supplied?.supports1m ? { supports1m: true } : {}),
    })
    setManual(null)
    setSearch('')
    setError('')
  }
  return (
    <div className={styles.manager}>
      {!providerManagement && (
        <Text type='secondary' className={styles.inlineNotice}>
          {t('keys.savedCatalogHint')}
        </Text>
      )}
      <div className={styles.managerToolbar}>
        <Input
          value={search}
          allowClear
          placeholder={t('keys.searchModels')}
          aria-label={t('keys.searchModels')}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Checkbox
          checked={selectedOnly}
          aria-label={t('keys.selectedOnly')}
          onChange={(event) => setSelectedOnly(event.target.checked)}
        >
          {t('keys.selectedOnly')}
        </Checkbox>
        <Button
          size='small'
          icon={<PlusOutlined />}
          disabled={disabled || manual !== null}
          onClick={() => setManual({ id: '', displayName: '' })}
        >
          {t('keys.manualAddModel')}
        </Button>
      </div>
      <div className={styles.catalogStatus}>
        <Text type='secondary'>{t('keys.selectedModelCount', { count: models.length })}</Text>
        <Button
          type='text'
          size='small'
          disabled={disabled}
          onClick={() => {
            setModels((previous) => unique([...previous, ...visible]))
            setError('')
          }}
        >
          {t('keys.selectAllModels')}
        </Button>
        <Button
          type='text'
          size='small'
          disabled={disabled}
          onClick={() => {
            const visibleIds = new Set(visible.map((model) => model.id))
            setModels((previous) => previous.filter((model) => !visibleIds.has(model.id)))
            setError('')
          }}
        >
          {t('keys.clearModels')}
        </Button>
      </div>
      {manual !== null && (
        <div className={styles.manualModelEntry}>
          <Input
            autoFocus
            disabled={disabled}
            value={manual.id}
            placeholder={t('keys.clientModelManualHint')}
            aria-label={t('keys.clientModelId')}
            onChange={(event) => setManual({ ...manual, id: event.target.value })}
            onPressEnter={(event) => {
              event.preventDefault()
              addManual()
            }}
          />
          <Input
            disabled={disabled}
            value={manual.displayName}
            placeholder={t('keys.clientModelNamePlaceholder')}
            aria-label={t('keys.clientModelName')}
            onChange={(event) => setManual({ ...manual, displayName: event.target.value })}
            onPressEnter={(event) => {
              event.preventDefault()
              addManual()
            }}
          />
          <Button disabled={disabled} onClick={addManual}>
            {t('keys.clientModelAdd')}
          </Button>
          <Button type='text' disabled={disabled} onClick={() => setManual(null)}>
            {t('common.cancel')}
          </Button>
        </div>
      )}
      <div className={styles.catalogList}>
        {visible.map((model) => {
          const configured = models.find((entry) => entry.id === model.id)
          const checked = Boolean(configured)
          return (
            <div className={styles.catalogRow} key={model.id} data-model-row={model.id}>
              <Checkbox
                checked={checked}
                disabled={disabled}
                aria-label={model.id}
                onChange={(event) => {
                  setError('')
                  if (event.target.checked) setOne(configured ?? model)
                  else removeOne(model.id)
                }}
              />
              <div className={styles.modelIdentity}>
                <code>{model.id}</code>
                {renaming === model.id ? (
                  <Input
                    size='small'
                    autoFocus
                    disabled={disabled}
                    value={configured?.displayName ?? model.displayName}
                    placeholder={t('keys.clientModelNamePlaceholder')}
                    aria-label={`${model.id} ${t('keys.clientModelName')}`}
                    onChange={(event) =>
                      replaceOne({ ...(configured ?? model), displayName: event.target.value })
                    }
                    onBlur={() => setRenaming(undefined)}
                    onPressEnter={() => setRenaming(undefined)}
                  />
                ) : (
                  <Text type='secondary'>{configured?.displayName || model.displayName}</Text>
                )}
              </div>
              <span className={styles.cacheBadge}>
                {t(
                  configured
                    ? !catalog || suppliedIds.has(model.id)
                      ? 'keys.catalogConfiguredShort'
                      : 'keys.catalogSavedOnly'
                    : 'keys.catalogCandidateShort',
                )}
              </span>
              <Tooltip title={t('keys.supports1mHint')}>
                <Checkbox
                  checked={configured?.supports1m === true}
                  disabled={disabled || !checked}
                  aria-label={`${model.id} ${t('keys.supports1m')}`}
                  onChange={(event) =>
                    replaceOne({ ...(configured ?? model), supports1m: event.target.checked })
                  }
                >
                  <span className={styles.cacheBadge}>{t('keys.supports1mShort')}</span>
                </Checkbox>
              </Tooltip>
              <Tooltip title={t('keys.renameModel')}>
                <Button
                  type='text'
                  size='small'
                  icon={<EditOutlined />}
                  disabled={disabled || !checked}
                  aria-label={`${model.id} ${t('keys.renameModel')}`}
                  onClick={() => setRenaming(model.id)}
                />
              </Tooltip>
              {configured && (
                <Button
                  type='text'
                  size='small'
                  danger
                  disabled={disabled}
                  icon={<DeleteOutlined />}
                  aria-label={`${model.id} ${t('common.delete')}`}
                  onClick={() => {
                    setError('')
                    removeOne(model.id)
                  }}
                />
              )}
            </div>
          )
        })}
        {!visible.length && (
          <Text type='secondary' className={styles.empty}>
            {t('keys.noMatchingModels')}
          </Text>
        )}
      </div>
      {error && (
        <Text type='danger' className={styles.inlineNotice}>
          {error}
        </Text>
      )}
    </div>
  )
}
