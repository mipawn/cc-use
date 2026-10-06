import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Input, Tooltip, Typography } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { ClientCatalog, ClientModel, ClientModelConfig } from '../../utils/modelMapping'
import { useModelEditorActions, type ModelEditorActions } from './ModelEditorView'
import ModelHelp from './ModelHelp'
import ModelViewHeader from './ModelViewHeader'
import UserAgentField from '../UserAgentField'
import styles from './ModelMappingEditor.module.css'

const { Text } = Typography
const EMPTY_MODELS: ClientModel[] = []
const unique = (models: ClientModel[]) => [
  ...new Map(models.map((model) => [model.id, model])).values(),
]

export interface ModelCatalogDraft {
  source: 'provider' | 'custom'
  additions: ClientModel[]
  selected: ClientModel[]
  customCandidates: ClientModel[]
  selectionTouched: boolean
  manual: string | null
  search: string
}

interface Props {
  label: string
  value: ClientModelConfig
  initialSource?: 'provider' | 'custom'
  initialDraft?: ModelCatalogDraft
  catalog?: ClientCatalog
  loading: boolean
  canLoad: boolean
  queryError?: string
  onLoad: () => Promise<void>
  onCommit: (patch: Pick<ClientModelConfig, 'catalogMode' | 'models'>) => void
  onBack: (draft: ModelCatalogDraft, dirty: boolean) => void
  userAgent: string
  userAgentReady: boolean
  onUserAgentChange: (value: string) => void
  onUserAgentApply: (value: string) => void
  onActionsChange: (actions: ModelEditorActions | null) => void
}

