import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Collapse, Input, Select, Switch, Tooltip, Typography } from 'antd'
import { CodeOutlined, DesktopOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import {
  CLIENT_KIND_CONFIGS,
  type ClientKind,
  type CliConfig,
  type ClientConfig,
} from '@shared/types'
import { getApi } from '../../api'
import type {
  ClientCatalog,
  ClientModel,
  ClientModelConfig,
  ClientRole,
  ModelMappingFields,
} from '../../utils/modelMapping'
import { CLIENT_ROLES, ROLE_ROUTE_IDS } from '../../utils/modelMapping'
import { readClaudeConfig } from '../../utils/claudeConfig'
import { readQueryUserAgent, rememberQueryUserAgent } from '../../utils/modelQueryUserAgent'
import CodeModelField from './CodeModelField'
import CodeStartupEditor from './CodeStartupEditor'
import ModelCatalogManager, { type ModelCatalogDraft } from './ModelCatalogManager'
import ModelHelp from './ModelHelp'
import ModelViewHeader from './ModelViewHeader'
import { useModelEditorActions, type ModelEditorActions } from './ModelEditorView'
import styles from './ModelMappingEditor.module.css'

const { Text } = Typography
interface Props {
  types: ClientKind[]
  value: ModelMappingFields
  onChange: (value: ModelMappingFields) => void
  claudeConfigJson: string
  onClaudeConfigChange: (json: string) => void
  globalClaudeConfig: CliConfig
  previewJson: string
  providerId?: string
  apiKeyId?: string
  draftKeyValue: string
  clientConfigs: Partial<Record<ClientKind, ClientConfig>>
  errorClientKind?: ClientKind
  onEditorActionsChange: (actions: ModelEditorActions | null) => void
  onPendingDraftChange: (pending: boolean) => void
}
type View =
  | { type: 'catalog'; kind: ClientKind; source?: 'provider' | 'custom'; identity: string }
  | { type: 'startup' | 'preview' }
const CODE_TIER_FIELDS: Array<[ClientRole, string, string]> = [
  ['sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME'],
  ['opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME'],
  ['haiku', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME'],
  ['fable', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME'],
]
const forwardLabel = (mode: ClientModelConfig['forwardMode']) =>
  `keys.forward${mode[0].toUpperCase() + mode.slice(1)}`

function LaunchPreview({
  json,
  onClose,
  onActionsChange,
}: {
  json: string
  onClose: () => void
  onActionsChange: Props['onEditorActionsChange']
}) {
  const { t } = useTranslation()
  useModelEditorActions(onActionsChange, {
    back: onClose,
  })
  return (
    <div className={styles.manager}>
      <ModelViewHeader
        title={`Claude Code · ${t('keys.configPreview')}`}
        onBack={onClose}
        extra={<Text copyable={{ text: json }}>{t('common.copy')}</Text>}
      />
      <Input.TextArea
        value={json}
        readOnly
        autoSize={{ minRows: 12, maxRows: 20 }}
        spellCheck={false}
        className={styles.jsonEditor}
        aria-label={t('keys.configPreview')}
      />
    </div>
  )
}

export default function ModelMappingEditor({
  types,
  value,
  onChange,
  claudeConfigJson,
  onClaudeConfigChange,
  globalClaudeConfig,
  previewJson,
  providerId,
  apiKeyId,
  draftKeyValue,
  clientConfigs,
  errorClientKind,
  onEditorActionsChange,
  onPendingDraftChange,
}: Props) {
  const { t, i18n } = useTranslation()
  const [expanded, setExpanded] = useState<string[]>([])
  const [view, setView] = useState<View | null>(null)
  const [catalogDrafts, setCatalogDrafts] = useState<
    Partial<Record<ClientKind, { identity: string; draft: ModelCatalogDraft; dirty: boolean }>>
  >({})
  const [startupDraft, setStartupDraft] = useState<{ draft: string; dirty: boolean }>()
  const [queryAgents, setQueryAgents] = useState<
    Partial<Record<ClientKind, { providerId: string; value: string; ready: boolean }>>
  >({})
  const agentRevisions = useRef<Partial<Record<ClientKind, number>>>({})
  const [catalogs, setCatalogs] = useState<
    Partial<Record<ClientKind, { identity: string; result: ClientCatalog }>>
  >({})
  const [loading, setLoading] = useState<Partial<Record<ClientKind, boolean>>>({})
  const [queryErrors, setQueryErrors] = useState<
    Partial<Record<ClientKind, { identity: string; error: string }>>
  >({})
  const routeIdentities = useMemo(
    () =>
      Object.fromEntries(
        CLIENT_KIND_CONFIGS.map(({ kind }) => [
          kind,
          JSON.stringify([providerId, apiKeyId, draftKeyValue, clientConfigs[kind] ?? null]),
        ]),
      ) as Record<ClientKind, string>,
    [providerId, apiKeyId, draftKeyValue, clientConfigs],
  )
  const agentFor = (kind: ClientKind) =>
    queryAgents[kind]?.providerId === providerId
      ? (queryAgents[kind]?.value ?? '')
      : (clientConfigs[kind]?.proxyUserAgent ?? '')
  const identities = Object.fromEntries(
    CLIENT_KIND_CONFIGS.map(({ kind }) => [
      kind,
      JSON.stringify([routeIdentities[kind], agentFor(kind)]),
    ]),
  ) as Record<ClientKind, string>
  const latestIdentity = useRef(identities)
  latestIdentity.current = identities
  const requestVersions = useRef<Partial<Record<ClientKind, number>>>({})
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const { config: codeConfig, valid: validCodeConfig } = readClaudeConfig(claudeConfigJson)
  const discovery =
    'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY' in codeConfig
      ? codeConfig.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY
      : (globalClaudeConfig.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY ?? '1')
  const canLoad = Boolean(providerId && draftKeyValue.trim())
  const closeView = useCallback(() => setView(null), [])
  useEffect(() => {
    if (errorClientKind) setExpanded([errorClientKind])
  }, [errorClientKind])
  useEffect(() => {
    if (
      view?.type === 'catalog' &&
      (!types.includes(view.kind) || view.identity !== routeIdentities[view.kind])
    )
      setView(null)
    if (view && view.type !== 'catalog' && !types.includes('claude_code')) setView(null)
  }, [view, types, routeIdentities])
  useEffect(() => {
    if (!providerId) return
    let active = true
    for (const kind of types) {
      const revision = (agentRevisions.current[kind] ?? 0) + 1
      agentRevisions.current[kind] = revision
      const fallback = clientConfigs[kind]?.proxyUserAgent ?? ''
      setQueryAgents((previous) => ({
        ...previous,
        [kind]: { providerId, value: fallback, ready: false },
      }))
      void readQueryUserAgent(providerId, kind, fallback)
        .then((agent) => {
          if (active && (agentRevisions.current[kind] ?? 0) === revision)
            setQueryAgents((previous) => ({
              ...previous,
              [kind]: { providerId, value: agent, ready: true },
            }))
        })
        .catch((error) => {
          if (active && (agentRevisions.current[kind] ?? 0) === revision) {
            setQueryAgents((previous) => ({
              ...previous,
              [kind]: { providerId, value: fallback, ready: true },
            }))
            setQueryErrors((previous) => ({
              ...previous,
              [kind]: { identity: latestIdentity.current[kind], error: String(error) },
            }))
          }
        })
    }
    return () => {
      active = false
    }
  }, [providerId, types, clientConfigs])
  const hasPending =
    Boolean(startupDraft?.dirty && types.includes('claude_code')) ||
    types.some(
      (kind) =>
        catalogDrafts[kind]?.identity === routeIdentities[kind] && catalogDrafts[kind]?.dirty,
    )
  useEffect(() => {
    onPendingDraftChange(hasPending)
    return () => onPendingDraftChange(false)
  }, [hasPending, onPendingDraftChange])
  const changeAgent = (kind: ClientKind, agent: string) => {
    if (!providerId) return
    agentRevisions.current[kind] = (agentRevisions.current[kind] ?? 0) + 1
    requestVersions.current[kind] = (requestVersions.current[kind] ?? 0) + 1
    setLoading((previous) => ({ ...previous, [kind]: false }))
    setQueryAgents((previous) => ({
      ...previous,
      [kind]: { providerId, value: agent, ready: true },
    }))
  }
  const applyAgent = async (kind: ClientKind, agent: string) => {
    if (!providerId) return
    const revision = agentRevisions.current[kind] ?? 0
    try {
      await rememberQueryUserAgent(providerId, kind, agent)
    } catch (error) {
      if (mounted.current && agentRevisions.current[kind] === revision)
        setQueryErrors((previous) => ({
          ...previous,
          [kind]: { identity: latestIdentity.current[kind], error: String(error) },
        }))
    }
  }

  const loadCatalog = useCallback(
    async (kind: ClientKind) => {
      if (
        !providerId ||
        !draftKeyValue.trim() ||
        queryAgents[kind]?.providerId !== providerId ||
        !queryAgents[kind]?.ready
      )
        return
      const userAgent = agentFor(kind).trim()
      const identity = latestIdentity.current[kind]
      const version = (requestVersions.current[kind] ?? 0) + 1
      requestVersions.current[kind] = version
      setLoading((previous) => ({ ...previous, [kind]: true }))
      setQueryErrors((previous) => ({ ...previous, [kind]: undefined }))
      const isCurrent = () =>
        mounted.current &&
        latestIdentity.current[kind] === identity &&
        requestVersions.current[kind] === version
      try {
        await rememberQueryUserAgent(providerId, kind, userAgent)
        if (!isCurrent()) return
        const result = await getApi().provider.modelCatalogPreview({
          providerId,
          apiKeyId,
          keyValue: draftKeyValue,
          clientKind: kind,
          clientConfigs,
          userAgent,
        })
        if (isCurrent()) setCatalogs((previous) => ({ ...previous, [kind]: { identity, result } }))
      } catch (error) {
        if (isCurrent())
          setQueryErrors((previous) => ({
            ...previous,
            [kind]: { identity, error: String(error) },
          }))
      } finally {
        if (mounted.current && requestVersions.current[kind] === version)
          setLoading((previous) => ({ ...previous, [kind]: false }))
      }
    },
    [providerId, apiKeyId, draftKeyValue, clientConfigs, queryAgents],
  )
  const viewKind = view?.type === 'catalog' ? view.kind : undefined
  const loadManagedCatalog = useCallback(async () => {
    if (viewKind) await loadCatalog(viewKind)
  }, [viewKind, loadCatalog])
  const commitCatalog = useCallback(
    (patch: Pick<ClientModelConfig, 'catalogMode' | 'models'>) => {
      if (!viewKind) return
      onChange({
        ...value,
        clients: { ...value.clients, [viewKind]: { ...value.clients[viewKind], ...patch } },
      })
      setCatalogDrafts((previous) => ({ ...previous, [viewKind]: undefined }))
      setView(null)
    },
    [viewKind, value, onChange],
  )
  const commitStartup = useCallback(
    (json: string) => {
      onClaudeConfigChange(json)
      setStartupDraft(undefined)
      setView(null)
    },
    [onClaudeConfigChange],
  )
  const backStartup = useCallback((draft: string, dirty: boolean) => {
    setStartupDraft({ draft, dirty })
    setView(null)
  }, [])
  const backCatalog = useCallback(
    (draft: ModelCatalogDraft, dirty: boolean) => {
      if (viewKind)
        setCatalogDrafts((previous) => ({
          ...previous,
          [viewKind]: { identity: routeIdentities[viewKind], draft, dirty },
        }))
      setView(null)
    },
    [viewKind, routeIdentities],
  )
  const catalogFor = (kind: ClientKind) =>
    catalogs[kind]?.identity === identities[kind] ? catalogs[kind]?.result : undefined
  const errorFor = (kind: ClientKind) =>
    queryErrors[kind]?.identity === identities[kind] ? queryErrors[kind]?.error : undefined
  const modelsFor = (kind: ClientKind) => {
    const client = value.clients[kind]
    if (client.catalogMode === 'custom') return client.models
    return [
      ...new Map(
        [
          ...(catalogFor(kind)?.models ?? []),
          ...(client.catalogMode === 'append' ? client.models : []),
        ].map((model) => [model.id, model]),
      ).values(),
    ]
  }
  // Claude Code's tier slots are the client's own startup variables: pinning
  // one makes the client show that model in its picker and status line. A
  // model flagged 1M is pinned with the `[1m]` spelling.
  const codeOptions = (kind: ClientKind): ClientModel[] =>
    modelsFor(kind).map((model) => ({
      ...model,
      id: model.supports1m ? `${model.id}[1m]` : model.id,
    }))
  const applyTierModel = (json: string, modelKey: string, nameKey: string) => {
    const { config } = readClaudeConfig(json)
    const value = typeof config[modelKey] === 'string' ? String(config[modelKey]) : ''
    const base = value.replace(/\[1m\]$/i, '')
    const match = modelsFor('claude_code').find((model) => model.id === base)
    const next: Record<string, unknown> = { ...config }
    // The display-name variable keeps the client's own labels readable.
    if (value && match) next[nameKey] = match.displayName || base
    else delete next[nameKey]
    onClaudeConfigChange(JSON.stringify(next, null, 2))
    // Keep the chosen model in the pool so the pickers still offer it later.
    if (match) rememberModel('claude_code', match)
  }
  const rememberModel = (kind: ClientKind, model: ClientModel) => {
    const current = value.clients[kind]
    if (current.models.some((entry) => entry.id === model.id)) return
    update(kind, {
      models: [...current.models, model],
      catalogMode: current.catalogMode === 'provider' ? 'append' : current.catalogMode,
    })
  }
  const update = (kind: ClientKind, patch: Partial<ClientModelConfig>) =>
    onChange({
      ...value,
      clients: { ...value.clients, [kind]: { ...value.clients[kind], ...patch } },
    })
  // Assigning a role to a model that is not in the saved list promotes it, so
  // the gateway can label the route and mark its 1M support.
  const assignRole = (kind: ClientKind, role: ClientRole, modelId: string) => {
    const current = value.clients[kind]
    const fromList = modelsFor(kind).find((model) => model.id === modelId)
    const known = current.models.some((model) => model.id === modelId)
    const models = modelId && !known && fromList ? [...current.models, fromList] : current.models
    const catalogMode =
      current.catalogMode === 'provider' && models.length ? 'append' : current.catalogMode
    update(kind, { roles: { ...current.roles, [role]: modelId }, models, catalogMode })
  }
  const updateAuto = (patch: Partial<ModelMappingFields['autoMode']>) =>
    onChange({ ...value, autoMode: { ...value.autoMode, ...patch } })
  const help = (label: string, text: string) => <ModelHelp label={t(label)} text={t(text)} />

  if (view?.type === 'catalog')
    return (
      <ModelCatalogManager
        label={CLIENT_KIND_CONFIGS.find((client) => client.kind === view.kind)?.label ?? view.kind}
        value={value.clients[view.kind]}
        initialSource={view.source}
        initialDraft={
          catalogDrafts[view.kind]?.identity === routeIdentities[view.kind]
            ? catalogDrafts[view.kind]?.draft
            : undefined
        }
        catalog={catalogFor(view.kind)}
        loading={Boolean(loading[view.kind])}
        canLoad={canLoad}
        queryError={errorFor(view.kind)}
        onLoad={loadManagedCatalog}
        onCommit={commitCatalog}
        onBack={backCatalog}
        userAgent={agentFor(view.kind)}
        userAgentReady={Boolean(
          queryAgents[view.kind]?.providerId === providerId && queryAgents[view.kind]?.ready,
        )}
        onUserAgentChange={(agent) => changeAgent(view.kind, agent)}
        onUserAgentApply={(agent) => void applyAgent(view.kind, agent)}
        onActionsChange={onEditorActionsChange}
      />
    )
  if (view?.type === 'startup')
    return (
      <CodeStartupEditor
        value={claudeConfigJson}
        initialDraft={startupDraft?.draft}
        onCommit={commitStartup}
        onBack={backStartup}
        onActionsChange={onEditorActionsChange}
      />
    )
  if (view?.type === 'preview')
    return (
      <LaunchPreview
        json={previewJson}
        onClose={closeView}
        onActionsChange={onEditorActionsChange}
      />
    )

  return (
    <div className={styles.editor}>
      {hasPending && (
        <div className={styles.pendingNotice}>
          <Text type='warning'>{t('keys.pendingModelDraft')}</Text>
          <Button
            type='text'
            size='small'
            onClick={() => {
              setStartupDraft(undefined)
              setCatalogDrafts({})
            }}
          >
            {t('keys.discardModelDraft')}
          </Button>
        </div>
      )}
      <Collapse
        accordion
        activeKey={expanded}
        onChange={(keys) => setExpanded(Array.isArray(keys) ? keys : [String(keys)])}
        className={styles.clients}
        items={CLIENT_KIND_CONFIGS.filter((client) => types.includes(client.kind)).map((client) => {
          const kind = client.kind
          const current = value.clients[kind]
          const fetched = catalogFor(kind)
          const models = modelsFor(kind)
          const codeDefault =
            typeof codeConfig.ANTHROPIC_MODEL === 'string' ? codeConfig.ANTHROPIC_MODEL : ''
          const defaultInvalid =
            current.catalogMode === 'custom' &&
            Boolean(
              kind === 'codex'
                ? current.defaultModel && !models.some((model) => model.id === current.defaultModel)
                : kind === 'claude_code' &&
                    codeDefault &&
                    !['haiku', 'sonnet', 'opus'].includes(codeDefault) &&
                    !Object.values(ROLE_ROUTE_IDS).includes(codeDefault) &&
                    !models.some((model) => model.id === codeDefault),
            )
          const changed =
            current.catalogMode !== 'provider' ||
            current.forwardMode !== 'follow' ||
            current.defaultModel ||
            (kind === 'claude_code' && (Object.keys(codeConfig).length || value.autoMode.enabled))
          const summary = changed
            ? [
                kind !== 'grok' && current.catalogMode !== 'provider'
                  ? t(
                      current.catalogMode === 'custom'
                        ? 'keys.sourceCustom'
                        : 'keys.sourceSupplemented',
                    )
                  : '',
                current.forwardMode !== 'follow' ? t(forwardLabel(current.forwardMode)) : '',
                (kind === 'grok'
                  ? current.defaultModel
                  : kind === 'claude_code'
                    ? (models.find(
                        (model) => model.id === codeDefault || `${model.id}[1m]` === codeDefault,
                      )?.displayName ?? codeDefault)
                    : current.defaultModel) || '',
                kind === 'claude_code' && value.autoMode.enabled ? t('keys.classifierEnabled') : '',
                kind === 'claude_code' && Object.keys(codeConfig).length && !codeDefault
                  ? t('keys.startupConfigured')
                  : '',
              ]
                .filter(Boolean)
                .join(' · ') || t('keys.defaultSummary')
            : t('keys.defaultSummary')
          return {
            key: kind,
            label: (
              <div className={styles.clientHeader}>
                <span className={styles.clientTitle}>
                  {client.form === 'process_injection' ? <CodeOutlined /> : <DesktopOutlined />}
                  {client.label}
                </span>
                <span className={styles.summary}>{summary}</span>
              </div>
            ),
            children: (
              <div className={styles.clientBody}>
                <section className={styles.clientSection}>
                  <div className={styles.sectionHead}>
                    <Text strong>{t('keys.clientModelsTitle')}</Text>
                    {help(
                      'keys.clientModelsTitle',
                      kind === 'claude_code'
                        ? 'keys.codeCatalogBoundary'
                        : kind === 'grok'
                          ? 'keys.grokClientModelHint'
                          : 'keys.desktopModelsApplyHint',
                    )}
                  </div>
                  {kind === 'grok' ? (
                    <div className={styles.fieldRow}>
                      <span>{t('keys.startupModel')}</span>
                      <Input
                        value={current.defaultModel}
                        placeholder='grok-4.5'
                        aria-label='Grok Build model'
                        onChange={(event) => update(kind, { defaultModel: event.target.value })}
                      />
                    </div>
                  ) : (
                    <>
                      <div className={styles.fieldRow}>
                        <span>
                          {t('keys.modelPool')} {help('keys.modelPool', 'keys.modelPoolHint')}
                        </span>
                        <Text type='secondary' className={styles.poolSummary}>
                          {t('keys.modelPoolCount', { count: models.length })}
                        </Text>
                        <Button
                          onClick={() =>
                            setView({ type: 'catalog', kind, identity: routeIdentities[kind] })
                          }
                        >
                          {t('keys.manageModels')}
                        </Button>
                      </div>
                      {fetched?.fromCache && (
                        <Tooltip
                          title={`${new Date(fetched.fetchedAt).toLocaleString(i18n.language === 'zh' ? 'zh-CN' : 'en-US')}${fetched.error ? ` · ${fetched.error}` : ''}`}
                        >
                          <span className={fetched.error ? styles.warning : styles.cacheBadge}>
                            {t('keys.catalogCachedShort')}
                          </span>
                        </Tooltip>
                      )}
                      {kind === 'codex' && (
                        <div className={styles.fieldRow}>
                          <span>{t('keys.processDefaultModel')}</span>
                          <Select
                            allowClear
                            value={current.defaultModel || undefined}
                            status={defaultInvalid ? 'error' : undefined}
                            className={styles.fullWidth}
                            placeholder={t('keys.clientNativeDefault')}
                            aria-label={`${client.label} ${t('keys.processDefaultModel')}`}
                            showSearch={{ optionFilterProp: 'label' }}
                            options={[
                              ...models,
                              ...(current.defaultModel &&
                              !models.some((model) => model.id === current.defaultModel)
                                ? [{ id: current.defaultModel, displayName: current.defaultModel }]
                                : []),
                            ].map((model) => ({
                              value: model.id,
                              label: model.displayName || model.id,
                            }))}
                            onChange={(defaultModel) =>
                              update(kind, { defaultModel: defaultModel ?? '' })
                            }
                          />
                          {!fetched && current.catalogMode !== 'custom' && (
                            <Tooltip title={t('keys.catalogDraftQueryHint')}>
                              <Button
                                type='text'
                                icon={<ReloadOutlined />}
                                loading={loading[kind]}
                                disabled={!canLoad || !queryAgents[kind]?.ready}
                                aria-label={t('keys.catalogLoad')}
                                onClick={() => void loadCatalog(kind)}
                              />
                            </Tooltip>
                          )}
                        </div>
                      )}
                      {kind === 'claude_desktop' && (
                        <div className={styles.fieldRow}>
                          <span>
                            {t('keys.roleSlots')} {help('keys.roleSlots', 'keys.roleSlotsHint')}
                          </span>
                          <div className={styles.roleFields}>
                            {CLIENT_ROLES.map((role) => (
                              <Select
                                key={role}
                                allowClear
                                value={current.roles[role] || undefined}
                                className={styles.roleSelect}
                                placeholder={t(`keys.role${role[0].toUpperCase() + role.slice(1)}`)}
                                aria-label={`${client.label} ${t('keys.roleSlots')} ${role}`}
                                showSearch={{ optionFilterProp: 'label' }}
                                options={models.map((model) => ({
                                  value: model.id,
                                  label: model.displayName || model.id,
                                }))}
                                onChange={(modelId) => assignRole(kind, role, modelId ?? '')}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                      {kind === 'claude_code' && (
                        <>
                          {CODE_TIER_FIELDS.map(([role, modelKey, nameKey]) => {
                            const label = t(`keys.role${role[0].toUpperCase() + role.slice(1)}`)
                            return (
                              <div className={styles.fieldRow} key={modelKey}>
                                <span>
                                  {label} {help(modelKey, 'keys.codeTierEnvHint')}
                                </span>
                                <CodeModelField
                                  envKey={modelKey}
                                  label={label}
                                  configJson={claudeConfigJson}
                                  globalConfig={globalClaudeConfig}
                                  models={codeOptions(kind)}
                                  onChange={(json) => applyTierModel(json, modelKey, nameKey)}
                                />
                              </div>
                            )
                          })}
                          <div className={styles.fieldRow}>
                            <span>{t('keys.processDefaultModel')}</span>
                            <CodeModelField
                              envKey='ANTHROPIC_MODEL'
                              label={t('keys.processDefaultModel')}
                              configJson={claudeConfigJson}
                              globalConfig={globalClaudeConfig}
                              models={codeOptions(kind)}
                              invalid={defaultInvalid}
                              onChange={onClaudeConfigChange}
                            />
                          </div>
                          {!validCodeConfig && (
                            <Text type='danger' className={styles.inlineNotice}>
                              {t('keys.processModelsInvalidConfig')}
                            </Text>
                          )}
                          {!['1', 'true'].includes(String(discovery)) && (
                            <div className={styles.discoveryNotice}>
                              <Text type='warning'>{t('keys.discoveryDisabled')}</Text>
                              <Button
                                type='link'
                                size='small'
                                disabled={!validCodeConfig}
                                onClick={() =>
                                  onClaudeConfigChange(
                                    JSON.stringify(
                                      {
                                        ...codeConfig,
                                        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
                                      },
                                      null,
                                      2,
                                    ),
                                  )
                                }
                              >
                                {t('keys.enableDiscovery')}
                              </Button>
                            </div>
                          )}
                          <div className={styles.secondaryActions}>
                            <Button
                              type='link'
                              size='small'
                              onClick={() => setView({ type: 'startup' })}
                            >
                              {t('keys.otherStartupSettings')}…
                            </Button>
                            <Tooltip title={t('keys.previewDraftHint')}>
                              <Button
                                type='link'
                                size='small'
                                onClick={() => setView({ type: 'preview' })}
                              >
                                {t('keys.viewLaunchPreview')}
                              </Button>
                            </Tooltip>
                          </div>
                        </>
                      )}
                      {defaultInvalid && (
                        <Text type='danger' className={styles.inlineNotice}>
                          {t('keys.clientDefaultInvalid')}
                        </Text>
                      )}
                      {errorFor(kind) && (
                        <Text type='danger' className={styles.inlineNotice}>
                          {errorFor(kind)}
                        </Text>
                      )}
                    </>
                  )}
                </section>
                <section className={styles.gatewaySection}>
                  <div className={styles.fieldRow}>
                    <span>
                      {t('keys.gatewayScope')}{' '}
                      {help(
                        'keys.gatewayScope',
                        `keys.forward${current.forwardMode[0].toUpperCase() + current.forwardMode.slice(1)}Hint`,
                      )}
                    </span>
                    <Select
                      value={current.forwardMode}
                      aria-label={`${client.label} ${t('keys.forwardMode')}`}
                      options={(current.forwardMode === 'family'
                        ? (['follow', 'fixed', 'family'] as const)
                        : (['follow', 'fixed'] as const)
                      ).map((mode) => ({ value: mode, label: t(forwardLabel(mode)) }))}
                      onChange={(forwardMode) => update(kind, { forwardMode })}
                    />
                  </div>
                  {current.forwardMode === 'fixed' && (
                    <div className={styles.fieldRow}>
                      <span>{t('keys.upstreamModel')}</span>
                      <Input
                        value={current.upstreamModel}
                        placeholder={t('keys.clientModelId')}
                        aria-label={`${client.label} ${t('keys.upstreamModel')}`}
                        onChange={(event) => update(kind, { upstreamModel: event.target.value })}
                      />
                    </div>
                  )}
                  {kind === 'claude_code' && (
                    <details className={styles.disclosure}>
                      <summary>
                        {t('keys.advancedForwarding')}
                        {(current.forwardMode === 'family' || value.autoMode.enabled) && (
                          <span className={styles.summary}>
                            {' '}
                            ·{' '}
                            {[
                              current.forwardMode === 'family' ? t('keys.familyEnabled') : '',
                              value.autoMode.enabled ? t('keys.classifierEnabled') : '',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        )}
                      </summary>
                      <div className={styles.advancedFields}>
                        <div className={styles.toggleRow}>
                          <span>
                            {t('keys.familyForwarding')}{' '}
                            {help('keys.familyForwarding', 'keys.forwardFamilyHint')}
                          </span>
                          <Switch
                            checked={current.forwardMode === 'family'}
                            aria-label={t('keys.familyForwarding')}
                            onChange={(enabled) =>
                              update(kind, { forwardMode: enabled ? 'family' : 'follow' })
                            }
                          />
                        </div>
                        {current.forwardMode === 'family' && (
                          <div className={styles.familyFields}>
                            {(['haiku', 'sonnet', 'opus'] as const).map((family) => (
                              <div className={styles.fieldRow} key={family}>
                                <span>{family[0].toUpperCase() + family.slice(1)}</span>
                                <Input
                                  value={current[family]}
                                  placeholder={t('keys.clientModelId')}
                                  aria-label={`Claude Code ${family} ${t('keys.upstreamModel')}`}
                                  onChange={(event) =>
                                    update(kind, { [family]: event.target.value })
                                  }
                                />
                              </div>
                            ))}
                          </div>
                        )}
                        <div className={styles.toggleRow}>
                          <span>
                            {t('keys.autoMode')} {help('keys.autoMode', 'keys.autoModeHint')}
                          </span>
                          <Switch
                            checked={value.autoMode.enabled}
                            aria-label={t('keys.autoMode')}
                            onChange={(enabled) => updateAuto({ enabled })}
                          />
                        </div>
                        {value.autoMode.enabled && (
                          <>
                            <div className={styles.fieldRow}>
                              <span>
                                {t('keys.autoModeModel')}{' '}
                                {help('keys.autoModeModel', 'keys.autoModeModelHint')}
                              </span>
                              <Input
                                value={value.autoMode.model}
                                placeholder={t('keys.autoModeModelPlaceholder')}
                                aria-label={t('keys.autoModeModel')}
                                onChange={(event) => updateAuto({ model: event.target.value })}
                              />
                            </div>
                            <div className={styles.fieldRow}>
                              <span>
                                {t('keys.autoModeThinking')}{' '}
                                {help('keys.autoModeThinking', 'keys.autoModeThinkingHint')}
                              </span>
                              <Select
                                value={value.autoMode.thinking}
                                aria-label={t('keys.autoModeThinking')}
                                options={(['low', 'disabled', 'preserve'] as const).map(
                                  (thinking) => ({
                                    value: thinking,
                                    label: t(
                                      `keys.autoModeThinking${thinking[0].toUpperCase() + thinking.slice(1)}`,
                                    ),
                                  }),
                                )}
                                onChange={(thinking) => updateAuto({ thinking })}
                              />
                            </div>
                          </>
                        )}
                      </div>
                    </details>
                  )}
                </section>
              </div>
            ),
          }
        })}
      />
    </div>
  )
}
