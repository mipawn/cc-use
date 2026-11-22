import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Empty,
  Popconfirm,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import {
  ApiOutlined,
  AppstoreOutlined,
  CloudServerOutlined,
  DeleteOutlined,
  EditOutlined,
  FireOutlined,
  KeyOutlined,
  LineChartOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  WalletOutlined,
} from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type {
  ApiKey,
  CreateProviderInput,
  Gateway,
  Provider,
  ProviderGatewayMetrics,
} from '@shared/types'
import { getApi } from '../api'
import { useAppMessage } from '../hooks/useAppMessage'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'
import { useClientProfileStore } from '../stores/clientProfileStore'
import { useProviderModelCatalogStore } from '../stores/providerModelCatalogStore'
import PageHeader from '../components/common/PageHeader'
import ProviderIcon from '../components/providers/ProviderIcon'
import ProviderModal from '../components/providers/ProviderModal'
import { ProviderModelCatalogPanel } from '../components/providers/ProviderModelModal'
import ProviderUsageWindows from '../components/providers/ProviderUsageWindows'
import KeySimpleModal from '../components/keys/KeySimpleModal'
import ResourceUsageModal, { type ResourceScope } from '../components/usage/ResourceUsageModal'
import {
  formatAccountAmount,
  hasKeyQuery,
  hasProviderQuery,
  providerQueryMissingCredential,
  providerQuotaIsPerKey,
} from '../utils/accountQuery'
import { formatExactTokenCount, formatTokenCount } from '../utils/formatTokens'
import styles from './Keys.module.css'

const { Text } = Typography

export function computeProviderReorder(
  ids: string[],
  fromId: string,
  toId: string,
): string[] | null {
  const fromIdx = ids.indexOf(fromId)
  const toIdx = ids.indexOf(toId)
  if (fromIdx === -1 || toIdx === -1) return null
  const result = [...ids]
  result.splice(fromIdx, 1)
  result.splice(toIdx, 0, fromId)
  return result
}

function SortableProviderItem({
  id,
  active,
  inactive,
  onClick,
  children,
}: {
  id: string
  active: boolean
  inactive: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  })
  return (
    <button
      ref={setNodeRef}
      type='button'
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.45 : undefined,
        zIndex: isDragging ? 2 : undefined,
      }}
      className={`${styles.railItem} ${active ? styles.railItemActive : ''} ${inactive ? styles.railItemInactive : ''}`}
      onClick={onClick}
      {...attributes}
      {...listeners}
    >
      {children}
    </button>
  )
}

