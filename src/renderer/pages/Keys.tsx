import {
  hasKeyQuery,
  hasProviderQuery,
  formatAccountAmount,
  providerQuotaIsPerKey,
  providerQueryMissingCredential,
} from '../utils/accountQuery'
import ProviderUsageWindows from '../components/providers/ProviderUsageWindows'
import ProviderIcon from '../components/providers/ProviderIcon'
import { getApi } from '../api'
/**
 * Keys - 以 Key 为核心维度的管理页面
 * Provider 作为分组/筛选器
 */
import { useCallback, useEffect, useState, useMemo } from 'react'
import {
  Typography,
  Button,
  Spin,
  theme,
  Card,
  Space,
  Tag,
  Tooltip,
  Switch,
  Popconfirm,
  Badge,
  Modal,
  Dropdown,
} from 'antd'
import { useAppMessage } from '../hooks/useAppMessage'
import {
  PlusOutlined,
  KeyOutlined,
  CloudServerOutlined,
  SettingOutlined,
  DeleteOutlined,
  ReloadOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  EditOutlined,
  FireOutlined,
  CopyOutlined,
  DollarOutlined,
  WalletOutlined,
  EyeOutlined,
  LineChartOutlined,
  MoreOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import { formatExactTokenCount, formatTokenCount } from '../utils/formatTokens'
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, horizontalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'
import ProviderModal from '../components/providers/ProviderModal'
import KeyEditModal from '../components/keys/KeyEditModal'
import ProviderModelModal from '../components/providers/ProviderModelModal'
import ResourceUsageModal, { type ResourceScope } from '../components/usage/ResourceUsageModal'
import type { Provider, ApiKey, ProviderGatewayMetrics } from '@shared/types'
import { getClientKindLabel } from '@shared/types'
import { getEffectiveKeyClients } from '../utils/clientSupport'
import { isOfficialDeepSeekProvider } from '../utils/officialProviders'
import { usePageRefresh } from '../hooks/usePageRefresh'
import {
  buildDuplicatedKeyDraft,
  toCreateApiKeyInput,
  toUpdateApiKeyInput,
  type ApiKeyEditorInput,
  type KeyEditMode,
} from '../utils/apiKeyEditor'
import PageHeader from '../components/common/PageHeader'
import { buildStatisticsUrl } from '../utils/observationContext'
import styles from './Keys.module.css'

// dnd-kit sortable wrapper — defined at module level to avoid hook issues
// Pure reorder logic — extract for testing
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

function SortableTab({
  id,
  onClick,
  className,
  children,
}: {
  id: string
  onClick: () => void
  className: string
  children: React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  })
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.35 : undefined,
        zIndex: isDragging ? 1 : undefined,
      }}
      className={className}
      {...attributes}
      {...listeners}
      onClick={onClick}
    >
      {children}
    </div>
  )
}

// Import provider type icons
import ClientIcon from '../components/common/ClientIcon'

const { Title, Text } = Typography

