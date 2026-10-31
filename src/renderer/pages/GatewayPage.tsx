import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Collapse,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd'
import {
  ApiOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import SimpleBar from 'simplebar-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import type {
  Gateway,
  GatewayConnectionConfig,
  GatewayModelPolicy,
  Provider,
  ProxyLanInfo,
} from '@shared/types'
import { getApi } from '../api'
import { useAppMessage } from '../hooks/useAppMessage'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { useServiceStatus } from '../hooks/useServiceStatus'
import { useApiKeyStore } from '../stores/apiKeyStore'
import { useProviderStore } from '../stores/providerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useProviderModelCatalogStore } from '../stores/providerModelCatalogStore'
import styles from './GatewayPage.module.css'

const DEFAULT_CONNECTION: GatewayConnectionConfig = { authScheme: 'bearer' }

function maskToken(token: string): string {
  if (token.length <= 16) return token
  return `${token.slice(0, 12)}…${token.slice(-4)}`
}

/** Same validation the save commands apply: absolute http(s), no
 * embedded credentials, query or fragment. Empty means "provider default". */
function isHttpBaseUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return !parsed.username && !parsed.password && !parsed.search && !parsed.hash
}

/** The provider's User-Agent default is its saved request header, never a
 * separate field; show it for context, do not import it as an override. */
function providerDefaultUserAgent(provider: Provider | undefined): string | undefined {
  const raw = provider?.requestHeaders?.trim()
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const entry = Object.entries(parsed as Record<string, unknown>).find(
      ([name]) => name.toLowerCase() === 'user-agent',
    )
    const value = entry?.[1]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  } catch {
    return undefined
  }
}

