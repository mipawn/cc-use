import { getApi } from '../api'
/**
 * Keys - 以 Key 为核心维度的管理页面
 * Provider 作为分组/筛选器
 */
import { useEffect, useState, useMemo, useRef } from 'react'
import {
  Typography,
  Button,
  Row,
  Col,
  Spin,
  theme,
  Card,
  Space,
  Tag,
  Tooltip,
  Switch,
  Popconfirm,
  Badge,
  Avatar,
  Modal,
  Divider,
  Progress,
  Select,
} from 'antd'
import { useAppMessage } from '../hooks/useAppMessage'
import { useServiceStatus } from '../hooks/useServiceStatus'
import {
  PlusOutlined,
  KeyOutlined,
  CloudServerOutlined,
  SettingOutlined,
  DeleteOutlined,
  WalletOutlined,
  ReloadOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  EditOutlined,
  FireOutlined,
  CopyOutlined,
  DollarOutlined,
  EyeOutlined,
  LineChartOutlined,
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
import ResourceUsageModal, { type ResourceScope } from '../components/usage/ResourceUsageModal'
import type { Provider, ApiKey, ClientKind, ProviderGatewayMetrics } from '@shared/types'
import {
  formatEnvCommand,
  getClientKindLabel,
  isCliClientKind,
  TERMINAL_TYPE_LABELS,
} from '@shared/types'
import { useSettingsStore } from '../stores/settingsStore'
import { getEffectiveKeyClients } from '../utils/clientSupport'
import { isOfficialDeepSeekProvider } from '../utils/officialProviders'
import {
  toCreateApiKeyInput,
  toUpdateApiKeyInput,
  type ApiKeyEditorInput,
} from '../utils/apiKeyEditor'
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
import claudeIcon from '../assets/provider-icons/claude.svg'
import openaiIcon from '../assets/provider-icons/openai.svg'
import deepseekIcon from '../assets/provider-icons/deepseek.svg'
import newapiIcon from '../assets/provider-icons/newapi.svg'

const { Title, Text } = Typography

// Type icon mapping (compatible with legacy ProviderType)
const TYPE_ICONS: Record<string, string> = {
  claude: claudeIcon,
  claude_code: claudeIcon,
  codex: openaiIcon,
  grok: openaiIcon,
  claude_desktop: claudeIcon,
}

const clientIconType = (clientKind: string) =>
  clientKind === 'codex'
    ? 'codex'
    : clientKind === 'grok'
      ? 'grok'
      : clientKind === 'claude_desktop'
        ? 'claude_desktop'
        : 'claude_code'

// Preset provider icon mapping
const PRESET_ICON_MAP: Record<string, string> = {
  claude: claudeIcon,
  codex: openaiIcon,
  openai: openaiIcon,
  deepseek: deepseekIcon,
  newapi: newapiIcon,
}

// Get provider icon src
function getProviderIconSrc(provider: Provider): string {
  if (!provider.icon) {
    return PRESET_ICON_MAP['custom'] || PRESET_ICON_MAP.claude
  }
  if (PRESET_ICON_MAP[provider.icon]) {
    return PRESET_ICON_MAP[provider.icon]
  }
  return `file://${provider.icon}`
}

export default function Keys() {
  const { t, i18n } = useTranslation()
  const message = useAppMessage()
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
  const { globalSettings } = useSettingsStore()
  const terminalType = globalSettings.defaultTerminalType

  // Filter state: 'all' or providerId
  const [activeFilter, setActiveFilter] = useState<string>('all')

  // Modal states
  const [providerModalOpen, setProviderModalOpen] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  const [keyEditOpen, setKeyEditOpen] = useState(false)
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null)
  const [defaultProviderId, setDefaultProviderId] = useState<string | undefined>(undefined)
  const [usageScope, setUsageScope] = useState<ResourceScope | null>(null)

  // Refreshing states
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set())
  const [refreshingKeyUsageIds, setRefreshingKeyUsageIds] = useState<Set<string>>(new Set())

  // Model list state
  const [modelListOpen, setModelListOpen] = useState(false)
  const [modelListProvider, setModelListProvider] = useState<Provider | null>(null)
  const [modelList, setModelList] = useState<string[]>([])
  const [modelListLoading, setModelListLoading] = useState(false)
  const [modelListApiKeyId, setModelListApiKeyId] = useState<string | undefined>(undefined)
  const [modelListError, setModelListError] = useState(false)
  const modelListRequestId = useRef(0)

  // Token stats per key (today and total)
  const [keyTokenStats, setKeyTokenStats] = useState<
    Record<string, { todayTokens: number; totalTokens: number }>
  >({})
  const [providerMetrics, setProviderMetrics] = useState<Record<string, ProviderGatewayMetrics>>({})

  // Get all API keys
  const allApiKeys = getAllApiKeys()
  const modelListKeys = useMemo(
    () => (modelListProvider ? apiKeys[modelListProvider.id] || [] : []),
    [apiKeys, modelListProvider],
  )

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  useEffect(() => {
    const fetchProviderMetrics = async () => {
      try {
        const metrics = await getApi().requestLog.getProviderGatewayMetrics()
        setProviderMetrics(Object.fromEntries(metrics.map((item) => [item.providerName, item])))
      } catch (error) {
        console.error('Failed to fetch provider gateway metrics:', error)
      }
    }

    void fetchProviderMetrics()
    const timer = window.setInterval(fetchProviderMetrics, 30_000)
    return () => window.clearInterval(timer)
  }, [])

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
        if (providerKeys.length > 0) {
          groups.push({
            provider,
            keys: providerKeys,
            balance: provider.cachedWalletBalance || undefined,
          })
        }
      })
    } else {
      const provider = providers.find((p) => p.id === activeFilter)
      if (provider) {
        groups.push({
          provider,
          keys: apiKeys[provider.id] || [],
          balance: provider.cachedWalletBalance || undefined,
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
    setRefreshingIds((prev) => new Set(prev).add(id))
    try {
      const result = await refreshBalance(id)
      if (result.error) {
        message.error(result.error)
      } else {
        message.success(`${t('providers.balance')}: $${result.balance?.toFixed(2)}`)
      }
    } catch {
      message.error(t('providers.refreshBalanceFailed'))
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
      } else {
        message.success(t('keys.quota') + ' ' + t('messages.success'))
      }
      // Refresh keys to get updated cached usage
      fetchAllApiKeys(providers.map((p) => p.id))
    } catch {
      message.error(t('keys.refreshQuotaFailed'))
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

  const handleDuplicateKey = (key: ApiKey) => {
    // Create a copy without id, clear value so user must enter a new key
    const duplicated = {
      ...key,
      id: '',
      alias: key.alias ? `${key.alias} (copy)` : '',
      value: '',
    } as ApiKey
    setEditingKey(duplicated)
    setDefaultProviderId(key.providerId)
    setKeyEditOpen(true)
  }

  // State for copy command modal
  const [copyCommandModalOpen, setCopyCommandModalOpen] = useState(false)
  const [copyCommandKey, setCopyCommandKey] = useState<{
    provider: Provider
    key: ApiKey
  } | null>(null)
  const { status: proxyStatus } = useServiceStatus()
  const [proxySessionTokens, setProxySessionTokens] = useState<Partial<Record<ClientKind, string>>>(
    {},
  )

  const handleCopyCommand = async (provider: Provider, key: ApiKey) => {
    try {
      // If daemon is running, create a session for this key
      if (proxyStatus.isRunning) {
        const cliClients = getEffectiveKeyClients(provider, key).filter(isCliClientKind)
        const sessions = await Promise.all(
          cliClients.map(async (clientKind) => {
            const session = await getApi().session.create(provider.id, key.id, clientKind)
            if (clientKind === 'grok') {
              await getApi().terminal.prepareGrokConfig(key.id)
            }
            return [clientKind, session.sessionToken] as const
          }),
        )
        setProxySessionTokens(Object.fromEntries(sessions))
      } else {
        setProxySessionTokens({})
      }
    } catch (error) {
      console.error('Failed to prepare copy command:', error)
      setProxySessionTokens({})
    }

    setCopyCommandKey({ provider, key })
    setCopyCommandModalOpen(true)
  }

  // Generate command based on proxy status and terminal type
  const generateCommand = (
    type: string, // v3.2.0: 改为 string 以支持 ClientKind
    provider: Provider,
    key: ApiKey,
    useProxy: boolean,
    sessionToken?: string,
  ): string => {
    const isGrok = type === 'grok'
    const envVars: Record<string, string> = {}

    if (useProxy && proxyStatus.isRunning && sessionToken) {
      if (isGrok) {
        envVars.CC_USE_GROK_TOKEN = sessionToken
      } else {
        const baseUrl = `http://localhost:${proxyStatus.port}`
        envVars['ANTHROPIC_BASE_URL'] = baseUrl
        envVars['API_TIMEOUT_MS'] = '3000000'
        envVars['CLAUDE_CODE_ATTRIBUTION_HEADER'] = '0'
        envVars['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1'
        envVars['ANTHROPIC_AUTH_TOKEN'] = sessionToken
      }
    } else {
      if (isGrok) {
        envVars.XAI_API_KEY = key.value
      } else {
        const clientKind = type === 'claude' ? 'claude_code' : (type as ClientKind)
        envVars['ANTHROPIC_BASE_URL'] = key.clientConfigs?.[clientKind]?.baseUrl || provider.baseUrl
        envVars['API_TIMEOUT_MS'] = '3000000'
        envVars['CLAUDE_CODE_ATTRIBUTION_HEADER'] = '0'
        envVars['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1'
        envVars['ANTHROPIC_AUTH_TOKEN'] = key.value
      }
    }

    const cliCommand = isGrok && useProxy ? 'grok -m cc-use' : isGrok ? 'grok' : 'claude'
    return formatEnvCommand(envVars, cliCommand)
  }

  // Handle edit key
  // Drag-and-drop reorder handlers
  const loadModels = async (provider: Provider, apiKeyId: string) => {
    const requestId = ++modelListRequestId.current
    setModelList([])
    setModelListError(false)
    setModelListLoading(true)
    try {
      const models = await getApi().provider.modelList(provider.id, apiKeyId)
      if (requestId === modelListRequestId.current) setModelList(models)
    } catch {
      if (requestId === modelListRequestId.current) setModelListError(true)
    } finally {
      if (requestId === modelListRequestId.current) setModelListLoading(false)
    }
  }

  const handleViewModels = (provider: Provider) => {
    const keys = apiKeys[provider.id] || []
    const defaultKey = keys.find((key) => key.isActive && !key.isExhausted) || keys[0]
    setModelListProvider(provider)
    setModelListOpen(true)
    setModelList([])
    setModelListApiKeyId(defaultKey?.id)
    setModelListError(false)
    setModelListLoading(false)
    if (defaultKey) void loadModels(provider, defaultKey.id)
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
    setKeyEditOpen(true)
  }

  // Handle add key with optional provider context
  const handleAddKey = (providerId?: string) => {
    setEditingKey(null)
    setDefaultProviderId(providerId)
    setKeyEditOpen(true)
  }

  // Handle key save
  const handleSaveKey = async (input: ApiKeyEditorInput) => {
    if (input.id) {
      await updateApiKey(toUpdateApiKeyInput(input))
    } else {
      await createApiKey(toCreateApiKeyInput(input))
    }
  }

  return (
    <div className={styles.container}>
      {/* Header - Fixed */}
      <div className={styles.header}>
        <div>
          <Title level={3} className='m-0! mb-1!'>
            {t('keys.title') || 'API 密钥'}
          </Title>
          <Text type='secondary'>{t('keys.subtitle') || '管理您的 API 密钥和供应商'}</Text>
        </div>
        <Space>
          <Button
            type='primary'
            icon={<CloudServerOutlined />}
            onClick={handleAddProvider}
            size='large'
          >
            {t('providers.addProvider')}
          </Button>
        </Space>
      </div>

      {/* Filter Tabs - Fixed */}
      <div className={styles.filterSection}>
        <div className={styles.filterBar}>
          {/* "All Keys" tab — not sortable */}
          <div
            className={`${styles.filterTab} ${activeFilter === 'all' ? styles.filterTabActive : ''}`}
            onClick={() => setActiveFilter('all')}
          >
            <Space size={4}>
              <span>{t('keys.allKeys') || '全部密钥'}</span>
              <Badge count={allApiKeys.length} showZero className={styles.filterBadge} />
            </Space>
          </div>

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
                    <Avatar
                      src={getProviderIconSrc(provider)}
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
                <div key={provider.id} className={styles.keyGroup}>
                  {/* Provider Header */}
                  <div className={styles.groupHeader}>
                    <div className={styles.groupInfo}>
                      <Avatar
                        src={getProviderIconSrc(provider)}
                        size={20}
                        style={{ background: 'transparent' }}
                      />
                      <Text strong className={styles.groupName}>
                        {provider.name}
                      </Text>
                      {isOfficialDeepSeekProvider(provider) && (
                        <Tag color='blue' variant='filled'>
                          官方
                        </Tag>
                      )}
                      {balance !== undefined && (
                        <Tag icon={<WalletOutlined />} color='blue'>
                          ${balance.toFixed(2)}
                        </Tag>
                      )}
                      {providerMetrics[provider.name] ? (
                        <div className={styles.providerHealth}>
                          <Progress
                            type='circle'
                            size={36}
                            strokeWidth={10}
                            percent={
                              providerMetrics[provider.name].totalRequests > 0
                                ? (providerMetrics[provider.name].successfulRequests /
                                    providerMetrics[provider.name].totalRequests) *
                                  100
                                : 0
                            }
                            format={(percent) => (
                              <span className={styles.providerHealthRate}>
                                {Math.round(percent || 0)}%
                              </span>
                            )}
                            strokeColor={
                              providerMetrics[provider.name].totalRequests > 0 &&
                              providerMetrics[provider.name].successfulRequests /
                                providerMetrics[provider.name].totalRequests >=
                                0.95
                                ? token.colorSuccess
                                : token.colorWarning
                            }
                          />
                          <div className={styles.providerHealthText}>
                            <Text className={styles.providerHealthTitle}>近 24 小时成功率</Text>
                            <Text type='secondary' className={styles.providerHealthMeta}>
                              {providerMetrics[provider.name].successfulRequests}/
                              {providerMetrics[provider.name].totalRequests} 次 · 上游错误{' '}
                              {providerMetrics[provider.name].upstreamErrors}
                            </Text>
                          </div>
                        </div>
                      ) : (
                        <Text type='secondary' className={styles.providerHealthEmpty}>
                          近 24 小时暂无请求
                        </Text>
                      )}
                    </div>
                    <Space size={8}>
                      <Tooltip
                        title={provider.isActive ? t('common.active') : t('common.inactive')}
                      >
                        <Switch
                          size='small'
                          checked={provider.isActive}
                          onChange={(checked) => handleToggleProvider(provider, checked)}
                        />
                      </Tooltip>
                      <Tooltip title={t('usageDetail.openProvider')}>
                        <Button
                          type='text'
                          size='small'
                          icon={<LineChartOutlined />}
                          onClick={() =>
                            setUsageScope({
                              type: 'provider',
                              providerId: provider.id,
                              name: provider.name,
                            })
                          }
                        />
                      </Tooltip>
                      {provider.walletBalanceType !== 'none' && (
                        <Tooltip title={t('providers.refreshBalance')}>
                          <Button
                            type='text'
                            size='small'
                            icon={<ReloadOutlined spin={refreshingIds.has(provider.id)} />}
                            onClick={() => handleRefreshBalance(provider.id)}
                            disabled={refreshingIds.has(provider.id)}
                          />
                        </Tooltip>
                      )}
                      <Tooltip title={t('keys.viewModels') || '查看模型'}>
                        <Button
                          type='text'
                          size='small'
                          icon={<EyeOutlined />}
                          onClick={() => handleViewModels(provider)}
                        />
                      </Tooltip>
                      <Tooltip title={t('common.settings')}>
                        <Button
                          type='text'
                          size='small'
                          icon={<SettingOutlined />}
                          onClick={() => handleEditProvider(provider)}
                        />
                      </Tooltip>
                      <Popconfirm
                        title={t('providers.deleteProvider')}
                        description={t('providers.deleteProviderConfirm')}
                        onConfirm={() => handleDeleteProvider(provider.id)}
                        okText={t('common.delete')}
                        cancelText={t('common.cancel')}
                        okButtonProps={{ danger: true }}
                      >
                        <Button type='text' size='small' danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </Space>
                  </div>

                  {/* Keys Grid - 一排两个 */}
                  <Row gutter={[16, 16]}>
                    {keys.map((key) => (
                      <Col key={key.id} xs={24} sm={24} md={12}>
                        <Card
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
                                        <Avatar
                                          src={TYPE_ICONS[clientIconType(clientKind)]}
                                          size={16}
                                          style={{ background: 'transparent' }}
                                        />
                                      </Tooltip>
                                    )
                                  })}
                                </div>
                              </div>
                            </div>
                            <Switch
                              size='small'
                              checked={!key.isExhausted}
                              onChange={(checked) => handleToggleKey(key, checked)}
                            />
                          </div>

                          {/* Stats Row */}
                          <div className={styles.statsRow}>
                            {/* Key Quota - 额度 */}
                            {key.usageType && key.usageType !== 'none' && (
                              <Tooltip title={t('keys.refreshQuota')}>
                                <div
                                  className={`${styles.statItem} ${styles.statItemClickable}`}
                                  onClick={() => handleRefreshKeyUsage(key.id)}
                                >
                                  <DollarOutlined style={{ color: token.colorSuccess }} />
                                  <span className={styles.statValue}>
                                    {key.cachedUsage?.isUnlimited
                                      ? '∞'
                                      : key.cachedUsage?.remaining != null
                                        ? `$${key.cachedUsage.remaining.toFixed(2)}`
                                        : '--'}
                                  </span>
                                  {refreshingKeyUsageIds.has(key.id) && (
                                    <ReloadOutlined spin style={{ fontSize: 12, marginLeft: 4 }} />
                                  )}
                                </div>
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

                          {/* Actions */}
                          <div className={styles.keyCardActions}>
                            {getEffectiveKeyClients(provider, key).includes('claude_code') ? (
                              <Tooltip title={t('keys.copyCommand')}>
                                <Button
                                  type='primary'
                                  size='small'
                                  icon={<PlayCircleOutlined />}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleCopyCommand(provider, key)
                                  }}
                                >
                                  {t('keys.copyCommand')}
                                </Button>
                              </Tooltip>
                            ) : (
                              <Tag color='blue'>配置接管</Tag>
                            )}
                            <Space size={4}>
                              <Tooltip title={t('usageDetail.openKey')}>
                                <Button
                                  type='text'
                                  size='small'
                                  icon={<LineChartOutlined />}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setUsageScope({
                                      type: 'key',
                                      providerId: provider.id,
                                      apiKeyId: key.id,
                                      name: key.alias || t('keys.unnamedKey'),
                                      providerName: provider.name,
                                    })
                                  }}
                                />
                              </Tooltip>
                              <Tooltip title={t('keys.copyKey')}>
                                <Button
                                  type='text'
                                  size='small'
                                  icon={<CopyOutlined />}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleDuplicateKey(key)
                                  }}
                                />
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
                              {provider.walletBalanceType !== 'none' && (
                                <Tooltip title={t('providers.refreshBalance')}>
                                  <Button
                                    type='text'
                                    size='small'
                                    icon={<ReloadOutlined spin={refreshingIds.has(provider.id)} />}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleRefreshBalance(provider.id)
                                    }}
                                    disabled={refreshingIds.has(provider.id)}
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
                                />
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
                            </Space>
                          </div>
                        </Card>
                      </Col>
                    ))}

                    {/* Add Key Card */}
                    <Col xs={24} sm={24} md={12}>
                      <Card
                        className={styles.addKeyCard}
                        variant='outlined'
                        onClick={() => handleAddKey(provider.id)}
                      >
                        <PlusOutlined className={styles.addIcon} />
                        <Text type='secondary'>{t('apiKeys.addKey')}</Text>
                      </Card>
                    </Col>
                  </Row>
                </div>
              ))}
            </div>
          )}
        </SimpleBar>
      </div>

      {/* Provider Modal */}
      <ProviderModal
        open={providerModalOpen}
        provider={editingProvider}
        onClose={() => {
          setProviderModalOpen(false)
          setEditingProvider(null)
        }}
        onSave={async (input) => {
          if (input.id) {
            await getApi().provider.update({ ...input, id: input.id })
          } else {
            await getApi().provider.create(input)
          }
          fetchProviders()
        }}
      />

      {/* Key Edit Modal */}
      <KeyEditModal
        open={keyEditOpen}
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

      {/* Copy Command List Modal */}
      <Modal
        title={
          <Space>
            {t('keys.commandList') || '终端命令'}
            <Tag color='blue'>{TERMINAL_TYPE_LABELS[terminalType]}</Tag>
          </Space>
        }
        open={copyCommandModalOpen}
        onCancel={() => {
          setCopyCommandModalOpen(false)
          setCopyCommandKey(null)
          setProxySessionTokens({})
        }}
        footer={null}
        width={700}
        style={{ top: 24 }}
        styles={{
          body: {
            overflow: 'hidden',
          },
        }}
      >
        {copyCommandKey && (
          <SimpleBar style={{ maxHeight: '75vh' }} autoHide={false}>
            <div className={styles.commandList}>
              <Text type='secondary' className={styles.commandListHint}>
                {t('keys.commandListHint') || '点击复制按钮复制对应命令'}
              </Text>

              {/* Proxy Mode Commands - only show if proxy is running */}
              {proxyStatus.isRunning && Object.keys(proxySessionTokens).length > 0 && (
                <>
                  <Text strong className={styles.commandSectionTitle}>
                    {t('keys.proxyMode') || '代理模式'}
                    <Tag color='success' style={{ marginLeft: 8 }}>
                      {t('keys.recommended') || '推荐'}
                    </Tag>
                  </Text>
                  <Text type='secondary' className={styles.commandSectionHint}>
                    {t('keys.proxyModeHint') || '通过代理服务，可记录使用量'}
                  </Text>
                  {getEffectiveKeyClients(copyCommandKey.provider, copyCommandKey.key)
                    .filter(isCliClientKind)
                    .filter((clientKind) => !!proxySessionTokens[clientKind])
                    .map((clientKind) => {
                      const command = generateCommand(
                        clientKind,
                        copyCommandKey.provider,
                        copyCommandKey.key,
                        true,
                        proxySessionTokens[clientKind],
                      )
                      return (
                        <div key={`proxy-${clientKind}`} className={styles.commandItem}>
                          <div className={styles.commandHeader}>
                            <Space>
                              <Avatar
                                src={TYPE_ICONS[clientIconType(clientKind)]}
                                size={20}
                                style={{ background: 'transparent' }}
                              />
                              <Text strong>{getClientKindLabel(clientKind)}</Text>
                            </Space>
                            <Button
                              type='primary'
                              size='small'
                              icon={<CopyOutlined />}
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(command)
                                  message.success(
                                    `${t('providers.commandCopied')} (${TERMINAL_TYPE_LABELS[terminalType]})`,
                                  )
                                } catch {
                                  message.error(t('providers.copyFailed'))
                                }
                              }}
                            >
                              {t('common.copy') || '复制'}
                            </Button>
                          </div>
                          <div className={styles.commandCode}>
                            <code>{command}</code>
                          </div>
                        </div>
                      )
                    })}
                  <Divider style={{ margin: '16px 0' }} />
                </>
              )}

              {/* Direct Mode Commands */}
              <Text strong className={styles.commandSectionTitle}>
                {proxyStatus.isRunning
                  ? t('keys.directMode') || '直连模式'
                  : t('keys.commandList') || '终端命令'}
              </Text>
              {proxyStatus.isRunning && (
                <Text type='secondary' className={styles.commandSectionHint}>
                  {t('keys.directModeHint') || '直接连接供应商，不经过代理'}
                </Text>
              )}
              {getEffectiveKeyClients(copyCommandKey.provider, copyCommandKey.key)
                .filter(isCliClientKind)
                .map((clientKind) => {
                  const command = generateCommand(
                    clientKind,
                    copyCommandKey.provider,
                    copyCommandKey.key,
                    false,
                  )
                  return (
                    <div key={`direct-${clientKind}`} className={styles.commandItem}>
                      <div className={styles.commandHeader}>
                        <Space>
                          <Avatar
                            src={TYPE_ICONS[clientIconType(clientKind)]}
                            size={20}
                            style={{ background: 'transparent' }}
                          />
                          <Text strong>{getClientKindLabel(clientKind)}</Text>
                        </Space>
                        <Button
                          type={proxyStatus.isRunning ? 'default' : 'primary'}
                          size='small'
                          icon={<CopyOutlined />}
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(command)
                              message.success(
                                `${t('providers.commandCopied')} (${TERMINAL_TYPE_LABELS[terminalType]})`,
                              )
                            } catch {
                              message.error(t('providers.copyFailed'))
                            }
                          }}
                        >
                          {t('common.copy') || '复制'}
                        </Button>
                      </div>
                      <div className={styles.commandCode}>
                        <code>{command}</code>
                      </div>
                    </div>
                  )
                })}
              {getEffectiveKeyClients(copyCommandKey.provider, copyCommandKey.key).some(
                (clientKind) => !isCliClientKind(clientKind),
              ) && (
                <Text type='secondary' style={{ display: 'block', marginTop: 8 }}>
                  Codex Desktop 和 Claude Desktop 请在对应页面选择此密钥并执行配置接管。
                </Text>
              )}
            </div>
          </SimpleBar>
        )}
      </Modal>

      {/* Model List Modal */}
      <Modal
        title={
          <Space>
            <EyeOutlined />
            <span>{modelListProvider?.name || ''}</span>
            <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>
              — {t('keys.models') || '可用模型'}
            </span>
          </Space>
        }
        open={modelListOpen}
        onCancel={() => {
          modelListRequestId.current += 1
          setModelListOpen(false)
          setModelListProvider(null)
          setModelList([])
          setModelListApiKeyId(undefined)
          setModelListError(false)
          setModelListLoading(false)
        }}
        footer={null}
        width={500}
        style={{ top: 24 }}
      >
        <Space direction='vertical' size={16} style={{ width: '100%' }}>
          <div>
            <Text type='secondary' style={{ display: 'block', marginBottom: 6, fontSize: 12 }}>
              {t('keys.modelListKey') || '读取模型使用的密钥'}
            </Text>
            <Select
              value={modelListApiKeyId}
              placeholder={t('keys.modelListKeyPlaceholder') || '选择 API Key'}
              disabled={modelListKeys.length === 0}
              style={{ width: '100%' }}
              onChange={(apiKeyId) => {
                setModelListApiKeyId(apiKeyId)
                if (modelListProvider) void loadModels(modelListProvider, apiKeyId)
              }}
              options={modelListKeys.map((key) => ({
                value: key.id,
                label: `${key.alias || t('keys.unnamedKey')}${
                  key.isExhausted ? ` (${t('keys.exhausted')})` : ''
                }`,
              }))}
            />
          </div>
          {modelListLoading ? (
            <div className='empty-state' style={{ padding: '48px 0' }}>
              <Spin />
            </div>
          ) : modelListKeys.length === 0 ? (
            <div className='empty-state' style={{ padding: '48px 0' }}>
              <Text type='secondary'>{t('keys.modelListNoKey') || '该供应商暂无 API Key'}</Text>
            </div>
          ) : modelListError || modelList.length === 0 ? (
            <div className='empty-state' style={{ padding: '48px 0' }}>
              <Text type='secondary'>{t('keys.modelsFetchFailed') || '无法获取模型列表'}</Text>
            </div>
          ) : (
            <SimpleBar style={{ maxHeight: '60vh' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {modelList.map((model) => (
                  <div
                    key={model}
                    style={{
                      padding: '8px 12px',
                      borderRadius: 6,
                      fontSize: 13,
                      fontFamily: 'var(--font-mono)',
                      border: '1px solid var(--border-subtle)',
                      background: 'var(--surface-sunken)',
                    }}
                  >
                    {model}
                  </div>
                ))}
                {modelList.length > 0 && (
                  <Text
                    type='secondary'
                    style={{ fontSize: 12, textAlign: 'center', marginTop: 8 }}
                  >
                    {t('keys.modelsCount', { count: modelList.length }) ||
                      `共 ${modelList.length} 个模型`}
                  </Text>
                )}
              </div>
            </SimpleBar>
          )}
        </Space>
      </Modal>
    </div>
  )
}