export default function ModelCatalogManager({
  label,
  value,
  initialSource,
  initialDraft,
  catalog,
  loading,
  canLoad,
  queryError,
  onLoad,
  onCommit,
  onBack,
  userAgent,
  userAgentReady,
  onUserAgentChange,
  onUserAgentApply,
  onActionsChange,
}: Props) {
  const { t, i18n } = useTranslation()
  const [source, setSource] = useState<'provider' | 'custom'>(
    initialSource ??
      initialDraft?.source ??
      (value.catalogMode === 'custom' ? 'custom' : 'provider'),
  )
  const [additions, setAdditions] = useState<ClientModel[]>(
    initialDraft?.additions ?? (value.catalogMode === 'append' ? value.models : []),
  )
  const [selected, setSelected] = useState<ClientModel[]>(
    initialDraft?.selected ??
      (value.catalogMode === 'custom'
        ? value.models
        : unique([...(catalog?.models ?? []), ...value.models])),
  )
  const [customCandidates, setCustomCandidates] = useState<ClientModel[]>(
    initialDraft?.customCandidates ?? (value.catalogMode === 'custom' ? value.models : []),
  )
  const selectionTouched = useRef(initialDraft?.selectionTouched ?? value.catalogMode === 'custom')
  const [manual, setManual] = useState<string | null>(initialDraft?.manual ?? null)
  const [renaming, setRenaming] = useState<string>()
  const [search, setSearch] = useState(initialDraft?.search ?? '')
  const [error, setError] = useState('')
  const base = catalog?.models ?? EMPTY_MODELS
  const effective = unique([...base, ...additions])
  const candidates =
    source === 'provider' ? effective : unique([...effective, ...customCandidates, ...selected])

  useEffect(() => {
    if (catalog && !selectionTouched.current) setSelected(unique([...catalog.models, ...additions]))
  }, [catalog, additions])

  const confirm = useCallback(() => {
    const models =
      source === 'custom'
        ? selected
        : additions.filter((model) => {
            const original = base.find((entry) => entry.id === model.id)
            return (
              !original ||
              (model.displayName || model.id) !== (original.displayName || original.id) ||
              Boolean(model.supports1m)
            )
          })
    if (source === 'custom' && !models.length) {
      setError(t('keys.clientModelsRequired'))
      return
    }
    if (models.some(({ id }) => !id.trim() || /\s/.test(id) || /^https?:\/\//i.test(id))) {
      setError(t('keys.clientModelIdRequired'))
      return
    }
    onCommit({
      catalogMode: source === 'custom' ? 'custom' : models.length ? 'append' : 'provider',
      models,
    })
  }, [source, selected, additions, base, t, onCommit])
  const back = useCallback(() => {
    const mode = source === 'custom' ? 'custom' : additions.length ? 'append' : 'provider'
    const models = source === 'custom' ? selected : additions
    const dirty =
      mode !== value.catalogMode ||
      JSON.stringify(models) !== JSON.stringify(value.models) ||
      Boolean(manual?.trim())
    onBack(
      {
        source,
        additions,
        selected,
        customCandidates,
        selectionTouched: selectionTouched.current,
        manual,
        search,
      },
      dirty,
    )
  }, [
    onBack,
    source,
    additions,
    selected,
    customCandidates,
    manual,
    search,
    value.catalogMode,
    value.models,
  ])
  useModelEditorActions(onActionsChange, {
    confirm,
    back,
    confirmText: t('keys.applyModelDraft'),
  })

  const add = () => {
    const id = manual?.trim() ?? ''
    if (!id || /\s/.test(id) || /^https?:\/\//i.test(id)) {
      setError(t('keys.clientModelIdRequired'))
      return
    }
    const model = candidates.find((entry) => entry.id === id) ?? { id, displayName: '' }
    if (source === 'provider') {
      if (!base.some((entry) => entry.id === id))
        setAdditions((previous) => unique([...previous, model]))
    } else {
      selectionTouched.current = true
      setCustomCandidates((previous) => unique([...previous, model]))
      setSelected((previous) => unique([...previous, model]))
    }
    setSearch('')
    setManual(null)
    setError('')
  }
  const rename = (model: ClientModel, displayName: string) => {
    const next = { ...model, displayName }
    if (source === 'provider') setAdditions((previous) => unique([...previous, next]))
    else {
      selectionTouched.current = true
      setCustomCandidates((previous) => unique([...previous, next]))
      setSelected((previous) => unique([...previous, next]))
    }
  }
  const setOneM = (model: ClientModel, supports1m: boolean) => {
    const next = { ...model, supports1m }
    if (source === 'provider') setAdditions((previous) => unique([...previous, next]))
    else {
      selectionTouched.current = true
      setCustomCandidates((previous) => unique([...previous, next]))
      setSelected((previous) => unique([...previous, next]))
    }
  }
  const visible = candidates.filter((model) =>
    `${model.id} ${model.displayName}`.toLowerCase().includes(search.toLowerCase()),
  )
  const time = catalog
    ? new Date(catalog.fetchedAt).toLocaleString(i18n.language === 'zh' ? 'zh-CN' : 'en-US')
    : ''
  return (
    <div className={styles.manager}>
      <ModelViewHeader
        title={`${label} · ${t('keys.manageModels')}`}
        onBack={back}
        extra={<ModelHelp label={t('keys.clientModelId')} text={t('keys.clientModelsHint')} />}
      />
      <div className={styles.managerToolbar}>
        <div className={styles.sourceButtons}>
          <Button
            type={source === 'provider' ? 'primary' : 'default'}
            onClick={() => {
              setSource('provider')
              setError('')
              setRenaming(undefined)
            }}
          >
            {t('keys.sourceProvider')}
          </Button>
          <Button
            type={source === 'custom' ? 'primary' : 'default'}
            onClick={() => {
              setSource('custom')
              setError('')
              setRenaming(undefined)
            }}
          >
            {t('keys.sourceCustom')}
          </Button>
        </div>
        <Tooltip title={t('keys.catalogDraftQueryHint')}>
          <Button
            icon={<ReloadOutlined />}
            loading={loading}
            disabled={!canLoad || !userAgentReady}
            onClick={() => void onLoad()}
          >
            {t(catalog ? 'keys.catalogRefresh' : 'keys.catalogLoad')}
          </Button>
        </Tooltip>
      </div>
      <div className={styles.queryIdentity}>
        <div className={styles.queryIdentityLabel}>
          User-Agent <ModelHelp label='User-Agent' text={t('keys.queryUaRememberedHint')} />
        </div>
        <UserAgentField
          value={userAgent}
          placeholder={t('keys.modelListUaDefault')}
          onChange={onUserAgentChange}
          onApply={onUserAgentApply}
          disabled={!userAgentReady}
        />
      </div>
      <div className={styles.catalogStatus}>
        <Text type='secondary'>
          {source === 'custom'
            ? t('keys.selectedModelCount', { count: selected.length })
            : t('keys.availableModelCount', { count: effective.length })}
        </Text>
        {catalog && (
          <Tooltip title={`${time}${catalog.error ? ` · ${catalog.error}` : ''}`}>
            <span className={catalog.error ? styles.warning : styles.cacheBadge}>
              {t(catalog.fromCache ? 'keys.catalogCachedShort' : 'keys.catalogFreshShort')}
            </span>
          </Tooltip>
        )}
      </div>
      {!canLoad && (
        <Text type='secondary' className={styles.inlineNotice}>
          {t('keys.catalogKeyRequired')}
        </Text>
      )}
      {queryError && (
        <Text type='danger' className={styles.inlineNotice}>
          {queryError}
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
        {source === 'custom' && (
          <div className={styles.batchActions}>
            <Button
              type='text'
              size='small'
              onClick={() => {
                selectionTouched.current = true
                setSelected(candidates)
                setError('')
              }}
            >
              {t('keys.selectAllModels')}
            </Button>
            <Button
              type='text'
              size='small'
              onClick={() => {
                selectionTouched.current = true
                setSelected([])
              }}
            >
              {t('keys.clearModels')}
            </Button>
          </div>
        )}
      </div>
      <div className={styles.catalogList}>
        {visible.map((model) => {
          const checked = selected.some((entry) => entry.id === model.id)
          const supplied = base.some((entry) => entry.id === model.id)
          return (
            <div className={styles.catalogRow} key={model.id}>
              {source === 'custom' && (
                <Checkbox
                  checked={checked}
                  aria-label={model.id}
                  onChange={(event) => {
                    selectionTouched.current = true
                    setError('')
                    setSelected((previous) =>
                      event.target.checked
                        ? unique([...previous, model])
                        : previous.filter((entry) => entry.id !== model.id),
                    )
                  }}
                />
              )}
              <div className={styles.modelIdentity}>
                <code>{model.id}</code>
                {renaming === model.id ? (
                  <Input
                    size='small'
                    autoFocus
                    value={model.displayName}
                    placeholder={t('keys.clientModelNamePlaceholder')}
                    aria-label={`${model.id} ${t('keys.clientModelName')}`}
                    onChange={(event) => rename(model, event.target.value)}
                    onBlur={() => setRenaming(undefined)}
                    onPressEnter={() => setRenaming(undefined)}
                  />
                ) : model.displayName && model.displayName !== model.id ? (
                  <Text type='secondary'>{model.displayName}</Text>
                ) : null}
              </div>
              {!supplied && <span className={styles.cacheBadge}>{t('keys.addedModelShort')}</span>}
              <Tooltip title={t('keys.supports1mHint')}>
                <Checkbox
                  checked={model.supports1m === true}
                  disabled={source === 'custom' && !checked}
                  aria-label={`${model.id} ${t('keys.supports1m')}`}
                  onChange={(event) => setOneM(model, event.target.checked)}
                >
                  <span className={styles.cacheBadge}>{t('keys.supports1mShort')}</span>
                </Checkbox>
              </Tooltip>
              <Button
                type='text'
                size='small'
                icon={<EditOutlined />}
                disabled={source === 'custom' && !checked}
                aria-label={`${model.id} ${t('keys.renameModel')}`}
                onClick={() => setRenaming(model.id)}
              />
              {source === 'provider' && !supplied && (
                <Button
                  type='text'
                  size='small'
                  danger
                  icon={<DeleteOutlined />}
                  aria-label={`${model.id} ${t('common.delete')}`}
                  onClick={() =>
                    setAdditions((previous) => previous.filter((entry) => entry.id !== model.id))
                  }
                />
              )}
            </div>
          )
        })}
        {!visible.length && (
          <Text type='secondary' className={styles.empty}>
            {loading ? t('keys.catalogLoading') : t('keys.noMatchingModels')}
          </Text>
        )}
      </div>
      {manual === null ? (
        <Button type='text' icon={<PlusOutlined />} onClick={() => setManual('')}>
          {t(source === 'provider' ? 'keys.supplementModel' : 'keys.manualAddModel')}
        </Button>
      ) : (
        <div className={styles.manualModelEntry}>
          <Input
            autoFocus
            value={manual}
            placeholder={t('keys.clientModelManualHint')}
            aria-label={t('keys.clientModelId')}
            onChange={(event) => setManual(event.target.value)}
            onPressEnter={(event) => {
              event.preventDefault()
              add()
            }}
          />
          <Button onClick={add}>{t('keys.clientModelAdd')}</Button>
          <Button type='text' onClick={() => setManual(null)}>
            {t('common.cancel')}
          </Button>
        </div>
      )}
      {error && (
        <Text type='danger' className={styles.inlineNotice}>
          {error}
        </Text>
      )}
    </div>
  )
}