export default function GatewayPage() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const message = useAppMessage()
  const { providers, fetchProviders } = useProviderStore()
  const { apiKeys, fetchApiKeys, fetchAllApiKeys } = useApiKeyStore()
  const proxyPort = useSettingsStore((state) => state.globalSettings.proxyPort)
  const proxyListenScope = useSettingsStore((state) => state.globalSettings.proxyListenScope)
  const { status, restart, loading: restarting } = useServiceStatus()

  const [gateways, setGateways] = useState<Gateway[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Gateway | null>(null)
  const [name, setName] = useState('')
  const [providerId, setProviderId] = useState<string>()
  const [apiKeyId, setApiKeyId] = useState<string>()
  const [baseUrl, setBaseUrl] = useState('')
  const [authScheme, setAuthScheme] = useState<GatewayConnectionConfig['authScheme']>('bearer')
  const [userAgent, setUserAgent] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})

  // LAN entries (R8). The backend reports both the active scope and the
  // reachable IPv4 entries; loopback remains the default.
  const [lanInfo, setLanInfo] = useState<ProxyLanInfo | null>(null)
  const [lanLoading, setLanLoading] = useState(false)
  const [lanError, setLanError] = useState<string | null>(null)
  // Mount, ⌘R and the inline retry can overlap; only the latest read may win.
  const lanRevision = useRef(0)

  const [policyMode, setPolicyMode] = useState<GatewayModelPolicy['mode']>('all')
  const [modelIds, setModelIds] = useState<string[]>([])
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const {
    catalogs,
    loading: catalogsLoading,
    errors: catalogErrors,
    fetchCatalog,
  } = useProviderModelCatalogStore()

  const address = useMemo(() => `http://127.0.0.1:${proxyPort}`, [proxyPort])
  // The backend is authoritative for the active scope; the saved setting is
  // only a fallback until the first read resolves.
  const lanScope = lanInfo?.scope ?? proxyListenScope
  const lanAddresses = lanInfo?.addresses ?? []
  const providersById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  )
  const keyOptions = useMemo(
    () =>
      (providerId ? (apiKeys[providerId] ?? []) : []).map((key) => ({
        value: key.id,
        // Never echo the secret value here; the key id is enough to disambiguate.
        label: key.alias?.trim() || key.id.slice(0, 8),
      })),
    [apiKeys, providerId],
  )
  const selectedProvider = providerId ? providersById.get(providerId) : undefined
  const providerBaseUrl = selectedProvider?.baseUrl?.trim() || undefined
  const providerUa = providerDefaultUserAgent(selectedProvider)
  const baseUrlInvalid = baseUrl.trim().length > 0 && !isHttpBaseUrl(baseUrl)
  const userAgentInvalid = /[\r\n]/u.test(userAgent)
  const bindingChanged = Boolean(
    editing && (providerId !== editing.providerId || apiKeyId !== editing.apiKeyId),
  )

  const listRevision = useRef(0)
  const load = useCallback(async () => {
    const revision = listRevision.current + 1
    listRevision.current = revision
    setLoading(true)
    setError(null)
    try {
      const next = await getApi().gateway.list()
      if (listRevision.current === revision) setGateways(next)
    } catch (loadError) {
      if (listRevision.current !== revision) return
      // Surface the failure inline; this callback is also used by page refresh,
      // so it must stay dependency-free rather than closing over `message`.
      setError(String(loadError))
    } finally {
      if (listRevision.current === revision) setLoading(false)
    }
  }, [])

  const loadLanInfo = useCallback(async () => {
    const revision = lanRevision.current + 1
    lanRevision.current = revision
    setLanLoading(true)
    setLanError(null)
    try {
      const info = await getApi().proxy.lanAddresses()
      if (lanRevision.current === revision) setLanInfo(info)
    } catch (lanLoadError) {
      if (lanRevision.current !== revision) return
      console.error('Failed to load LAN addresses:', lanLoadError)
      setLanError(String(lanLoadError))
    } finally {
      if (lanRevision.current === revision) setLanLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    void fetchProviders()
    void loadLanInfo()
  }, [load, fetchProviders, loadLanInfo])

  useEffect(() => {
    if (providers.length === 0) return
    void fetchAllApiKeys(providers.map((provider) => provider.id)).catch((error) => {
      console.error('Failed to load API keys for gateway page:', error)
    })
  }, [providers, fetchAllApiKeys])

  useEffect(() => {
    if (!modalOpen || !providerId) return
    void fetchCatalog(providerId).catch(() => {
      /* surfaced inline without discarding selections */
    })
  }, [modalOpen, providerId, fetchCatalog])

  const refreshPage = useCallback(async () => {
    await Promise.all([load(), loadLanInfo()])
  }, [load, loadLanInfo])

  usePageRefresh(refreshPage)

  const openCreate = () => {
    setEditing(null)
    setName('')
    setProviderId(undefined)
    setApiKeyId(undefined)
    setBaseUrl('')
    setAuthScheme(DEFAULT_CONNECTION.authScheme)
    setUserAgent('')
    setFormError(null)
    setPolicyMode('all')
    setModelIds([])
    setAdvancedOpen(false)
    setModalOpen(true)
  }

  const openEdit = (gateway: Gateway) => {
    const connection = gateway.connectionConfig ?? DEFAULT_CONNECTION
    setEditing(gateway)
    setName(gateway.displayName)
    setProviderId(gateway.providerId)
    setApiKeyId(gateway.apiKeyId)
    setBaseUrl(connection.baseUrl?.trim() ?? '')
    setAuthScheme(connection.authScheme)
    setUserAgent(connection.userAgent?.trim() ?? '')
    setFormError(null)
    setPolicyMode(gateway.modelPolicy?.mode ?? 'all')
    setModelIds(gateway.modelPolicy?.mode === 'selected' ? gateway.modelPolicy.modelIds : [])
    setAdvancedOpen(connection.authScheme !== 'bearer' || Boolean(connection.userAgent?.trim()))
    void fetchApiKeys(gateway.providerId).catch((error) => {
      console.error('Failed to load API keys for gateway:', error)
    })
    setModalOpen(true)
  }

  const closeModal = () => {
    setModalOpen(false)
    setFormError(null)
  }

  const handleProviderChange = (value: string) => {
    setProviderId(value)
    setFormError(null)
    const keys = apiKeys[value] ?? []
    if (!keys.some((key) => key.id === apiKeyId)) setApiKeyId(undefined)
    void fetchApiKeys(value).catch((error) => {
      console.error('Failed to load API keys for gateway:', error)
    })
  }

  const save = async () => {
    if (saving) return
    setFormError(null)
    const trimmed = name.trim()
    if (!trimmed || !providerId || !apiKeyId) {
      setFormError(t('gateway.required'))
      return
    }
    if (baseUrlInvalid) {
      setFormError(t('gateway.invalidBaseUrl'))
      return
    }
    if (userAgentInvalid) {
      setFormError(t('gateway.invalidUserAgent'))
      return
    }
    if (policyMode === 'selected' && modelIds.length === 0) {
      setFormError(t('gateway.selectModelsRequired'))
      return
    }
    const modelPolicy: GatewayModelPolicy =
      policyMode === 'all' ? { mode: 'all' } : { mode: 'selected', modelIds }
    // Always send the whole object: omit means "keep stored", an object means
    // "replace", and null explicitly clears baseUrl / userAgent.
    const connectionConfig: GatewayConnectionConfig = {
      baseUrl: baseUrl.trim() || null,
      authScheme,
      userAgent: userAgent.trim() || null,
    }
    setSaving(true)
    try {
      if (editing) {
        await getApi().gateway.update(editing.sessionToken, {
          name: trimmed,
          providerId,
          apiKeyId,
          connectionConfig,
          modelPolicy,
        })
      } else {
        await getApi().gateway.create(trimmed, providerId, apiKeyId, connectionConfig, modelPolicy)
      }
    } catch (saveError) {
      message.error(String(saveError))
      return
    } finally {
      // Saving belongs to this write, not the subsequent list refresh. A delayed
      // refresh must not release the busy state of an editor opened afterwards.
      setSaving(false)
    }
    closeModal()
    message.success(t('gateway.saved'))
    void load()
  }

  const toggleGateway = async (gateway: Gateway, active: boolean) => {
    setGateways((current) =>
      current.map((item) =>
        item.sessionToken === gateway.sessionToken ? { ...item, isActive: active } : item,
      ),
    )
    try {
      await getApi().gateway.update(gateway.sessionToken, { isActive: active })
      message.success(active ? t('gateway.enabledToast') : t('gateway.disabledToast'))
    } catch (toggleError) {
      setGateways((current) =>
        current.map((item) =>
          item.sessionToken === gateway.sessionToken
            ? { ...item, isActive: gateway.isActive }
            : item,
        ),
      )
      message.error(String(toggleError))
    }
  }

  const remove = async (gateway: Gateway) => {
    try {
      await getApi().gateway.delete(gateway.sessionToken)
      setGateways((current) => current.filter((item) => item.sessionToken !== gateway.sessionToken))
      message.success(t('gateway.deleted'))
    } catch (deleteError) {
      message.error(String(deleteError))
    }
  }

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      message.success(t('common.copied'))
    } catch (copyError) {
      message.error(String(copyError))
    }
  }

  const authLabel = (scheme: GatewayConnectionConfig['authScheme']) => {
    if (scheme === 'x-api-key') return t('gateway.authXApiKey')
    if (scheme === 'none') return t('gateway.authNone')
    return t('gateway.authBearer')
  }

  const savedModels = providerId ? (catalogs[providerId]?.models ?? []) : []
  const modelOptions = [
    ...new Map([
      ...savedModels.map(
        (model) =>
          [
            model.id,
            {
              value: model.id,
              label:
                model.displayName && model.displayName !== model.id
                  ? `${model.displayName} (${model.id})`
                  : model.id,
            },
          ] as const,
      ),
      ...modelIds
        .filter((id) => !savedModels.some((model) => model.id === id))
        .map((id) => [id, { value: id, label: id }] as const),
    ]).values(),
  ]

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('gateway.title')}
          </Typography.Title>
          <Typography.Text type='secondary'>{t('gateway.subtitle')}</Typography.Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            {t('common.refresh')}
          </Button>
          <Button type='primary' icon={<PlusOutlined />} onClick={openCreate}>
            {t('gateway.create')}
          </Button>
        </Space>
      </div>

      {/* Loopback stays the default; point at settings instead of adding a
          per-gateway LAN switch. */}
      {lanScope === 'loopback' && (
        <div className={styles.lanHint}>
          <Typography.Text type='secondary'>{t('gateway.lanOffHint')}</Typography.Text>
          <Link to='/settings'>{t('gateway.lanOpenSettings')}</Link>
        </div>
      )}

      {!status.isRunning && (
        <Alert
          type='warning'
          showIcon
          title={t('gateway.daemonOff')}
          description={t('gateway.daemonOffHint')}
          action={
            <Button size='small' loading={restarting} onClick={() => void restart()}>
              {t('gateway.startService')}
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      {error && (
        <Alert
          type='error'
          showIcon
          title={t('gateway.loadFailed')}
          description={error}
          action={
            <Button size='small' onClick={() => void load()}>
              {t('common.retry')}
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      <div className={styles.content}>
        {loading && gateways.length === 0 ? (
          <div className={styles.loadingState}>
            <Spin size='large' />
          </div>
        ) : gateways.length === 0 ? (
          <Empty description={t('gateway.empty')}>
            <Button type='primary' icon={<PlusOutlined />} onClick={openCreate}>
              {t('gateway.create')}
            </Button>
          </Empty>
        ) : (
          <SimpleBar className={styles.scrollContent}>
            <div className={styles.grid}>
              {gateways.map((gateway) => {
                const connectionConfig = gateway.connectionConfig ?? DEFAULT_CONNECTION
                const provider = providersById.get(gateway.providerId)
                const overrideUrl = connectionConfig.baseUrl?.trim()
                const effectiveUrl = overrideUrl || provider?.baseUrl?.trim() || '—'
                const overrideUa = connectionConfig.userAgent?.trim()
                const boundKey = apiKeys[gateway.providerId]?.find(
                  (key) => key.id === gateway.apiKeyId,
                )
                const keyUnavailable = Boolean(
                  boundKey && (!boundKey.isActive || boundKey.isExhausted),
                )
                const providerDisabled = Boolean(provider && !provider.isActive)
                return (
                  <Card
                    key={gateway.sessionToken}
                    className={styles.gatewayCard}
                    title={
                      <div className={styles.cardHeading}>
                        <ApiOutlined style={{ color: token.colorPrimary }} />
                        <span className={styles.cardTitle}>{gateway.displayName}</span>
                        <Tag color={gateway.isActive ? 'green' : 'default'}>
                          {gateway.isActive ? t('common.active') : t('common.inactive')}
                        </Tag>
                      </div>
                    }
                    extra={
                      <Space size={4}>
                        <Switch
                          size='small'
                          checked={gateway.isActive}
                          aria-label={t('gateway.enabled')}
                          onChange={(active) => void toggleGateway(gateway, active)}
                        />
                        <Tooltip title={t('common.edit')}>
                          <Button
                            type='text'
                            size='small'
                            icon={<EditOutlined />}
                            aria-label={t('common.edit')}
                            onClick={() => openEdit(gateway)}
                          />
                        </Tooltip>
                        <Popconfirm
                          title={t('gateway.deleteConfirm')}
                          okButtonProps={{ danger: true }}
                          okText={t('common.delete')}
                          cancelText={t('common.cancel')}
                          onConfirm={() => void remove(gateway)}
                        >
                          <Tooltip title={t('common.delete')}>
                            <Button
                              type='text'
                              size='small'
                              danger
                              icon={<DeleteOutlined />}
                              aria-label={t('common.delete')}
                            />
                          </Tooltip>
                        </Popconfirm>
                      </Space>
                    }
                  >
                    <div className={styles.row}>
                      <span className={styles.label}>{t('gateway.provider')}</span>
                      <span
                        className={styles.value}
                        title={`${gateway.providerName} / ${gateway.keyAlias || '—'}`}
                      >
                        {gateway.providerName || '—'} / {gateway.keyAlias || '—'}
                      </span>
                    </div>
                    <div className={styles.row}>
                      <span className={styles.label}>{t('gateway.address')}</span>
                      <code className={styles.code}>{address}</code>
                      <Tooltip title={t('gateway.copyAddress')}>
                        <Button
                          type='text'
                          size='small'
                          icon={<CopyOutlined />}
                          aria-label={t('gateway.copyAddress')}
                          onClick={() => void copy(address)}
                        />
                      </Tooltip>
                    </div>
                    {lanScope === 'lan' && (
                      <div className={styles.row}>
                        <span className={styles.label}>{t('gateway.lanAddress')}</span>
                        <div className={styles.lanEntries}>
                          {lanLoading && lanAddresses.length === 0 ? (
                            <span className={styles.lanEmpty}>{t('common.loading')}</span>
                          ) : lanError ? (
                            <>
                              <span className={styles.lanError}>{t('gateway.lanLoadFailed')}</span>
                              <Button type='link' size='small' onClick={() => void loadLanInfo()}>
                                {t('common.retry')}
                              </Button>
                            </>
                          ) : lanAddresses.length === 0 ? (
                            <span className={styles.lanEmpty}>{t('gateway.lanNoAddresses')}</span>
                          ) : (
                            lanAddresses.map((entry) => (
                              <div
                                key={`${entry.interface ?? 'if'}:${entry.ip}`}
                                className={styles.lanEntry}
                              >
                                <code className={styles.code}>{entry.url}</code>
                                {entry.interface && (
                                  <Tag className={styles.lanInterface}>{entry.interface}</Tag>
                                )}
                                <Tooltip title={t('gateway.copyLanAddress')}>
                                  <Button
                                    type='text'
                                    size='small'
                                    icon={<CopyOutlined />}
                                    aria-label={t('gateway.copyLanAddress')}
                                    onClick={() => void copy(entry.url)}
                                  />
                                </Tooltip>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                    <div className={styles.row}>
                      <span className={styles.label}>{t('gateway.localKey')}</span>
                      <code className={styles.code}>
                        {revealed[gateway.sessionToken]
                          ? gateway.sessionToken
                          : maskToken(gateway.sessionToken)}
                      </code>
                      <Tooltip title={t('gateway.localKey')}>
                        <Button
                          type='text'
                          size='small'
                          icon={
                            revealed[gateway.sessionToken] ? (
                              <EyeInvisibleOutlined />
                            ) : (
                              <EyeOutlined />
                            )
                          }
                          aria-label={t('gateway.localKey')}
                          onClick={() =>
                            setRevealed((current) => ({
                              ...current,
                              [gateway.sessionToken]: !current[gateway.sessionToken],
                            }))
                          }
                        />
                      </Tooltip>
                      <Tooltip title={t('gateway.copyKey')}>
                        <Button
                          type='text'
                          size='small'
                          icon={<CopyOutlined />}
                          aria-label={t('gateway.copyKey')}
                          onClick={() => void copy(gateway.sessionToken)}
                        />
                      </Tooltip>
                    </div>
                    <div className={styles.connectionBlock}>
                      <div className={styles.row}>
                        <span className={styles.label}>{t('gateway.upstreamUrl')}</span>
                        <span className={styles.value} title={effectiveUrl}>
                          {effectiveUrl}
                        </span>
                        <Tag>
                          {overrideUrl ? t('gateway.urlOverride') : t('gateway.urlDefault')}
                        </Tag>
                      </div>
                      <div className={styles.connectionMeta}>
                        <Tooltip title={t('gateway.modelExposure')}>
                          <span className={styles.modelSummary}>
                            {gateway.modelPolicy?.mode === 'selected'
                              ? t('gateway.selectedCount', {
                                  count: gateway.modelPolicy.modelIds.length,
                                })
                              : t('gateway.exposeAll')}
                          </span>
                        </Tooltip>
                        <span className={styles.metadataDivider} aria-hidden='true'>
                          ·
                        </span>
                        <Tooltip title={t('gateway.authScheme')}>
                          <span>{authLabel(connectionConfig.authScheme)}</span>
                        </Tooltip>
                        <span className={styles.metadataDivider} aria-hidden='true'>
                          ·
                        </span>
                        <Tooltip title={overrideUa || t('gateway.userAgent')}>
                          <span className={styles.userAgentSummary}>
                            {overrideUa || t('gateway.userAgentFollow')}
                          </span>
                        </Tooltip>
                      </div>
                    </div>
                    {(keyUnavailable || providerDisabled) && (
                      <div className={styles.riskHints}>
                        {providerDisabled && (
                          <Tag color='warning'>{t('gateway.providerDisabled')}</Tag>
                        )}
                        {keyUnavailable && <Tag color='warning'>{t('gateway.keyUnavailable')}</Tag>}
                      </div>
                    )}
                  </Card>
                )
              })}
            </div>
          </SimpleBar>
        )}
      </div>

      <Modal
        open={modalOpen}
        title={editing ? t('gateway.edit') : t('gateway.create')}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        cancelButtonProps={{ disabled: saving }}
        confirmLoading={saving}
        onOk={() => void save()}
        onCancel={() => {
          if (!saving) closeModal()
        }}
        closable={!saving}
        keyboard={!saving}
        maskClosable={!saving}
        destroyOnHidden
        width={720}
        style={{ top: 32 }}
      >
        <SimpleBar className={styles.modalBody}>
          <div className={styles.formSections}>
            {formError && <Alert type='error' showIcon title={formError} />}
            <div className={styles.formField}>
              <label htmlFor='gateway-name' className={styles.fieldLabel}>
                {t('gateway.name')}
              </label>
              <Input
                id='gateway-name'
                disabled={saving}
                value={name}
                maxLength={64}
                placeholder={t('gateway.namePlaceholder')}
                onChange={(event) => {
                  setFormError(null)
                  setName(event.target.value)
                }}
              />
            </div>

            <section className={styles.formSection} aria-labelledby='gateway-connection-heading'>
              <h3 id='gateway-connection-heading' className={styles.sectionLabel}>
                {t('gateway.connection')}
              </h3>
              <div className={styles.bindingGrid}>
                <div className={styles.formField}>
                  <label htmlFor='gateway-provider' className={styles.fieldLabel}>
                    {t('gateway.provider')}
                  </label>
                  <Select
                    id='gateway-provider'
                    disabled={saving}
                    aria-label={t('gateway.provider')}
                    className={styles.fullWidth}
                    value={providerId}
                    placeholder={t('gateway.providerPlaceholder')}
                    options={providers.map((provider) => ({
                      value: provider.id,
                      label: provider.name,
                    }))}
                    onChange={handleProviderChange}
                  />
                </div>
                <div className={styles.formField}>
                  <label htmlFor='gateway-api-key' className={styles.fieldLabel}>
                    {t('gateway.key')}
                  </label>
                  <Select
                    id='gateway-api-key'
                    aria-label={t('gateway.key')}
                    className={styles.fullWidth}
                    value={apiKeyId}
                    placeholder={
                      providerId ? t('gateway.keyPlaceholder') : t('gateway.selectProviderFirst')
                    }
                    disabled={!providerId || saving}
                    options={keyOptions}
                    onChange={(value) => {
                      setFormError(null)
                      setApiKeyId(value)
                    }}
                  />
                </div>
              </div>
              <div className={styles.formField}>
                <div className={styles.fieldHeader}>
                  <label htmlFor='gateway-base-url' className={styles.fieldLabel}>
                    {t('gateway.baseUrl')}
                  </label>
                  <Button
                    type='link'
                    size='small'
                    icon={<UndoOutlined />}
                    disabled={saving || !baseUrl.trim()}
                    onClick={() => {
                      setFormError(null)
                      setBaseUrl('')
                    }}
                  >
                    {t('gateway.restoreDefault')}
                  </Button>
                </div>
                <Input
                  id='gateway-base-url'
                  disabled={saving}
                  value={baseUrl}
                  placeholder={t('gateway.baseUrlPlaceholder')}
                  allowClear
                  status={baseUrlInvalid ? 'error' : undefined}
                  onChange={(event) => {
                    setFormError(null)
                    setBaseUrl(event.target.value)
                  }}
                />
                <div className={baseUrlInvalid ? styles.fieldError : styles.fieldHint}>
                  {baseUrlInvalid
                    ? t('gateway.invalidBaseUrl')
                    : providerBaseUrl
                      ? t('gateway.baseUrlDefault', { url: providerBaseUrl })
                      : t('gateway.baseUrlNoDefault')}
                </div>
              </div>
            </section>

            <section className={styles.formSection} aria-labelledby='gateway-model-heading'>
              <h3 id='gateway-model-heading' className={styles.sectionLabel}>
                {t('gateway.modelExposure')}
              </h3>
              <Radio.Group
                name='gateway-model-policy'
                disabled={saving}
                aria-label={t('gateway.modelExposure')}
                value={policyMode}
                className={styles.policyChoices}
                onChange={(event) => {
                  setFormError(null)
                  setPolicyMode(event.target.value)
                }}
              >
                <Radio
                  value='all'
                  className={`${styles.policyChoice} ${policyMode === 'all' ? styles.policyChoiceActive : ''}`}
                >
                  <span className={styles.policyCopy}>
                    <span className={styles.policyTitle}>{t('gateway.exposeAll')}</span>
                    <span className={styles.policyDescription}>{t('gateway.exposeAllHint')}</span>
                  </span>
                </Radio>
                <Radio
                  value='selected'
                  className={`${styles.policyChoice} ${policyMode === 'selected' ? styles.policyChoiceActive : ''}`}
                >
                  <span className={styles.policyCopy}>
                    <span className={styles.policyTitle}>{t('gateway.exposeSelected')}</span>
                    <span className={styles.policyDescription}>
                      {t('gateway.exposeSelectedHint')}
                    </span>
                  </span>
                </Radio>
              </Radio.Group>
              {policyMode === 'selected' && (
                <div className={styles.selectedModels}>
                  <div className={styles.fieldHeader}>
                    <label htmlFor='gateway-model-ids' className={styles.fieldLabel}>
                      {t('gateway.selectedModels')}
                    </label>
                    <span className={styles.selectionCount} aria-live='polite'>
                      {t('gateway.selectedCount', { count: modelIds.length })}
                    </span>
                  </div>
                  <Select
                    id='gateway-model-ids'
                    aria-label={t('gateway.selectedModels')}
                    mode='multiple'
                    className={styles.fullWidth}
                    disabled={saving}
                    value={modelIds}
                    options={modelOptions}
                    showSearch={{ optionFilterProp: 'label' }}
                    maxTagCount={2}
                    maxTagTextLength={36}
                    placeholder={t('gateway.selectedModels')}
                    loading={providerId ? catalogsLoading[providerId] : false}
                    onChange={(ids: string[]) => {
                      setFormError(null)
                      setModelIds(ids)
                    }}
                  />
                  {providerId && catalogErrors[providerId] && (
                    <Alert
                      type='error'
                      showIcon
                      title={t('gateway.catalogLoadFailed')}
                      action={
                        <Button
                          size='small'
                          onClick={() => void fetchCatalog(providerId).catch(() => {})}
                        >
                          {t('common.retry')}
                        </Button>
                      }
                    />
                  )}
                  {savedModels.length === 0 && (
                    <div className={styles.fieldHint}>{t('gateway.manageModelsHint')}</div>
                  )}
                  <Alert
                    className={styles.policyNotice}
                    type='warning'
                    showIcon
                    title={t('gateway.strictPolicyHint')}
                  />
                  {bindingChanged && (
                    <div className={styles.fieldHint}>{t('gateway.bindingPolicyHint')}</div>
                  )}
                </div>
              )}
            </section>

            <Collapse
              className={styles.advancedPanel}
              activeKey={advancedOpen ? ['advanced'] : []}
              onChange={(keys) => setAdvancedOpen(keys.includes('advanced'))}
              items={[
                {
                  key: 'advanced',
                  label: t('gateway.advanced'),
                  extra: (
                    <span className={styles.advancedSummary}>
                      {authLabel(authScheme)}
                      {userAgent.trim() ? ` · ${t('gateway.overridden')}` : ''}
                    </span>
                  ),
                  children: (
                    <div className={styles.advancedFields}>
                      <div className={styles.formField}>
                        <label htmlFor='gateway-auth-scheme' className={styles.fieldLabel}>
                          {t('gateway.authScheme')}
                        </label>
                        <Select
                          id='gateway-auth-scheme'
                          disabled={saving}
                          aria-label={t('gateway.authScheme')}
                          className={styles.fullWidth}
                          value={authScheme}
                          options={[
                            { value: 'bearer', label: t('gateway.authBearer') },
                            { value: 'x-api-key', label: t('gateway.authXApiKey') },
                            { value: 'none', label: t('gateway.authNone') },
                          ]}
                          onChange={(value: GatewayConnectionConfig['authScheme']) => {
                            setFormError(null)
                            setAuthScheme(value)
                          }}
                        />
                      </div>
                      <div className={styles.formField}>
                        <label htmlFor='gateway-user-agent' className={styles.fieldLabel}>
                          {t('gateway.userAgent')}
                        </label>
                        <Input
                          id='gateway-user-agent'
                          disabled={saving}
                          value={userAgent}
                          placeholder={t('gateway.userAgentPlaceholder')}
                          allowClear
                          status={userAgentInvalid ? 'error' : undefined}
                          onChange={(event) => {
                            setFormError(null)
                            setUserAgent(event.target.value)
                          }}
                        />
                        <div className={userAgentInvalid ? styles.fieldError : styles.fieldHint}>
                          {userAgentInvalid
                            ? t('gateway.invalidUserAgent')
                            : providerUa
                              ? t('gateway.userAgentDefault', { ua: providerUa })
                              : t('gateway.userAgentNoDefault')}
                        </div>
                      </div>
                    </div>
                  ),
                },
              ]}
            />
          </div>
        </SimpleBar>
      </Modal>
    </div>
  )
}
