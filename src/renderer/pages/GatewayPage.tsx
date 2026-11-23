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
  AppstoreOutlined,
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
import type { Gateway, GatewayConnectionConfig, Provider, ProxyLanInfo } from '@shared/types'
import { getApi } from '../api'
import { useAppMessage } from '../hooks/useAppMessage'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { useServiceStatus } from '../hooks/useServiceStatus'
import { useApiKeyStore } from '../stores/apiKeyStore'
import { useProviderStore } from '../stores/providerStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useProviderModelCatalogStore } from '../stores/providerModelCatalogStore'
import RoutePickerModal from '../components/common/RoutePickerModal'
import PageHeader from '../components/common/PageHeader'
import UserAgentField from '../components/UserAgentField'
import ProviderModelModal from '../components/providers/ProviderModelModal'
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
  const [routePickerOpen, setRoutePickerOpen] = useState(false)
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
  const [lanToggling, setLanToggling] = useState(false)
  const [catalogModalOpen, setCatalogModalOpen] = useState(false)

  // LAN entries (R8). The backend reports both the active scope and the
  // reachable IPv4 entries; loopback remains the default.
  const [lanInfo, setLanInfo] = useState<ProxyLanInfo | null>(null)
  const [lanLoading, setLanLoading] = useState(false)
  const [lanError, setLanError] = useState<string | null>(null)
  // Mount, ⌘R and the inline retry can overlap; only the latest read may win.
  const lanRevision = useRef(0)

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
  const selectedProvider = providerId ? providersById.get(providerId) : undefined
  const providerBaseUrl = selectedProvider?.baseUrl?.trim() || undefined
  const providerUa = providerDefaultUserAgent(selectedProvider)
  const baseUrlInvalid = baseUrl.trim().length > 0 && !isHttpBaseUrl(baseUrl)
  const userAgentInvalid = /[\r\n]/u.test(userAgent)

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
    const ids = [...new Set(gateways.map((gateway) => gateway.providerId))]
    for (const id of ids) {
      void fetchCatalog(id).catch(() => {
        /* surfaced inline in the editor */
      })
    }
  }, [gateways, fetchCatalog])

  useEffect(() => {
    if (!modalOpen || !providerId) return
    void fetchCatalog(providerId).catch(() => {
      /* surfaced inline */
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
        })
      } else {
        await getApi().gateway.create(trimmed, providerId, apiKeyId, connectionConfig)
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

  return (
    <div className={styles.container}>
      <PageHeader
        title={t('gateway.title')}
        description={t('gateway.subtitle')}
        actions={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
              {t('common.refresh')}
            </Button>
            <Button type='primary' icon={<PlusOutlined />} onClick={openCreate}>
              {t('gateway.create')}
            </Button>
          </Space>
        }
      />

      <div className={styles.lanHint} style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <Space size={10} wrap>
          <Switch
            size='small'
            checked={lanScope === 'lan'}
            loading={lanToggling}
            aria-label={t('gateway.lanAccess')}
            onChange={async (checked) => {
              setLanToggling(true)
              try {
                await useSettingsStore
                  .getState()
                  .updateGlobalSettings({ proxyListenScope: checked ? 'lan' : 'loopback' })
                const nextInfo = await getApi().proxy.lanAddresses()
                setLanInfo(nextInfo)
                message.success(t(checked ? 'gateway.lanEnabledToast' : 'gateway.lanDisabledToast'))
              } catch (err) {
                message.error(err instanceof Error ? err.message : String(err))
              } finally {
                setLanToggling(false)
              }
            }}
          />
          <Typography.Text strong style={{ fontSize: 13 }}>
            {t('gateway.lanAccess')}
          </Typography.Text>
          <Tag color={lanScope === 'lan' ? 'green' : 'default'} style={{ marginInlineEnd: 0 }}>
            {t(lanScope === 'lan' ? 'gateway.lanActive' : 'gateway.lanLocalOnly')}
          </Tag>
        </Space>
        {lanScope === 'lan' && lanAddresses.length > 0 && (
          <Space size={6} wrap>
            {lanAddresses.map((entry) => (
              <Tag
                key={entry.url}
                style={{ cursor: 'pointer', marginInlineEnd: 0, fontFamily: 'var(--font-mono)' }}
                onClick={() => void copy(entry.url)}
              >
                {entry.url}
              </Tag>
            ))}
          </Space>
        )}
      </div>

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
                            {catalogs[gateway.providerId]
                              ? t('profiles.followCatalogCount', {
                                  count: catalogs[gateway.providerId].models.length,
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

      <RoutePickerModal
        open={modalOpen && routePickerOpen}
        context='gateway'
        providers={providers}
        apiKeys={Object.values(apiKeys).flat()}
        currentKeyId={apiKeyId}
        actionText={t('resources.gatewaySelect')}
        onCancel={() => setRoutePickerOpen(false)}
        onSelect={({ provider, apiKey }) => {
          // Binding changes never inherit a key's mapping or reset a gateway policy.
          setProviderId(provider.id)
          setApiKeyId(apiKey.id)
          setFormError(null)
        }}
      />

      <Modal
        open={modalOpen && !routePickerOpen}
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
              <div className={styles.formField}>
                <Typography.Text strong>{t('resources.binding')}</Typography.Text>
                <Space wrap>
                  <Typography.Text>
                    {selectedProvider?.name ?? t('gateway.providerPlaceholder')} /{' '}
                    {apiKeys[providerId ?? '']?.find((key) => key.id === apiKeyId)?.alias ??
                      apiKeyId?.slice(0, 8) ??
                      t('gateway.keyPlaceholder')}
                  </Typography.Text>
                  <Button disabled={saving} onClick={() => setRoutePickerOpen(true)}>
                    {t('resources.choose')}
                  </Button>
                </Space>
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
              <div className={styles.fieldHeader}>
                <h3 id='gateway-model-heading' className={styles.sectionLabel}>
                  {t('gateway.modelExposure')}
                </h3>
                {selectedProvider && (
                  <Space size={8}>
                    <span className={styles.selectionCount}>
                      {t('profiles.followCatalogCount', { count: savedModels.length })}
                    </span>
                    <Button
                      size='small'
                      disabled={saving}
                      icon={<AppstoreOutlined />}
                      onClick={() => setCatalogModalOpen(true)}
                    >
                      {t('gateway.manageCatalog')}
                    </Button>
                  </Space>
                )}
              </div>
              <div className={styles.catalogSummary}>
                <div className={styles.fieldHint}>{t('gateway.exposeAllHint')}</div>
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
                {selectedProvider &&
                  !catalogsLoading[selectedProvider.id] &&
                  !catalogErrors[selectedProvider.id] &&
                  savedModels.length === 0 && (
                    <div className={styles.fieldHint}>{t('gateway.manageModelsHint')}</div>
                  )}
              </div>
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
                        {/* Same draft semantics as the key/model-list entries:
                            selection and typing only mutate the local draft; the
                            save button turns a blank into null (follow). The
                            CR/LF check stays here so the hint keeps its three
                            states — the field only mirrors the error state. The
                            gateway entry reads the shared library but never
                            writes it, so save/delete are not offered here. */}
                        <UserAgentField
                          value={userAgent}
                          placeholder={t('gateway.userAgentPlaceholder')}
                          inputId='gateway-user-agent'
                          invalid={userAgentInvalid}
                          disabled={saving}
                          libraryActions={false}
                          onChange={(value) => {
                            setFormError(null)
                            setUserAgent(value)
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
      {catalogModalOpen && selectedProvider && (
        <ProviderModelModal
          provider={selectedProvider}
          apiKeys={apiKeys[selectedProvider.id] ?? []}
          onClose={() => {
            setCatalogModalOpen(false)
            void fetchCatalog(selectedProvider.id).catch(() => {})
          }}
        />
      )}
    </div>
  )
}
