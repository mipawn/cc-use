import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  AutoComplete,
  Badge,
  Button,
  Drawer,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import { AppstoreOutlined, EyeOutlined, UndoOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type {
  ApiKey,
  ClientKind,
  ClientModel,
  ClientProfile,
  ClientProfileConnectionConfig,
  CreateClientProfileInput,
  Provider,
  TerminalLaunchPreview,
  UpdateClientProfileInput,
} from '@shared/types'
import { getClientKindLabel } from '@shared/types'
import { getApi } from '../../api'
import { useAppMessage } from '../../hooks/useAppMessage'
import { useProviderModelCatalogStore } from '../../stores/providerModelCatalogStore'
import { useSettingsStore } from '../../stores/settingsStore'
import {
  CLIENT_ROLES,
  EMPTY_MODEL_MAPPING,
  ROLE_ROUTE_IDS,
  parseModelMapping,
  serializeModelMapping,
  type ClientModelConfig,
} from '../../utils/modelMapping'
import ProviderModelModal from '../providers/ProviderModelModal'
import UserAgentField from '../UserAgentField'
import styles from './ClientProfileDrawer.module.css'

const { Text } = Typography
const { TextArea } = Input

function isValidOptionalHttpUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return true
  try {
    const parsed = new URL(trimmed)
    return (
      ['http:', 'https:'].includes(parsed.protocol) &&
      Boolean(parsed.host) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    )
  } catch {
    return false
  }
}

function parseExtraEnvJson(raw: string): Record<string, string> | null {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const entries: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') return null
      if (key.trim()) entries[key.trim()] = value
    }
    return entries
  } catch {
    return null
  }
}

interface ClientProfileDrawerProps {
  open: boolean
  clientKind: ClientKind
  profile: ClientProfile | null
  providers: Provider[]
  apiKeysByProvider: Record<string, ApiKey[]>
  onClose: () => void
  onCreate: (input: CreateClientProfileInput) => Promise<ClientProfile>
  onUpdate: (input: UpdateClientProfileInput) => Promise<ClientProfile>
}