export default function Keys() {
  const { t, i18n } = useTranslation()
  const message = useAppMessage()
  const [confirmModal, confirmContextHolder] = Modal.useModal()
  const { token } = theme.useToken()
  const {
    providers,
    loading: providersLoading,
    fetchProviders,
    refreshBalance,
    deleteProvider,
    updateProvider,
  } = useProviderStore()
  const { apiKeys, fetchAllApiKeys, getAllApiKeys, createApiKey, updateApiKey, deleteApiKey } =
    useApiKeyStore()

  // Filter state: 'all' or providerId
  const [activeFilter, setActiveFilter] = useState<string>('all')

  // Modal states
  const [providerModalOpen, setProviderModalOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  const [keyEditOpen, setKeyEditOpen] = useState(false)
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null)
  const [keyEditMode, setKeyEditMode] = useState<KeyEditMode>('create')
  const [defaultProviderId, setDefaultProviderId] = useState<string | undefined>(undefined)
  const [modelProvider, setModelProvider] = useState<Provider | null>(null)
  const [usageScope, setUsageScope] = useState<ResourceScope | null>(null)

  // Refreshing states
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set())
  const [refreshingKeyUsageIds, setRefreshingKeyUsageIds] = useState<Set<string>>(new Set())

  // Token stats per key (today and total)
  const [keyTokenStats, setKeyTokenStats] = useState<
    Record<string, { todayTokens: number; totalTokens: number }>
  >({})
  const [providerMetrics, setProviderMetrics] = useState<Record<string, ProviderGatewayMetrics>>({})

  // Get all API keys
  const allApiKeys = getAllApiKeys()

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  const fetchProviderMetrics = useCallback(async () => {
    try {
      const metrics = await getApi().requestLog.getProviderGatewayMetrics()
      setProviderMetrics(Object.fromEntries(metrics.map((item) => [item.providerName, item])))
    } catch (error) {
      console.error('Failed to fetch provider gateway metrics:', error)
    }
  }, [])

  useEffect(() => {
    void fetchProviderMetrics()
    const timer = window.setInterval(fetchProviderMetrics, 30_000)
    return () => window.clearInterval(timer)
  }, [fetchProviderMetrics])

  // Local provider, key and metrics data only: refreshing must not fire a
  // balance query at every upstream, and must leave search/expanded/drafts be.
  usePageRefresh(async () => {
    await Promise.all([fetchProviders(), fetchProviderMetrics()])
  })

  // Fetch API keys for all providers
  useEffect(() => {
    if (providers.length > 0) {
      fetchAllApiKeys(providers.map((p) => p.id))
    }
  }, [providers, fetchAllApiKeys])

  // Fetch token stats for all keys
  useEffect(() => {
    if (allApiKeys.length === 0) return

    const fetchTokenStats = async () => {
      try {
        const stats = await getApi().requestLog.getKeyTokenStats()
        const tokenMap: Record<string, { todayTokens: number; totalTokens: number }> = {}
        stats.forEach((item) => {
          tokenMap[item.keyId] = {
            todayTokens: item.todayTokens,
            totalTokens: item.totalTokens,
          }
        })
        setKeyTokenStats(tokenMap)
      } catch (error) {
        console.error('Failed to fetch key token stats:', error)
      }
    }
    fetchTokenStats()
  }, [allApiKeys.length])

  // Group keys by provider for display
  const groupedKeys = useMemo(() => {
    const groups: { provider: Provider; keys: ApiKey[]; balance?: number }[] = []

    if (activeFilter === 'all') {
      providers.forEach((provider) => {
        const providerKeys = apiKeys[provider.id] || []
        groups.push({
          provider,
          keys: providerKeys,
          balance: provider.cachedWalletBalance ?? undefined,
        })
      })
    } else {
      const provider = providers.find((p) => p.id === activeFilter)
      if (provider) {
        groups.push({
          provider,
          keys: apiKeys[provider.id] || [],
          balance: provider.cachedWalletBalance ?? undefined,
        })
      }
    }

    return groups
  }, [activeFilter, providers, apiKeys])

  // Handle provider actions
  const handleAddProvider = () => {
    setEditingProvider(null)
    setProviderModalOpen(true)
  }

  const handleEditProvider = (provider: Provider) => {
    setEditingProvider(provider)
    setProviderModalOpen(true)
  }

  const handleDeleteProvider = async (id: string) => {
    try {
      await deleteProvider(id)
      message.success(t('providers.providerDeleted'))
      if (activeFilter === id) {
        setActiveFilter('all')
      }
    } catch {
      message.error(t('providers.deleteProviderFailed'))
    }
  }

  const handleToggleProvider = async (provider: Provider, active: boolean) => {
    try {
      await updateProvider({ id: provider.id, isActive: active })
    } catch {
      message.error(t('providers.updateProviderFailed') || t('messages.error'))
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
    setRefreshingIds((prev) => new Set(prev).add(id))
    try {
      // One query per provider, so one call. The script decides whether the
      // answer is a balance, a set of metering periods, or both; either is
      // reported from the same result rather than guessed at from a type.
      const result = await refreshBalance(id)
      // An account the service reports as unusable is not a balance of zero,
      // and it must not fall through to the success branch below.
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
      setRefreshingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  // Handle key usage refresh
  const handleRefreshKeyUsage = async (keyId: string) => {
    setRefreshingKeyUsageIds((prev) => new Set(prev).add(keyId))
    try {
      const result = await getApi().keyUsage.refresh(keyId)
      if (result.error) {
        message.error(result.error)
      } else if (result.isValid === false) {
        message.error(result.invalidMessage || t('keys.refreshQuotaFailed'))
      } else {
        message.success(t('keys.quota') + ' ' + t('messages.success'))
      }
      // Refresh keys to get updated cached usage
      await fetchAllApiKeys(providers.map((p) => p.id))
    } catch (error) {
      message.error(`${t('keys.refreshQuotaFailed')}: ${String(error)}`)
    } finally {
      setRefreshingKeyUsageIds((prev) => {
        const next = new Set(prev)
        next.delete(keyId)
        return next
      })
    }
  }

  // Handle key actions
  const handleToggleKey = async (key: ApiKey, active: boolean) => {
    try {
      await updateApiKey({ id: key.id, isExhausted: !active })
    } catch {
      message.error(t('messages.error'))
    }
  }

  const handleDeleteKey = async (key: ApiKey) => {
    try {
      await deleteApiKey(key.providerId, key.id)
      message.success(t('apiKeys.keyDeleted'))
    } catch {
      message.error(t('messages.error'))
    }
  }

  // Copy a key record to reuse the same credential under a different model
  // mapping. The credential and copyable configuration carry over; identity,
  // cached quota, exhaustion, failover and request history do not.
  const handleDuplicateKey = (key: ApiKey) => {
    setEditingKey(buildDuplicatedKeyDraft(key, t('apiKeys.copyAliasSuffix') || ' (copy)'))
    setDefaultProviderId(key.providerId)
    setKeyEditMode('duplicate')
    setKeyEditOpen(true)
  }

  // dnd-kit sensors — require 8px drag threshold so clicks pass through
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = providers.map((p) => p.id)
    const reordered = computeProviderReorder(ids, active.id as string, over.id as string)
    if (reordered) useProviderStore.getState().reorderProviders(reordered)
  }

  const handleEditKey = (key: ApiKey) => {
    setEditingKey(key)
    setDefaultProviderId(key.providerId)
    setKeyEditMode('edit')
    setKeyEditOpen(true)
  }

  // Handle add key with optional provider context
  const handleAddKey = (providerId?: string) => {
    setEditingKey(null)
    setDefaultProviderId(providerId)
    setKeyEditMode('create')
    setKeyEditOpen(true)
  }

  // Handle key save. Create and duplicate both insert a new record; only edit
  // writes back to an existing one.
  const handleSaveKey = async (input: ApiKeyEditorInput) => {
    const startedAt = Math.floor(Date.now() / 1000) * 1000
    const previous =
      input.mode === 'edit' ? allApiKeys.find((key) => key.id === input.id) : undefined
    const saved =
      input.mode === 'edit'
        ? await updateApiKey(toUpdateApiKeyInput(input))
        : await createApiKey(toCreateApiKeyInput(input))
    // A first query, a changed query (script, scheme or switch), or a changed
    // credential each invalidate the saved answer — refresh so the card never
    // shows a number from a configuration that no longer exists.
    const configChanged =
      previous?.usageScript !== saved.usageScript ||
      JSON.stringify(previous?.queryConfig ?? null) !== JSON.stringify(saved.queryConfig ?? null)
    if (
      hasKeyQuery(saved) &&
      (!previous?.cachedUsage || configChanged || previous.value !== saved.value)
    ) {
      void handleRefreshKeyUsage(saved.id)
    }
    if (input.mode === 'edit') {
      // Configuration persistence, quota refresh and desktop sync are independent outcomes.
      void Promise.all(
        (['codex', 'claude_desktop'] as const).map(async (client) =>
          getApi().desktopConnection.state(client),
        ),
      )
        .then((states) => {
          if (
            states.some(
              (state) =>
                state.syncFailure?.source === 'key_edit' &&
                Date.parse(state.syncFailure.occurredAt) >= startedAt,
            )
          ) {
            message.warning(t('resources.savedSyncFailed'))
          }
        })
        .catch(() => message.warning(t('resources.saveSyncUnknown')))
    }
  }

  return (
    <div className={styles.container}>
      {confirmContextHolder}
      <PageHeader
        title={t('resources.title')}
        description={t('resources.subtitle')}
        actions={
          <Button type='primary' icon={<CloudServerOutlined />} onClick={handleAddProvider}>
            {t('providers.addProvider')}
          </Button>
        }
      />

      {/* Filter Tabs - Fixed */}
      <div className={styles.filterSection}>
        <div className={styles.filterBar}>
          {/* "All Keys" tab — not sortable */}
          <button
            type='button'
            className={`${styles.filterTab} ${activeFilter === 'all' ? styles.filterTabActive : ''}`}
            onClick={() => setActiveFilter('all')}
          >
            <Space size={4}>
              <span>{t('keys.allKeys') || '全部密钥'}</span>
              <Badge count={allApiKeys.length} showZero className={styles.filterBadge} />
            </Space>
          </button>

          {/* Provider tabs — @dnd-kit sortable */}
          <DndContext sensors={sensors} onDragEnd={handleDragEnd} autoScroll={false}>
            <SortableContext
              items={providers.map((p) => p.id)}
              strategy={horizontalListSortingStrategy}
            >
              {providers.map((provider) => (
                <SortableTab
                  key={provider.id}
                  id={provider.id}
                  onClick={() => setActiveFilter(provider.id)}
                  className={`${styles.filterTab} ${styles.filterTabDraggable} ${activeFilter === provider.id ? styles.filterTabActive : ''}`}
                >
                  <Space size={4}>
                    <ProviderIcon
                      icon={provider?.icon}
                      size={16}
                      style={{ background: 'transparent' }}
                    />
                    <span>{provider.name}</span>
                    <Badge
                      count={(apiKeys[provider.id] || []).length}
                      showZero
                      className={styles.filterBadge}
                    />
                  </Space>
                </SortableTab>
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </div>

      {/* Content - Scrollable */}
      <div className={styles.content}>
        <SimpleBar className={styles.scrollContent} style={{ maxHeight: '100%' }}>
          {/* Keys Content */}
          {providersLoading ? (
            <div className='empty-state'>
              <Spin size='large' />
            </div>
          ) : groupedKeys.length === 0 ? (
            <Card className='empty-state' variant='outlined'>
              <KeyOutlined className='text-5xl mb-4' style={{ color: token.colorTextSecondary }} />
              <Title level={4} className='mb-2!'>
                {t('keys.noKeys') || '暂无密钥'}
              </Title>
              <Text type='secondary' className='block'>
                {t('keys.noKeysHint') || '添加供应商并配置 API 密钥以开始使用'}
              </Text>
            </Card>
          ) : (
            <div className={styles.keyGroups}>
              {groupedKeys.map(({ provider, keys, balance }) => (
                <section
                  key={provider.id}
                  aria-label={provider.name}
                  data-provider-group={provider.id}
                  className={`${styles.keyGroup} ${!provider.isActive ? styles.providerInactive : ''}`}
                >
                  <div className={styles.providerSummary}>
                    <div className={styles.groupHeader}>
                      <div className={styles.groupInfo}>
                        <ProviderIcon icon={provider?.icon} size={22} name={provider.name} />
                        <div className={styles.providerIdentity}>
                          <Text strong className={styles.groupName} title={provider.baseUrl}>
                            {provider.name}
                          </Text>
                        </div>
                        {!providerQuotaIsPerKey(provider) &&
                          hasProviderQuery(provider) &&
                          balance !== undefined && (
                            <span className={styles.accountAmount}>
                              <WalletOutlined />
                              {formatAccountAmount(balance, provider.cachedWalletBalanceCurrency)}
                            </span>
                          )}
                        {!provider.isActive && <Tag>{t('common.inactive')}</Tag>}
                        {isOfficialDeepSeekProvider(provider) && <Tag variant='filled'>官方</Tag>}
                        {providerMetrics[provider.name] ? (
                          <div className={styles.providerHealth}>
                            <div className={styles.providerHealthText}>
                              <Text className={styles.providerHealthTitle}>
                                {providerMetrics[provider.name].totalRequests > 0
                                  ? `${((providerMetrics[provider.name].successfulRequests / providerMetrics[provider.name].totalRequests) * 100).toFixed(1)}%`
                                  : '—'}{' '}
                                <span className={styles.healthLabel}>{t('resources.health')}</span>
                              </Text>
                              <Text type='secondary' className={styles.providerHealthMeta}>
                                {t('resources.healthDetail', {
                                  successful: providerMetrics[provider.name].successfulRequests,
                                  total: providerMetrics[provider.name].totalRequests,
                                  errors: providerMetrics[provider.name].upstreamErrors,
                                })}
                              </Text>
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <Space size={8} wrap>
                        {!providerQuotaIsPerKey(provider) && !hasProviderQuery(provider) && (
                          <Button
                            type='text'
                            size='small'
                            onClick={() => handleEditProvider(provider)}
                          >
                            {t('providers.configureQuery')}
                          </Button>
                        )}
                        {!providerQuotaIsPerKey(provider) && hasProviderQuery(provider) && (
                          <Tooltip
                            title={
                              providerQueryMissingCredential(provider, keys)
                                ? t(providerQueryMissingCredential(provider, keys)!)
                                : t('providers.refreshBalance')
                            }
                          >
                            <Button
                              type='text'
                              size='small'
                              aria-label={t('providers.refreshBalance')}
                              disabled={Boolean(providerQueryMissingCredential(provider, keys))}
                              loading={refreshingIds.has(provider.id)}
                              icon={<ReloadOutlined />}
                              onClick={() => handleRefreshBalance(provider.id)}
                            />
                          </Tooltip>
                        )}
                        <Tooltip title={t('common.settings')}>
                          <Button
                            type='text'
                            size='small'
                            icon={<SettingOutlined />}
                            onClick={() => handleEditProvider(provider)}
                            aria-label={t('common.settings')}
                          />
                        </Tooltip>
                        <Dropdown
                          trigger={['click']}
                          menu={{
                            items: [
                              {
                                key: 'requests',
                                label: (
                                  <a
                                    href={
                                      '#' +
                                      buildStatisticsUrl({
                                        timeRange: 'all',
                                        filter: { providerId: provider.id },
                                        page: 1,
                                        pageSize: 10,
                                      })
                                    }
                                  >
                                    {t('resources.requests')}
                                  </a>
                                ),
                                icon: <EyeOutlined />,
                              },
                              {
                                key: 'usage',
                                label: t('usageDetail.openProvider'),
                                icon: <LineChartOutlined />,
                                onClick: () =>
                                  setUsageScope({
                                    type: 'provider',
                                    providerId: provider.id,
                                    name: provider.name,
                                  }),
                              },
                              {
                                key: 'models',
                                label: t('keys.viewModels'),
                                icon: <EyeOutlined />,
                                onClick: () => setModelProvider(provider),
                              },
                              { type: 'divider' },
                              {
                                key: 'active',
                                label: provider.isActive
                                  ? t('providers.disableProvider')
                                  : t('providers.enableProvider'),
                                onClick: () => handleToggleProvider(provider, !provider.isActive),
                              },
                              {
                                key: 'delete',
                                danger: true,
                                label: t('providers.deleteProvider'),
                                icon: <DeleteOutlined />,
                                onClick: () =>
                                  confirmModal.confirm({
                                    title: t('providers.deleteProvider'),
                                    content: t('providers.deleteProviderConfirm'),
                                    okText: t('common.delete'),
                                    cancelText: t('common.cancel'),
                                    okButtonProps: { danger: true },
                                    onOk: () => handleDeleteProvider(provider.id),
                                  }),
                              },
                            ],
                          }}
                        >
                          <Button
                            type='text'
                            size='small'
                            aria-label={t('common.more')}
                            icon={<MoreOutlined />}
                          />
                        </Dropdown>
                      </Space>
                    </div>

                    {!providerQuotaIsPerKey(provider) && hasProviderQuery(provider) && (
                      <>
                        {provider.cachedUsage?.windows?.length ||
                        provider.cachedUsage?.groups?.length ? (
                          <div className={styles.providerQuota}>
                            <ProviderUsageWindows
                              windows={provider.cachedUsage?.windows ?? []}
                              groups={provider.cachedUsage?.groups ?? []}
                            />
                          </div>
                        ) : null}
                        {providerQueryMissingCredential(provider, keys) ? (
                          <div className={styles.providerQuota}>
                            <Text type='secondary'>
                              {t(providerQueryMissingCredential(provider, keys)!)}
                            </Text>
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>

                  <div className={styles.keysGrid}>
                    {keys.map((key) => (
                      <Card
                        key={key.id}
                        className={`${styles.keyCard} ${key.isExhausted ? styles.exhausted : ''}`}
                        variant='outlined'
                      >
                        {/* Card Header */}
                        <div className={styles.keyCardHeader}>
                          <div className={styles.keyCardTitle}>
                            <div className={styles.keyTitleInfo}>
                              <Text strong className={styles.keyAlias}>
                                {key.alias || t('keys.unnamedKey')}
                              </Text>
                              <div className={styles.keyMeta}>
                                {/* Type icons - show all supported types */}
                                {getEffectiveKeyClients(provider, key).map((clientKind) => {
                                  return (
                                    <Tooltip
                                      key={clientKind}
                                      title={getClientKindLabel(clientKind)}
                                    >
                                      <span className={styles.clientLabel}>
                                        <ClientIcon kind={clientKind} size={14} />
                                        {getClientKindLabel(clientKind)}
                                      </span>
                                    </Tooltip>
                                  )
                                })}
                              </div>
                            </div>
                          </div>
                          <Switch
                            aria-label={`${key.alias || t('keys.unnamedKey')} ${t('common.active')}`}
                            size='small'
                            checked={!key.isExhausted}
                            onChange={(checked) => handleToggleKey(key, checked)}
                          />
                        </div>

                        {/* Stats Row */}
                        <div className={styles.statsRow}>
                          {/* Key Quota - 额度. The reload icon is always visible
                              so the manual refresh is discoverable after the
                              first answer; clicking the stat (or the icon inside
                              it) asks the service for this key's own remaining
                              amount and metering periods again. */}
                          {hasKeyQuery(key) && (
                            <Tooltip
                              title={
                                <span>
                                  {t('keys.refreshQuota')}
                                  <br />
                                  {t('providers.lastChecked')}:{' '}
                                  {key.lastUsageCheckedAt
                                    ? new Date(key.lastUsageCheckedAt).toLocaleString()
                                    : t('common.never')}
                                </span>
                              }
                            >
                              <button
                                type='button'
                                aria-label={t('keys.refreshQuota')}
                                disabled={refreshingKeyUsageIds.has(key.id)}
                                className={`${styles.statItem} ${styles.statItemClickable}`}
                                onClick={() => handleRefreshKeyUsage(key.id)}
                              >
                                <DollarOutlined style={{ color: token.colorSuccess }} />
                                <span className={styles.statValue}>
                                  {key.cachedUsage?.isUnlimited
                                    ? '∞'
                                    : key.cachedUsage?.remaining != null
                                      ? formatAccountAmount(
                                          key.cachedUsage.remaining,
                                          key.cachedUsage.unit,
                                        )
                                      : key.cachedUsage?.windows?.length ||
                                          key.cachedUsage?.groups?.length
                                        ? t('querySchemes.capabilityWindows')
                                        : t('providers.queryNow')}
                                </span>
                                <ReloadOutlined
                                  spin={refreshingKeyUsageIds.has(key.id)}
                                  aria-hidden='true'
                                  style={{
                                    fontSize: 12,
                                    marginLeft: 4,
                                    color: token.colorTextTertiary,
                                  }}
                                />
                              </button>
                            </Tooltip>
                          )}
                          {/* Today's tokens */}
                          <div className={styles.statItem}>
                            <FireOutlined style={{ color: token.colorWarning }} />
                            <Tooltip
                              title={formatExactTokenCount(
                                keyTokenStats[key.id]?.todayTokens || 0,
                                i18n.language,
                              )}
                            >
                              <span className={styles.statValue}>
                                {t('keys.todayTokens') || '今日'}:{' '}
                                {formatTokenCount(
                                  keyTokenStats[key.id]?.todayTokens || 0,
                                  i18n.language,
                                )}
                              </span>
                            </Tooltip>
                          </div>
                          {/* Total tokens */}
                          <div className={styles.statItem}>
                            <PlayCircleOutlined style={{ color: token.colorTextSecondary }} />
                            <Tooltip
                              title={formatExactTokenCount(
                                keyTokenStats[key.id]?.totalTokens || 0,
                                i18n.language,
                              )}
                            >
                              <span className={styles.statValue}>
                                {t('keys.totalTokens') || '累计'}:{' '}
                                {formatTokenCount(
                                  keyTokenStats[key.id]?.totalTokens || 0,
                                  i18n.language,
                                )}
                              </span>
                            </Tooltip>
                          </div>
                        </div>

                        {/* This key's own metering periods: a key-scope answer
                            may report 5h / weekly / monthly instead of (or in
                            addition to) an amount. */}
                        {((key.cachedUsage?.windows?.length ?? 0) > 0 ||
                          (key.cachedUsage?.groups?.length ?? 0) > 0) && (
                          <div className={styles.keyQuotaWindows}>
                            <ProviderUsageWindows
                              windows={key.cachedUsage?.windows ?? []}
                              groups={key.cachedUsage?.groups ?? []}
                            />
                          </div>
                        )}

                        {/* Actions */}
                        <div className={styles.keyCardActions}>
                          <Space size={4}>
                            <Tooltip title={t('keys.copyKey')}>
                              <Button
                                type='text'
                                size='small'
                                icon={<CopyOutlined />}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleDuplicateKey(key)
                                }}
                              ></Button>
                            </Tooltip>
                            {provider.website && (
                              <Tooltip title={t('keys.visitWebsite')}>
                                <Button
                                  type='text'
                                  size='small'
                                  icon={<LinkOutlined />}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    getApi().system.openExternal(provider.website!)
                                  }}
                                />
                              </Tooltip>
                            )}
                            <Tooltip title={t('common.edit')}>
                              <Button
                                type='text'
                                size='small'
                                icon={<EditOutlined />}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleEditKey(key)
                                }}
                              >
                                {t('common.edit')}
                              </Button>
                            </Tooltip>
                            <Popconfirm
                              title={t('apiKeys.deleteKey')}
                              description={t('apiKeys.deleteKeyConfirm')}
                              onConfirm={() => handleDeleteKey(key)}
                              okText={t('common.delete')}
                              cancelText={t('common.cancel')}
                              okButtonProps={{ danger: true }}
                            >
                              <Button
                                type='text'
                                size='small'
                                danger
                                icon={<DeleteOutlined />}
                                onClick={(e) => e.stopPropagation()}
                              />
                            </Popconfirm>
                            <Dropdown
                              trigger={['click']}
                              menu={{
                                items: [
                                  {
                                    key: 'requests',
                                    label: (
                                      <a
                                        href={
                                          '#' +
                                          buildStatisticsUrl({
                                            timeRange: 'all',
                                            filter: { providerId: provider.id, apiKeyId: key.id },
                                            page: 1,
                                            pageSize: 10,
                                          })
                                        }
                                      >
                                        {t('resources.requests')}
                                      </a>
                                    ),
                                    icon: <EyeOutlined />,
                                  },
                                  {
                                    key: 'usage',
                                    label: t('usageDetail.openKey'),
                                    icon: <LineChartOutlined />,
                                    onClick: () =>
                                      setUsageScope({
                                        type: 'key',
                                        providerId: provider.id,
                                        apiKeyId: key.id,
                                        name: key.alias || t('keys.unnamedKey'),
                                        providerName: provider.name,
                                      }),
                                  },
                                ],
                              }}
                            >
                              <Tooltip title={t('common.more')}>
                                <Button
                                  type='text'
                                  size='small'
                                  aria-label={t('common.more')}
                                  icon={<MoreOutlined />}
                                  onClick={(event) => event.stopPropagation()}
                                />
                              </Tooltip>
                            </Dropdown>
                          </Space>
                        </div>
                      </Card>
                    ))}
                    <button
                      type='button'
                      className={styles.addKeyCard}
                      onClick={() => handleAddKey(provider.id)}
                    >
                      <PlusOutlined className={styles.addIcon} />
                      <span>{t('apiKeys.addKey')}</span>
                    </button>
                  </div>
                </section>
              ))}
            </div>
          )}
        </SimpleBar>
      </div>

      {/* Provider Modal */}
      {modelProvider && (
        <ProviderModelModal
          key={modelProvider.id}
          provider={modelProvider}
          apiKeys={apiKeys[modelProvider.id] ?? []}
          onClose={() => setModelProvider(null)}
        />
      )}
      <ProviderModal
        open={providerModalOpen}
        provider={editingProvider}
        apiKeys={editingProvider ? (apiKeys[editingProvider.id] ?? []) : []}
        onClose={() => {
          setProviderModalOpen(false)
          setEditingProvider(null)
        }}
        onSave={async (input) => {
          const saved = input.id
            ? await getApi().provider.update({ ...input, id: input.id })
            : await getApi().provider.create(input)
          useProviderStore.getState().upsertProvider(saved)
          if (!input.id) setActiveFilter(saved.id)
          void fetchProviders()
        }}
      />

      {/* Key Edit Modal */}
      <KeyEditModal
        open={keyEditOpen}
        mode={keyEditMode}
        apiKey={editingKey}
        providers={providers}
        defaultProviderId={defaultProviderId}
        onClose={() => {
          setKeyEditOpen(false)
          setEditingKey(null)
          setDefaultProviderId(undefined)
        }}
        onSave={handleSaveKey}
      />

      <ResourceUsageModal
        open={usageScope != null}
        scope={usageScope}
        onClose={() => setUsageScope(null)}
      />
    </div>
  )
}