export default function Keys() {
  const { t, i18n } = useTranslation()
  const message = useAppMessage()
  const [searchParams, setSearchParams] = useSearchParams()
  const {
    providers,
    loading: providersLoading,
    fetchProviders,
    createProvider,
    updateProvider,
    deleteProvider,
    refreshBalance,
  } = useProviderStore()
  const { apiKeys, fetchAllApiKeys, getAllApiKeys, createApiKey, updateApiKey, deleteApiKey } =
    useApiKeyStore()
  const { profiles, fetchProfiles } = useClientProfileStore()
  const { catalogs, fetchCatalog } = useProviderModelCatalogStore()

  const providerParam = searchParams.get('provider')
  const tabParam = searchParams.get('tab') as 'keys' | 'catalog' | 'settings' | null
  const activeTab: 'keys' | 'catalog' | 'settings' =
    tabParam && ['keys', 'catalog', 'settings'].includes(tabParam) ? tabParam : 'keys'
  const [selectedProviderId, setSelectedProviderIdState] = useState<string | null>(providerParam)
  const [addProviderOpen, setAddProviderOpen] = useState(false)

  const setSelectedProviderId = useCallback(
    (id: string | null) => {
      setSelectedProviderIdState(id)
      const next = new URLSearchParams(searchParams)
      if (id) next.set('provider', id)
      else next.delete('provider')
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )

  const setActiveTab = useCallback(
    (tab: 'keys' | 'catalog' | 'settings') => {
      const next = new URLSearchParams(searchParams)
      if (tab === 'keys') next.delete('tab')
      else next.set('tab', tab)
      setSearchParams(next, { replace: true })
    },
    [searchParams, setSearchParams],
  )
  const [keyModalOpen, setKeyModalOpen] = useState(false)
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null)
  const [usageScope, setUsageScope] = useState<ResourceScope | null>(null)
  const [gateways, setGateways] = useState<Gateway[]>([])
  const [refreshingProviderIds, setRefreshingProviderIds] = useState<Set<string>>(new Set())
  const [refreshingKeyIds, setRefreshingKeyIds] = useState<Set<string>>(new Set())
  const [keyTokenStats, setKeyTokenStats] = useState<
    Record<string, { todayTokens: number; totalTokens: number }>
  >({})
  const [providerMetrics, setProviderMetrics] = useState<Record<string, ProviderGatewayMetrics>>({})

  const allApiKeys = getAllApiKeys()

  const fetchMetricsAndGateways = useCallback(async () => {
    try {
      const [metrics, nextGateways] = await Promise.all([
        getApi().requestLog.getProviderGatewayMetrics(),
        getApi().gateway.list(),
      ])
      setProviderMetrics(Object.fromEntries(metrics.map((item) => [item.providerName, item])))
      setGateways(nextGateways)
    } catch {
      // Non-fatal auxiliary metadata
    }
  }, [])

  useEffect(() => {
    void fetchProviders()
    void fetchProfiles()
    void fetchMetricsAndGateways()
  }, [fetchProviders, fetchProfiles, fetchMetricsAndGateways])

  useEffect(() => {
    if (providers.length > 0) {
      void fetchAllApiKeys(providers.map((item) => item.id))
    }
  }, [providers, fetchAllApiKeys])

  // Ensure a valid provider is selected whenever the list changes
  useEffect(() => {
    if (providers.length === 0) {
      setSelectedProviderId(null)
      return
    }
    if (!selectedProviderId || !providers.some((item) => item.id === selectedProviderId)) {
      setSelectedProviderId(providers[0].id)
    }
  }, [providers, selectedProviderId, setSelectedProviderId])

  // Preload model catalog for the selected provider so the tab badge has the accurate count
  useEffect(() => {
    if (selectedProviderId) {
      void fetchCatalog(selectedProviderId).catch(() => {})
    }
  }, [selectedProviderId, fetchCatalog])

  // Load key token stats
  useEffect(() => {
    if (allApiKeys.length === 0) return
    void getApi()
      .requestLog.getKeyTokenStats()
      .then((stats) => {
        const next: Record<string, { todayTokens: number; totalTokens: number }> = {}
        for (const item of stats) {
          next[item.keyId] = {
            todayTokens: item.todayTokens,
            totalTokens: item.totalTokens,
          }
        }
        setKeyTokenStats(next)
      })
      .catch(() => {})
  }, [allApiKeys.length])

  usePageRefresh(async () => {
    await Promise.all([
      fetchProviders(),
      fetchProfiles(),
      fetchMetricsAndGateways(),
      selectedProviderId ? fetchCatalog(selectedProviderId).catch(() => {}) : Promise.resolve(),
    ])
  })

  const selectedProvider = useMemo(
    () => providers.find((item) => item.id === selectedProviderId) ?? null,
    [providers, selectedProviderId],
  )
  const selectedKeys = useMemo(
    () => (selectedProvider ? apiKeys[selectedProvider.id] ?? [] : []),
    [selectedProvider, apiKeys],
  )
  const selectedCatalogCount = selectedProvider
    ? (catalogs[selectedProvider.id]?.models.length ?? 0)
    : 0

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const reordered = computeProviderReorder(
      providers.map((p) => p.id),
      active.id as string,
      over.id as string,
    )
    if (reordered) void useProviderStore.getState().reorderProviders(reordered)
  }

  const handleToggleProvider = async (provider: Provider, active: boolean) => {
    try {
      await updateProvider({ id: provider.id, isActive: active })
    } catch {
      message.error(t('providers.updateProviderFailed'))
    }
  }

  const handleDeleteProvider = async (id: string) => {
    try {
      await deleteProvider(id)
      void fetchProfiles()
      message.success(t('providers.providerDeleted'))
    } catch {
      message.error(t('providers.deleteProviderFailed'))
    }
  }

  const handleRefreshBalance = async (id: string) => {
    const provider = providers.find((item) => item.id === id)
    if (!provider) return
    const missing = providerQueryMissingCredential(provider, apiKeys[id] ?? [])
    if (missing) {
      message.warning(t(missing))
      return
    }
    setRefreshingProviderIds((prev) => new Set(prev).add(id))
    try {
      const result = await refreshBalance(id)
      if (result.error) {
        message.error(result.error)
      } else if (!result.isValid) {
        message.error(result.invalidMessage || t('providers.refreshBalanceFailed'))
      } else {
        message.success(t('providers.queryUpdated'))
      }
    } catch (error) {
      message.error(`${t('providers.refreshBalanceFailed')}: ${String(error)}`)
    } finally {
      setRefreshingProviderIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const handleRefreshKeyUsage = async (keyId: string) => {
    setRefreshingKeyIds((prev) => new Set(prev).add(keyId))
    try {
      const result = await getApi().keyUsage.refresh(keyId)
      if (result.error) {
        message.error(result.error)
      } else if (result.isValid === false) {
        message.error(result.invalidMessage || t('keys.refreshQuotaFailed'))
      } else {
        message.success(`${t('keys.quota')} ${t('messages.success')}`)
      }
      await fetchAllApiKeys(providers.map((item) => item.id))
    } catch (error) {
      message.error(`${t('keys.refreshQuotaFailed')}: ${String(error)}`)
    } finally {
      setRefreshingKeyIds((prev) => {
        const next = new Set(prev)
        next.delete(keyId)
        return next
      })
    }
  }

  const handleToggleKey = async (key: ApiKey, active: boolean) => {
    try {
      await updateApiKey({ id: key.id, isExhausted: !active, isActive: active })
    } catch {
      message.error(t('messages.error'))
    }
  }

  const handleDeleteKey = async (key: ApiKey) => {
    try {
      await deleteApiKey(key.providerId, key.id)
      void fetchProfiles()
      message.success(t('apiKeys.keyDeleted'))
    } catch {
      message.error(t('messages.error'))
    }
  }

  const handleCreateProvider = async (
    input: CreateProviderInput & { id?: string; isActive?: boolean },
  ) => {
    const created = await createProvider(input)
    setSelectedProviderId(created.id)
    setActiveTab('keys')
  }

  const handleUpdateSelectedProvider = async (
    input: CreateProviderInput & { id?: string; isActive?: boolean },
  ) => {
    if (!selectedProvider) return
    await updateProvider({ ...input, id: selectedProvider.id })
  }

  const renderKeyQuota = (provider: Provider, key: ApiKey) => {
    const perKey = providerQuotaIsPerKey(provider)
    const canRefresh = perKey && hasKeyQuery(key)
    const usage = key.cachedUsage
    const windows = usage?.windows ?? []
    const remainingText = usage ? formatAccountAmount(usage.remaining, usage.unit) : null
    const totalText =
      usage && usage.total !== null && usage.total !== undefined
        ? formatAccountAmount(usage.total, usage.unit)
        : null

    if (!perKey && !usage) return null

    return (
      <div className={styles.keyQuotaBox}>
        <div className={styles.keyQuotaHeader}>
          <Space size={6}>
            <WalletOutlined />
            {remainingText ? (
              <Text strong>
                {remainingText}
                {totalText ? ` / ${totalText}` : ''}
              </Text>
            ) : (
              <Text type='secondary'>{t('keysWorkspace.quotaUnknown')}</Text>
            )}
          </Space>
          {canRefresh && (
            <Button
              type='text'
              size='small'
              icon={<ReloadOutlined spin={refreshingKeyIds.has(key.id)} />}
              onClick={() => void handleRefreshKeyUsage(key.id)}
              aria-label={t('common.refresh')}
            />
          )}
        </div>
        {windows.length > 0 && <ProviderUsageWindows windows={windows} />}
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <PageHeader
        title={t('keysWorkspace.title')}
        actions={
          <Button
            type='primary'
            icon={<CloudServerOutlined />}
            onClick={() => setAddProviderOpen(true)}
          >
            {t('keysWorkspace.addProvider')}
          </Button>
        }
      />

      {providersLoading && providers.length === 0 ? (
        <div className={styles.emptyState}>
          <Spin />
        </div>
      ) : providers.length === 0 ? (
        <div className={styles.emptyState}>
          <Empty description={t('providers.noProviders')}>
            <Button
              type='primary'
              icon={<PlusOutlined />}
              onClick={() => setAddProviderOpen(true)}
            >
              {t('keysWorkspace.addProvider')}
            </Button>
          </Empty>
        </div>
      ) : (
        <div className={styles.workspace}>
          {/* Left Rail: Sortable Provider List */}
          <aside className={styles.rail} aria-label={t('common.providers')}>
            <div className={styles.railHeader}>
              <Text strong style={{ fontSize: 13 }}>
                {t('common.providers')} ({providers.length})
              </Text>
              <Button
                size='small'
                type='text'
                icon={<PlusOutlined />}
                aria-label={t('keysWorkspace.addProvider')}
                onClick={() => setAddProviderOpen(true)}
              />
            </div>
            <div className={styles.railList}>
              <DndContext sensors={sensors} onDragEnd={handleDragEnd} autoScroll={false}>
                <SortableContext
                  items={providers.map((item) => item.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {providers.map((provider) => {
                    const count = (apiKeys[provider.id] ?? []).length
                    const balanceText =
                      !providerQuotaIsPerKey(provider) &&
                      provider.cachedWalletBalance !== null &&
                      provider.cachedWalletBalance !== undefined
                        ? formatAccountAmount(
                            provider.cachedWalletBalance,
                            provider.cachedWalletBalanceCurrency ?? undefined,
                          )
                        : null
                    return (
                      <SortableProviderItem
                        key={provider.id}
                        id={provider.id}
                        active={provider.id === selectedProviderId}
                        inactive={!provider.isActive}
                        onClick={() => setSelectedProviderId(provider.id)}
                      >
                        <ProviderIcon icon={provider.icon} name={provider.name} size={24} />
                        <div className={styles.railItemBody}>
                          <div className={styles.railItemNameRow}>
                            <span
                              className={`${styles.statusDot} ${provider.isActive ? styles.statusDotOn : styles.statusDotOff}`}
                            />
                            <span className={styles.railItemName} title={provider.name}>
                              {provider.name}
                            </span>
                          </div>
                          <div className={styles.railItemMeta}>
                            <span>
                              {count} {t('common.keys')}
                            </span>
                            {balanceText && <Text type='secondary'>{balanceText}</Text>}
                          </div>
                        </div>
                      </SortableProviderItem>
                    )
                  })}
                </SortableContext>
              </DndContext>
            </div>
          </aside>

          {/* Right Workspace: Selected Provider Detail */}
          <section className={styles.detail}>
            {selectedProvider ? (
              <>
                <header className={styles.detailHeader}>
                  <div className={styles.detailTitleRow}>
                    <div className={styles.detailIdentity}>
                      <ProviderIcon
                        icon={selectedProvider.icon}
                        name={selectedProvider.name}
                        size={32}
                      />
                      <div className={styles.detailTitles}>
                        <h2 className={styles.detailName}>{selectedProvider.name}</h2>
                        <span className={styles.detailUrl} title={selectedProvider.baseUrl}>
                          {selectedProvider.baseUrl}
                        </span>
                      </div>
                    </div>
                    <Space wrap size={8}>
                      {providerMetrics[selectedProvider.name] && (
                        <Tag>
                          {t('keysWorkspace.requestsShort', {
                            count: providerMetrics[selectedProvider.name].totalRequests,
                          })}
                          {providerMetrics[selectedProvider.name].avgLatencyMs !== null
                            ? ` · ${Math.round(providerMetrics[selectedProvider.name].avgLatencyMs!)}ms`
                            : ''}
                        </Tag>
                      )}
                      <Switch
                        size='small'
                        checked={selectedProvider.isActive}
                        onChange={(checked) => void handleToggleProvider(selectedProvider, checked)}
                      />
                      <Button
                        size='small'
                        icon={<LineChartOutlined />}
                        onClick={() =>
                          setUsageScope({
                            type: 'provider',
                            providerId: selectedProvider.id,
                            name: selectedProvider.name,
                          })
                        }
                      >
                        {t('statistics.title')}
                      </Button>
                      <Popconfirm
                        title={t('providers.deleteProviderConfirm')}
                        onConfirm={() => void handleDeleteProvider(selectedProvider.id)}
                        okText={t('common.delete')}
                        cancelText={t('common.cancel')}
                        okButtonProps={{ danger: true }}
                      >
                        <Button
                          size='small'
                          danger
                          icon={<DeleteOutlined />}
                          aria-label={t('common.delete')}
                        />
                      </Popconfirm>
                    </Space>
                  </div>

                  {/* Account-level balance & windows bar (only for account-scope providers) */}
                  {!providerQuotaIsPerKey(selectedProvider) &&
                    (hasProviderQuery(selectedProvider) ||
                      selectedProvider.cachedWalletBalance !== null ||
                      (selectedProvider.cachedUsage?.windows?.length ?? 0) > 0) && (
                      <div className={styles.detailAccountBar}>
                        <Space size={6}>
                          <WalletOutlined />
                          <Text strong>
                            {selectedProvider.cachedWalletBalance !== null &&
                            selectedProvider.cachedWalletBalance !== undefined
                              ? formatAccountAmount(
                                  selectedProvider.cachedWalletBalance,
                                  selectedProvider.cachedWalletBalanceCurrency ?? undefined,
                                )
                              : t('keysWorkspace.quotaUnknown')}
                          </Text>
                        </Space>
                        {(selectedProvider.cachedUsage?.windows?.length ?? 0) > 0 && (
                          <ProviderUsageWindows
                            windows={selectedProvider.cachedUsage!.windows!}
                          />
                        )}
                        {hasProviderQuery(selectedProvider) && (
                          <Button
                            size='small'
                            type='text'
                            icon={
                              <ReloadOutlined
                                spin={refreshingProviderIds.has(selectedProvider.id)}
                              />
                            }
                            onClick={() => void handleRefreshBalance(selectedProvider.id)}
                          >
                            {t('common.refresh')}
                          </Button>
                        )}
                      </div>
                    )}
                </header>

                <div className={styles.detailBody}>
                  <Tabs
                    className={styles.detailTabs}
                    activeKey={activeTab}
                    onChange={(key) => setActiveTab(key as 'keys' | 'catalog' | 'settings')}
                    items={[
                      {
                        key: 'keys',
                        label: (
                          <Space size={6}>
                            <KeyOutlined />
                            <span>{t('keysWorkspace.tabKeys')}</span>
                            <Badge count={selectedKeys.length} showZero color='default' />
                          </Space>
                        ),
                        children: (
                          <div>
                            <div className={styles.keysToolbar} style={{ justifyContent: 'flex-end' }}>
                              <Button
                                type='primary'
                                icon={<PlusOutlined />}
                                onClick={() => {
                                  setEditingKey(null)
                                  setKeyModalOpen(true)
                                }}
                              >
                                {t('keysWorkspace.addKey')}
                              </Button>
                            </div>

                            {selectedKeys.length === 0 ? (
                              <div className={styles.emptyState}>
                                <Empty description={t('keysWorkspace.noKeysYet')}>
                                  <Button
                                    type='primary'
                                    icon={<PlusOutlined />}
                                    onClick={() => {
                                      setEditingKey(null)
                                      setKeyModalOpen(true)
                                    }}
                                  >
                                    {t('keysWorkspace.addFirstKey')}
                                  </Button>
                                </Empty>
                              </div>
                            ) : (
                              <div className={styles.keysGrid}>
                                {selectedKeys.map((key) => {
                                  const available = key.isActive && !key.isExhausted
                                  const stats = keyTokenStats[key.id]
                                  const refProfiles = profiles.filter(
                                    (profile) => profile.apiKeyId === key.id,
                                  )
                                  const refGateways = gateways.filter(
                                    (gateway) => gateway.apiKeyId === key.id,
                                  )
                                  return (
                                    <div
                                      key={key.id}
                                      className={`${styles.keyCard} ${!available ? styles.keyCardDisabled : ''}`}
                                    >
                                      <div className={styles.keyCardHeader}>
                                        <div>
                                          <div className={styles.keyAlias}>
                                            {key.alias || t('instances.unnamedKey')}
                                          </div>
                                          {key.isExhausted && (
                                            <Tag color='red' style={{ marginTop: 4 }}>
                                              {t('keys.exhausted')}
                                            </Tag>
                                          )}
                                          {!key.isActive && !key.isExhausted && (
                                            <Tag style={{ marginTop: 4 }}>{t('common.inactive')}</Tag>
                                          )}
                                        </div>
                                        <Switch
                                          size='small'
                                          checked={available}
                                          onChange={(checked) => void handleToggleKey(key, checked)}
                                        />
                                      </div>

                                      {renderKeyQuota(selectedProvider, key)}

                                      <div className={styles.keyStatsRow}>
                                        <Tooltip
                                          title={
                                            stats
                                              ? `${t('keys.todayTokens')}: ${formatExactTokenCount(stats.todayTokens, i18n.language)}`
                                              : undefined
                                          }
                                        >
                                          <span>
                                            <FireOutlined style={{ marginRight: 4 }} />
                                            {t('keys.todayTokens')}:{' '}
                                            {formatTokenCount(
                                              stats?.todayTokens ?? 0,
                                              i18n.language,
                                            )}
                                          </span>
                                        </Tooltip>
                                        <Tooltip
                                          title={
                                            stats
                                              ? `${t('keys.totalTokens')}: ${formatExactTokenCount(stats.totalTokens, i18n.language)}`
                                              : undefined
                                          }
                                        >
                                          <span>
                                            {t('keys.totalTokens')}:{' '}
                                            {formatTokenCount(
                                              stats?.totalTokens ?? 0,
                                              i18n.language,
                                            )}
                                          </span>
                                        </Tooltip>
                                      </div>

                                      {(refProfiles.length > 0 || refGateways.length > 0) && (
                                        <div className={styles.keyRefsRow}>
                                          {refProfiles.length > 0 && (
                                            <Tooltip
                                              title={refProfiles.map((p) => p.name).join('、')}
                                            >
                                              <Tag icon={<AppstoreOutlined />} color='blue'>
                                                {t('keysWorkspace.usedByProfiles', {
                                                  count: refProfiles.length,
                                                })}
                                              </Tag>
                                            </Tooltip>
                                          )}
                                          {refGateways.length > 0 && (
                                            <Tooltip
                                              title={refGateways
                                                .map((g) => g.displayName)
                                                .join('、')}
                                            >
                                              <Tag icon={<ApiOutlined />} color='purple'>
                                                {t('keysWorkspace.usedByGateways', {
                                                  count: refGateways.length,
                                                })}
                                              </Tag>
                                            </Tooltip>
                                          )}
                                        </div>
                                      )}

                                      <div className={styles.keyFooter}>
                                        <Space size={4}>
                                          <Button
                                            size='small'
                                            icon={<EditOutlined />}
                                            onClick={() => {
                                              setEditingKey(key)
                                              setKeyModalOpen(true)
                                            }}
                                          >
                                            {t('common.edit')}
                                          </Button>
                                          <Button
                                            size='small'
                                            type='text'
                                            icon={<LineChartOutlined />}
                                            onClick={() =>
                                              setUsageScope({
                                                type: 'key',
                                                providerId: selectedProvider.id,
                                                apiKeyId: key.id,
                                                name: key.alias || t('instances.unnamedKey'),
                                                providerName: selectedProvider.name,
                                              })
                                            }
                                          >
                                            {t('statistics.title')}
                                          </Button>
                                        </Space>
                                        <Popconfirm
                                          title={t('apiKeys.deleteKeyConfirm')}
                                          onConfirm={() => void handleDeleteKey(key)}
                                          okText={t('common.delete')}
                                          cancelText={t('common.cancel')}
                                          okButtonProps={{ danger: true }}
                                        >
                                          <Button
                                            size='small'
                                            type='text'
                                            danger
                                            icon={<DeleteOutlined />}
                                            aria-label={t('common.delete')}
                                          />
                                        </Popconfirm>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        ),
                      },
                      {
                        key: 'catalog',
                        label: (
                          <Space size={6}>
                            <AppstoreOutlined />
                            <span>{t('keysWorkspace.tabCatalog')}</span>
                            <Badge count={selectedCatalogCount} showZero color='default' />
                          </Space>
                        ),
                        children: (
                          <ProviderModelCatalogPanel
                            key={selectedProvider.id}
                            provider={selectedProvider}
                            apiKeys={selectedKeys}
                          />
                        ),
                      },
                      {
                        key: 'settings',
                        label: (
                          <Space size={6}>
                            <SettingOutlined />
                            <span>{t('keysWorkspace.tabSettings')}</span>
                          </Space>
                        ),
                        children: (
                          <ProviderModal
                            key={selectedProvider.id}
                            open
                            embedded
                            provider={selectedProvider}
                            apiKeys={selectedKeys}
                            onClose={() => {}}
                            onSave={handleUpdateSelectedProvider}
                          />
                        ),
                      },
                    ]}
                  />
                </div>
              </>
            ) : (
              <div className={styles.emptyState}>
                <Text type='secondary'>{t('keysWorkspace.selectProviderHint')}</Text>
              </div>
            )}
          </section>
        </div>
      )}

      <ProviderModal
        open={addProviderOpen}
        provider={null}
        onClose={() => setAddProviderOpen(false)}
        onSave={handleCreateProvider}
      />

      <KeySimpleModal
        open={keyModalOpen}
        apiKey={editingKey}
        providers={providers}
        defaultProviderId={selectedProvider?.id}
        onClose={() => {
          setKeyModalOpen(false)
          setEditingKey(null)
        }}
        onCreate={createApiKey}
        onUpdate={updateApiKey}
        onAfterSave={(saved, previous) => {
          const configChanged =
            previous?.usageScript !== saved.usageScript ||
            JSON.stringify(previous?.queryConfig ?? null) !==
              JSON.stringify(saved.queryConfig ?? null)
          if (
            hasKeyQuery(saved) &&
            (!previous?.cachedUsage || configChanged || previous.value !== saved.value)
          ) {
            void handleRefreshKeyUsage(saved.id)
          }
        }}
      />

      {usageScope && (
        <ResourceUsageModal
          open
          scope={usageScope}
          onClose={() => setUsageScope(null)}
        />
      )}
    </div>
  )
}