export default function ClientProfileDrawer({
  open,
  clientKind,
  profile,
  providers,
  apiKeysByProvider,
  onClose,
  onCreate,
  onUpdate,
}: ClientProfileDrawerProps) {
  const { t } = useTranslation()
  const message = useAppMessage()
  const { catalogs, fetchCatalog } = useProviderModelCatalogStore()
  const { globalSettings } = useSettingsStore()

  const isCliClient = clientKind === 'claude_code' || clientKind === 'grok'

  // Active tab inside drawer
  const [activeTab, setActiveTab] = useState<'basic' | 'advanced'>('basic')

  // Core state
  const [name, setName] = useState('')
  const [providerId, setProviderId] = useState('')
  const [apiKeyId, setApiKeyId] = useState('')
  const [isDefault, setIsDefault] = useState(false)

  // Model mapping state (scoped to this clientKind only)
  const [catalogMode, setCatalogMode] = useState<'provider' | 'custom'>('provider')
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState('')
  const [roles, setRoles] = useState<Record<(typeof CLIENT_ROLES)[number], string>>({
    sonnet: '',
    opus: '',
    haiku: '',
    fable: '',
  })
  const [forwardMode, setForwardMode] = useState<'follow' | 'fixed'>('follow')
  const [upstreamModel, setUpstreamModel] = useState('')
  const [autoModeEnabled, setAutoModeEnabled] = useState(false)
  const [autoModeModel, setAutoModeModel] = useState('')

  // Claude Code launch env state
  const [claudePrimaryModel, setClaudePrimaryModel] = useState('')
  const [extraEnvText, setExtraEnvText] = useState('')

  // Connection override state
  const [baseUrl, setBaseUrl] = useState('')
  const [authScheme, setAuthScheme] = useState<'bearer' | 'x-api-key' | 'none'>('bearer')
  const [userAgent, setUserAgent] = useState('')

  // Auxiliary modals & status
  const [saving, setSaving] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [catalogModalOpen, setCatalogModalOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewData, setPreviewData] = useState<TerminalLaunchPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setActiveTab('basic')
    setErrorText(null)
    if (profile) {
      setName(profile.name)
      setProviderId(profile.providerId)
      setApiKeyId(profile.apiKeyId)
      setIsDefault(profile.isDefault)

      const parsed = parseModelMapping(profile.modelConfig)
      const cfg = parsed.clients[clientKind]
      setCatalogMode(cfg.catalogMode === 'custom' ? 'custom' : 'provider')
      setSelectedModelIds(cfg.models.map((item) => item.id))
      setDefaultModel(cfg.defaultModel)
      setRoles({ ...cfg.roles })
      setForwardMode(cfg.forwardMode === 'fixed' ? 'fixed' : 'follow')
      setUpstreamModel(cfg.upstreamModel)
      setAutoModeEnabled(parsed.autoMode.enabled)
      setAutoModeModel(parsed.autoMode.model)

      const env = profile.launchEnv ?? {}
      setClaudePrimaryModel(typeof env.ANTHROPIC_MODEL === 'string' ? env.ANTHROPIC_MODEL : '')
      const extras: Record<string, string> = {}
      for (const [k, v] of Object.entries(env)) {
        if (k !== 'ANTHROPIC_MODEL' && v !== undefined && v !== null) {
          extras[k] = typeof v === 'string' ? v : String(v)
        }
      }
      setExtraEnvText(Object.keys(extras).length > 0 ? JSON.stringify(extras, null, 2) : '')

      setBaseUrl(profile.connectionConfig?.baseUrl ?? '')
      setAuthScheme(profile.connectionConfig?.authScheme ?? 'bearer')
      setUserAgent(profile.connectionConfig?.userAgent ?? '')
    } else {
      const firstProvider = providers.find((item) => item.isActive) ?? providers[0]
      const firstKeys = firstProvider ? apiKeysByProvider[firstProvider.id] ?? [] : []
      const firstKey = firstKeys.find((k) => k.isActive && !k.isExhausted) ?? firstKeys[0]
      setName('')
      setProviderId(firstProvider?.id ?? '')
      setApiKeyId(firstKey?.id ?? '')
      setIsDefault(false)
      setCatalogMode('provider')
      setSelectedModelIds([])
      setDefaultModel('')
      setRoles({ sonnet: '', opus: '', haiku: '', fable: '' })
      setForwardMode('follow')
      setUpstreamModel('')
      setAutoModeEnabled(false)
      setAutoModeModel('')
      setClaudePrimaryModel('')
      setExtraEnvText('')
      setBaseUrl('')
      setAuthScheme('bearer')
      setUserAgent('')
    }
  }, [open, profile, clientKind, providers, apiKeysByProvider])

  useEffect(() => {
    if (open && providerId) {
      void fetchCatalog(providerId).catch(() => {})
    }
  }, [open, providerId, fetchCatalog])

  const selectedProvider = providers.find((item) => item.id === providerId)
  const providerKeys = useMemo(
    () => (providerId ? apiKeysByProvider[providerId] ?? [] : []),
    [providerId, apiKeysByProvider],
  )
  const providerCatalogModels = useMemo(
    () => (providerId ? catalogs[providerId]?.models ?? [] : []),
    [providerId, catalogs],
  )

  const visibleModelOptions = useMemo(() => {
    const byId = new Map<string, ClientModel>()
    if (catalogMode === 'custom') {
      for (const id of selectedModelIds) {
        const match = providerCatalogModels.find((m) => m.id === id)
        byId.set(id, match ?? { id, displayName: id })
      }
    } else {
      for (const m of providerCatalogModels) {
        byId.set(m.id, m)
      }
    }
    return [...byId.values()].map((model) => ({
      value: model.id,
      label:
        model.displayName && model.displayName !== model.id
          ? `${model.displayName} (${model.id})`
          : model.id,
    }))
  }, [catalogMode, selectedModelIds, providerCatalogModels])

  const catalogAutocompleteOptions = useMemo(
    () =>
      providerCatalogModels.map((model) => ({
        value: model.id,
        label:
          model.displayName && model.displayName !== model.id
            ? `${model.displayName} (${model.id})`
            : model.id,
      })),
    [providerCatalogModels],
  )

  const globalClaudeModel =
    typeof globalSettings.claudeConfig?.ANTHROPIC_MODEL === 'string'
      ? globalSettings.claudeConfig.ANTHROPIC_MODEL
      : ''

  const validUrl = isValidOptionalHttpUrl(baseUrl)
  const validUa = !/[\r\n]/u.test(userAgent)

  const advancedCustomCount = useMemo(() => {
    let count = 0
    if (clientKind !== 'grok' && catalogMode === 'custom') count += 1
    if (clientKind === 'claude_code') {
      if (extraEnvText.trim()) count += 1
      if (autoModeEnabled) count += 1
    }
    if (forwardMode !== 'follow') count += 1
    if (baseUrl.trim() || userAgent.trim() || authScheme !== 'bearer') count += 1
    return count
  }, [
    clientKind,
    catalogMode,
    extraEnvText,
    autoModeEnabled,
    forwardMode,
    baseUrl,
    userAgent,
    authScheme,
  ])

  const handleProviderChange = (nextProviderId: string) => {
    setProviderId(nextProviderId)
    const keys = apiKeysByProvider[nextProviderId] ?? []
    const nextKey = keys.find((k) => k.isActive && !k.isExhausted) ?? keys[0]
    setApiKeyId(nextKey?.id ?? '')
  }

  const handleSave = async () => {
    setErrorText(null)
    if (!name.trim()) {
      setActiveTab('basic')
      setErrorText(t('profiles.nameRequired'))
      return
    }
    if (!providerId) {
      setActiveTab('basic')
      setErrorText(t('profiles.providerRequired'))
      return
    }
    if (!apiKeyId) {
      setActiveTab('basic')
      setErrorText(t('profiles.keyRequired'))
      return
    }
    if (!validUrl) {
      setActiveTab('advanced')
      setErrorText(t('gateway.invalidBaseUrl'))
      return
    }
    if (!validUa) {
      setActiveTab('advanced')
      setErrorText(t('gateway.invalidUserAgent'))
      return
    }
    if (clientKind !== 'grok' && catalogMode === 'custom' && selectedModelIds.length === 0) {
      setActiveTab('advanced')
      setErrorText(t('gateway.selectModelsRequired'))
      return
    }
    if (forwardMode === 'fixed' && !upstreamModel.trim()) {
      setActiveTab('advanced')
      setErrorText(t('profiles.upstreamFixedPlaceholder'))
      return
    }

    let launchEnv: Record<string, string> | null = null
    if (clientKind === 'claude_code') {
      const parsedExtras = parseExtraEnvJson(extraEnvText)
      if (parsedExtras === null) {
        setActiveTab('advanced')
        setErrorText(t('profiles.claudeExtraEnvInvalid'))
        return
      }
      const merged: Record<string, string> = { ...parsedExtras }
      if (claudePrimaryModel.trim()) merged.ANTHROPIC_MODEL = claudePrimaryModel.trim()
      launchEnv = Object.keys(merged).length > 0 ? merged : null
    }

    const customModels: ClientModel[] = selectedModelIds
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => {
        const match = providerCatalogModels.find((m) => m.id === id)
        return match ?? { id, displayName: id }
      })

    const clientCfg: ClientModelConfig = {
      ...EMPTY_MODEL_MAPPING.clients[clientKind],
      catalogMode: clientKind === 'grok' ? 'provider' : catalogMode,
      models: catalogMode === 'custom' ? customModels : [],
      defaultModel: defaultModel.trim(),
      roles:
        clientKind === 'claude_desktop'
          ? {
              sonnet: roles.sonnet.trim(),
              opus: roles.opus.trim(),
              haiku: roles.haiku.trim(),
              fable: roles.fable.trim(),
            }
          : { sonnet: '', opus: '', haiku: '', fable: '' },
      forwardMode,
      upstreamModel: upstreamModel.trim(),
      sonnet: '',
      opus: '',
      haiku: '',
    }

    const modelConfig =
      serializeModelMapping({
        clients: {
          ...EMPTY_MODEL_MAPPING.clients,
          [clientKind]: clientCfg,
        },
        autoMode:
          clientKind === 'claude_code'
            ? { enabled: autoModeEnabled, model: autoModeModel.trim() }
            : { enabled: false, model: '' },
      }) ?? null

    const hasCustomConnection = Boolean(
      baseUrl.trim() || userAgent.trim() || authScheme !== 'bearer',
    )
    const connectionConfig: ClientProfileConnectionConfig | null = hasCustomConnection
      ? {
          baseUrl: baseUrl.trim() || null,
          authScheme,
          userAgent: userAgent.trim() || null,
        }
      : null

    setSaving(true)
    try {
      if (profile) {
        await onUpdate({
          id: profile.id,
          name: name.trim(),
          providerId,
          apiKeyId,
          ...(isCliClient ? { isDefault } : {}),
          modelConfig: modelConfig ?? '',
          connectionConfig,
          launchEnv,
        })
        message.success(t('profiles.saved'))
      } else {
        await onCreate({
          name: name.trim(),
          clientKind,
          providerId,
          apiKeyId,
          isDefault: isCliClient ? isDefault : false,
          modelConfig,
          connectionConfig,
          launchEnv,
        })
        message.success(t('profiles.created'))
      }
      onClose()
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const handleOpenPreview = async () => {
    if (!providerId || !apiKeyId) return
    setPreviewOpen(true)
    setPreviewLoading(true)
    setPreviewError(null)
    setPreviewData(null)
    try {
      const data = await getApi().terminal.getLaunchPreview({
        cliType: clientKind,
        providerId,
        apiKeyId,
        clientProfileId: profile?.id,
      })
      setPreviewData(data)
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error))
    } finally {
      setPreviewLoading(false)
    }
  }

  const previewTargetUrl = baseUrl.trim() || selectedProvider?.baseUrl || '—'
  const previewClientModel =
    clientKind === 'claude_code'
      ? claudePrimaryModel.trim() || globalClaudeModel || 'claude-sonnet-5'
      : clientKind === 'codex'
        ? defaultModel.trim() || visibleModelOptions[0]?.value || 'gpt-5'
        : clientKind === 'grok'
          ? defaultModel.trim() || 'grok-code-fast-1'
          : roles.sonnet.trim() || ROLE_ROUTE_IDS.sonnet

  const previewUpstreamModel =
    forwardMode === 'fixed'
      ? upstreamModel.trim() || t('profiles.unset')
      : previewClientModel

  return (
    <>
      <Drawer
        open={open}
        width={580}
        onClose={() => {
          if (!saving) onClose()
        }}
        destroyOnHidden
        title={
          <Space size={8}>
            <span>{profile ? t('profiles.edit') : t('profiles.create')}</span>
            <Tag color='blue'>{getClientKindLabel(clientKind)}</Tag>
          </Space>
        }
        footer={
          <div className={styles.footerBar}>
            <div>
              {isCliClient && (
                <Button
                  icon={<EyeOutlined />}
                  disabled={!providerId || !apiKeyId || saving}
                  onClick={() => void handleOpenPreview()}
                >
                  {t('profiles.launchPreview')}
                </Button>
              )}
            </div>
            <Space>
              <Button disabled={saving} onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type='primary' loading={saving} onClick={() => void handleSave()}>
                {t('common.save')}
              </Button>
            </Space>
          </div>
        }
      >
        <div className={styles.stack}>
          {errorText && <Alert type='error' showIcon title={errorText} />}

          <Tabs
            activeKey={activeTab}
            onChange={(key) => setActiveTab(key as 'basic' | 'advanced')}
            items={[
              {
                key: 'basic',
                label: t('profiles.tabBasic'),
                children: (
                  <div className={styles.stack}>
                    <div className={styles.field}>
                      <label className={styles.fieldLabel} htmlFor='profile-name-input'>
                        {t('profiles.name')}
                      </label>
                      <Input
                        id='profile-name-input'
                        value={name}
                        placeholder={t('profiles.namePlaceholder')}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={80}
                      />
                    </div>

                    <div className={styles.twoCol}>
                      <div className={styles.field}>
                        <span className={styles.fieldLabel}>{t('gateway.provider')}</span>
                        <Select
                          value={providerId || undefined}
                          placeholder={t('gateway.providerPlaceholder')}
                          options={providers.map((item) => ({
                            value: item.id,
                            label: item.isActive
                              ? item.name
                              : `${item.name} (${t('common.inactive')})`,
                          }))}
                          onChange={handleProviderChange}
                        />
                      </div>

                      <div className={styles.field}>
                        <span className={styles.fieldLabel}>{t('gateway.key')}</span>
                        <Select
                          value={apiKeyId || undefined}
                          placeholder={t('gateway.keyPlaceholder')}
                          disabled={!providerId}
                          options={providerKeys.map((item) => ({
                            value: item.id,
                            label:
                              item.isActive && !item.isExhausted
                                ? item.alias || t('instances.unnamedKey')
                                : `${item.alias || t('instances.unnamedKey')} (${t('profiles.statusKeyUnavailable')})`,
                          }))}
                          onChange={setApiKeyId}
                        />
                      </div>
                    </div>

                    {clientKind === 'claude_code' && (
                      <div className={styles.field}>
                        <span className={styles.fieldLabel}>{t('profiles.claudeDefaultModel')}</span>
                        <AutoComplete
                          value={claudePrimaryModel}
                          options={visibleModelOptions}
                          placeholder={
                            globalClaudeModel
                              ? t('profiles.claudeDefaultModelInherit', { model: globalClaudeModel })
                              : t('profiles.defaultModelPlaceholder')
                          }
                          allowClear
                          onChange={setClaudePrimaryModel}
                        />
                      </div>
                    )}

                    {clientKind === 'codex' && (
                      <div className={styles.field}>
                        <span className={styles.fieldLabel}>{t('profiles.codexDefaultModel')}</span>
                        <AutoComplete
                          value={defaultModel}
                          options={visibleModelOptions}
                          allowClear
                          placeholder={t('profiles.defaultModelPlaceholder')}
                          onChange={setDefaultModel}
                        />
                      </div>
                    )}

                    {clientKind === 'grok' && (
                      <div className={styles.field}>
                        <span className={styles.fieldLabel}>{t('profiles.grokModel')}</span>
                        <AutoComplete
                          value={defaultModel}
                          options={catalogAutocompleteOptions}
                          allowClear
                          placeholder={t('profiles.grokModelPlaceholder')}
                          onChange={setDefaultModel}
                        />
                      </div>
                    )}

                    {clientKind === 'claude_desktop' && (
                      <div className={styles.field}>
                        <span className={styles.fieldLabel}>{t('profiles.desktopRolesTitle')}</span>
                        <div className={styles.twoCol}>
                          {CLIENT_ROLES.map((role) => (
                            <div key={role} className={styles.field}>
                              <span className={styles.fieldLabel}>
                                {role.toUpperCase()} ({ROLE_ROUTE_IDS[role]})
                              </span>
                              <AutoComplete
                                value={roles[role]}
                                options={visibleModelOptions}
                                allowClear
                                placeholder={t('profiles.defaultModelPlaceholder')}
                                onChange={(val) => setRoles((prev) => ({ ...prev, [role]: val }))}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {isCliClient && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          paddingTop: 4,
                        }}
                      >
                        <Tooltip title={t('profiles.cliDefaultTooltip')}>
                          <span className={styles.fieldLabel}>{t('profiles.cliDefaultLabel')}</span>
                        </Tooltip>
                        <Switch size='small' checked={isDefault} onChange={setIsDefault} />
                      </div>
                    )}
                  </div>
                ),
              },
              {
                key: 'advanced',
                label: (
                  <Space size={6}>
                    <span>{t('profiles.tabAdvanced')}</span>
                    {advancedCustomCount > 0 && (
                      <Badge count={advancedCustomCount} size='small' color='blue' />
                    )}
                  </Space>
                ),
                children: (
                  <div className={styles.stack}>
                    {/* Visible Models */}
                    {clientKind !== 'grok' && (
                      <section className={styles.section}>
                        <div className={styles.sectionHeader}>
                          <span className={styles.sectionTitle}>{t('profiles.stepModels')}</span>
                          {selectedProvider && (
                            <Button
                              size='small'
                              icon={<AppstoreOutlined />}
                              onClick={() => setCatalogModalOpen(true)}
                            >
                              {t('profiles.manageCatalog')}
                            </Button>
                          )}
                        </div>
                        <Radio.Group
                          value={catalogMode}
                          onChange={(e) => setCatalogMode(e.target.value)}
                          options={[
                            {
                              value: 'provider',
                              label: t('profiles.followCatalogCount', {
                                count: providerCatalogModels.length,
                              }),
                            },
                            { value: 'custom', label: t('profiles.customCatalog') },
                          ]}
                        />
                        {catalogMode === 'custom' && (
                          <Select
                            mode='tags'
                            value={selectedModelIds}
                            placeholder={t('gateway.selectedModels')}
                            options={catalogAutocompleteOptions}
                            onChange={(values) => setSelectedModelIds(values)}
                          />
                        )}
                      </section>
                    )}

                    {/* Claude Code extra env JSON */}
                    {clientKind === 'claude_code' && (
                      <section className={styles.section}>
                        <span className={styles.sectionTitle}>{t('profiles.claudeExtraEnv')}</span>
                        <TextArea
                          value={extraEnvText}
                          onChange={(e) => setExtraEnvText(e.target.value)}
                          autoSize={{ minRows: 3, maxRows: 8 }}
                          spellCheck={false}
                          placeholder={'{\n  "API_TIMEOUT_MS": "600000"\n}'}
                        />
                      </section>
                    )}

                    {/* Upstream Model Rewriting */}
                    <section className={styles.section}>
                      <span className={styles.sectionTitle}>{t('profiles.stepUpstream')}</span>
                      <Radio.Group
                        value={forwardMode}
                        onChange={(e) => setForwardMode(e.target.value)}
                        options={[
                          { value: 'follow', label: t('profiles.upstreamPassthrough') },
                          { value: 'fixed', label: t('profiles.upstreamFixed') },
                        ]}
                      />

                      {forwardMode === 'fixed' && (
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>
                            {t('profiles.upstreamFixedLabel')}
                          </span>
                          <AutoComplete
                            value={upstreamModel}
                            options={catalogAutocompleteOptions}
                            allowClear
                            placeholder={t('profiles.upstreamFixedPlaceholder')}
                            onChange={setUpstreamModel}
                          />
                        </div>
                      )}

                      <div className={styles.routePreview}>
                        <Text type='secondary'>{t('profiles.upstreamRoutePreview')}</Text>
                        <span className={styles.routePreviewCode}>
                          {previewClientModel} → {previewUpstreamModel} @ {previewTargetUrl}
                        </span>
                      </div>
                    </section>

                    {/* Auto Mode Classifier (Claude Code only) */}
                    {clientKind === 'claude_code' && (
                      <section className={styles.section}>
                        <div className={styles.sectionHeader}>
                          <span className={styles.sectionTitle}>
                            {t('profiles.autoModeClassifier')}
                          </span>
                          <Switch
                            size='small'
                            checked={autoModeEnabled}
                            onChange={setAutoModeEnabled}
                          />
                        </div>
                        {autoModeEnabled && (
                          <div className={styles.field}>
                            <span className={styles.fieldLabel}>{t('profiles.autoModeModel')}</span>
                            <AutoComplete
                              value={autoModeModel}
                              options={catalogAutocompleteOptions}
                              allowClear
                              onChange={setAutoModeModel}
                            />
                          </div>
                        )}
                      </section>
                    )}

                    {/* Connection Override */}
                    <section className={styles.section}>
                      <span className={styles.sectionTitle}>{t('profiles.stepConnection')}</span>
                      <div className={styles.field}>
                        <span className={styles.fieldLabel}>{t('gateway.baseUrl')}</span>
                        <Space.Compact style={{ width: '100%' }}>
                          <Input
                            value={baseUrl}
                            placeholder={
                              selectedProvider?.baseUrl || t('gateway.baseUrlPlaceholder')
                            }
                            status={validUrl ? undefined : 'error'}
                            onChange={(e) => setBaseUrl(e.target.value)}
                          />
                          <Button
                            icon={<UndoOutlined />}
                            disabled={!baseUrl.trim()}
                            onClick={() => setBaseUrl('')}
                          >
                            {t('gateway.restoreDefault')}
                          </Button>
                        </Space.Compact>
                      </div>
                      <div className={styles.twoCol}>
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>{t('gateway.authScheme')}</span>
                          <Select
                            value={authScheme}
                            options={[
                              { value: 'bearer', label: t('gateway.authBearer') },
                              { value: 'x-api-key', label: t('gateway.authXApiKey') },
                              { value: 'none', label: t('gateway.authNone') },
                            ]}
                            onChange={setAuthScheme}
                          />
                        </div>
                        <div className={styles.field}>
                          <span className={styles.fieldLabel}>{t('gateway.userAgent')}</span>
                          <UserAgentField
                            value={userAgent}
                            placeholder={t('gateway.userAgentPlaceholder')}
                            onChange={setUserAgent}
                            onApply={setUserAgent}
                          />
                        </div>
                      </div>
                    </section>
                  </div>
                ),
              },
            ]}
          />
        </div>
      </Drawer>

      {catalogModalOpen && selectedProvider && (
        <ProviderModelModal
          provider={selectedProvider}
          apiKeys={providerKeys}
          onClose={() => {
            setCatalogModalOpen(false)
            void fetchCatalog(selectedProvider.id).catch(() => {})
          }}
        />
      )}

      <Modal
        open={previewOpen}
        title={t('profiles.launchPreviewTitle')}
        onCancel={() => setPreviewOpen(false)}
        footer={
          <Button type='primary' onClick={() => setPreviewOpen(false)}>
            {t('common.close')}
          </Button>
        }
        width={640}
      >
        {previewLoading ? (
          <Text type='secondary'>{t('common.loading')}</Text>
        ) : previewError ? (
          <Alert
            type='error'
            showIcon
            title={t('profiles.launchPreviewFailed')}
            description={previewError}
          />
        ) : previewData ? (
          <div className={styles.stack}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t('profiles.previewCommand')}</span>
              <pre className={styles.previewPre}>{previewData.command}</pre>
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{t('profiles.previewEnv')}</span>
              <pre className={styles.previewPre}>{JSON.stringify(previewData.env, null, 2)}</pre>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  )
}
