/**
 * Keys - 以 Key 为核心维度的管理页面
 * Provider 作为分组/筛选器
 */
import { useEffect, useState, useMemo } from 'react'
import {
  Typography,
  Button,
  Row,
  Col,
  Spin,
  theme,
  Card,
  Segmented,
  Space,
  Tag,
  Tooltip,
  Switch,
  Popconfirm,
  Badge,
  Avatar,
  Modal,
  Divider,
} from 'antd'
import { useAppMessage } from '../hooks/useAppMessage'
import {
  PlusOutlined,
  KeyOutlined,
  CloudServerOutlined,
  SettingOutlined,
  DeleteOutlined,
  WalletOutlined,
  ReloadOutlined,
  GlobalOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  EditOutlined,
  FireOutlined,
  CopyOutlined,
  DollarOutlined,
  CloudDownloadOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'
import ProviderModal from '../components/providers/ProviderModal'
import GlobalConfigModal from '../components/providers/GlobalConfigModal'
import KeyEditModal from '../components/keys/KeyEditModal'
import type { Provider, ApiKey, ProviderType } from '@shared/types'
import { getProviderTypeConfig, formatEnvCommand, TERMINAL_TYPE_LABELS } from '@shared/types'
import { useSettingsStore } from '../stores/settingsStore'
import styles from './Keys.module.css'

// Import provider type icons
import claudeIcon from '../assets/provider-icons/claude.svg'
import openaiIcon from '../assets/provider-icons/openai.svg'
import zhipuIcon from '../assets/provider-icons/zhipu.svg'
import minimaxIcon from '../assets/provider-icons/minimax.svg'
import deepseekIcon from '../assets/provider-icons/deepseek.svg'
import siliconflowIcon from '../assets/provider-icons/siliconflow.svg'
import newapiIcon from '../assets/provider-icons/newapi.svg'

const { Title, Text } = Typography

// Type icon mapping
const TYPE_ICONS: Record<ProviderType, string> = {
  claude: claudeIcon,
  codex: openaiIcon,
}

// Preset provider icon mapping
const PRESET_ICON_MAP: Record<string, string> = {
  claude: claudeIcon,
  codex: openaiIcon,
  openai: openaiIcon,
  zhipu: zhipuIcon,
  minimax: minimaxIcon,
  deepseek: deepseekIcon,
  siliconflow: siliconflowIcon,
  newapi: newapiIcon,
}

// Get provider icon src
function getProviderIconSrc(provider: Provider): string {
  if (!provider.icon) {
    return PRESET_ICON_MAP[provider.type ?? 'claude'] || PRESET_ICON_MAP.claude
  }
  if (PRESET_ICON_MAP[provider.icon]) {
    return PRESET_ICON_MAP[provider.icon]
  }
  return `file://${provider.icon}`
}

export default function Keys() {
  const { t } = useTranslation()
  const message = useAppMessage()
  const { token } = theme.useToken()
  const {
    providers,
    loading: providersLoading,
    fetchProviders,
    refreshBalance,
    deleteProvider,
  } = useProviderStore()
  const { apiKeys, fetchAllApiKeys, getAllApiKeys, updateApiKey, deleteApiKey } = useApiKeyStore()
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
  const [globalConfigOpen, setGlobalConfigOpen] = useState(false)

  // Refreshing states
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set())
  const [refreshingKeyUsageIds, setRefreshingKeyUsageIds] = useState<Set<string>>(new Set())
  const [syncingPricingIds, setSyncingPricingIds] = useState<Set<string>>(new Set())

  // Cost stats per key (today and total)
  const [keyCostStats, setKeyCostStats] = useState<
    Record<string, { todayCost: number; totalCost: number }>
  >({})

  // Get all API keys
  const allApiKeys = getAllApiKeys()

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  // Fetch API keys for all providers
  useEffect(() => {
    if (providers.length > 0) {
      fetchAllApiKeys(providers.map((p) => p.id))
    }
  }, [providers, fetchAllApiKeys])

  // Fetch cost stats for all keys
  useEffect(() => {
    if (allApiKeys.length === 0) return

    const fetchCostStats = async () => {
      try {
        const stats = await window.api.requestLog.getKeyCosts()
        const costMap: Record<string, { todayCost: number; totalCost: number }> = {}
        stats.forEach((item) => {
          costMap[item.keyId] = {
            todayCost: item.todayCost,
            totalCost: item.totalCost,
          }
        })
        setKeyCostStats(costMap)
      } catch (error) {
        console.error('Failed to fetch cost stats:', error)
      }
    }
    fetchCostStats()
  }, [allApiKeys.length])

  // Build filter options
  const filterOptions = useMemo(() => {
    const options: { label: React.ReactNode; value: string }[] = [
      {
        label: (
          <Space size={4}>
            <span>{t('keys.allKeys') || '全部密钥'}</span>
            <Badge count={allApiKeys.length} showZero className={styles.filterBadge} />
          </Space>
        ),
        value: 'all',
      },
    ]

    providers.forEach((provider) => {
      const keyCount = (apiKeys[provider.id] || []).length
      options.push({
        label: (
          <Space size={4}>
            <span>{provider.name}</span>
            <Badge count={keyCount} showZero className={styles.filterBadge} />
          </Space>
        ),
        value: provider.id,
      })
    })

    return options
  }, [providers, apiKeys, allApiKeys, t])

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
    } catch (error) {
      message.error(t('providers.deleteProviderFailed'))
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
    } catch (error) {
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
      const result = await window.api.keyUsage.refresh(keyId)
      if (result.error) {
        message.error(result.error)
      } else {
        message.success(t('keys.quota') + ' ' + t('messages.success'))
      }
      // Refresh keys to get updated cached usage
      fetchAllApiKeys(providers.map((p) => p.id))
    } catch (error) {
      message.error(t('keys.refreshQuotaFailed'))
    } finally {
      setRefreshingKeyUsageIds((prev) => {
        const next = new Set(prev)
        next.delete(keyId)
        return next
      })
    }
  }

  // Handle sync pricing
  const handleSyncPricing = async (providerId: string) => {
    setSyncingPricingIds((prev) => new Set(prev).add(providerId))
    try {
      const result = await window.api.provider.syncPricing(providerId)
      if (result.error) {
        message.error(result.error)
      } else {
        message.success(t('keys.syncPricingSuccess', { count: result.count }))
        fetchProviders()
      }
    } catch (error) {
      message.error(t('keys.syncPricingFailed'))
    } finally {
      setSyncingPricingIds((prev) => {
        const next = new Set(prev)
        next.delete(providerId)
        return next
      })
    }
  }

  // Handle key actions
  const handleToggleKey = async (key: ApiKey, active: boolean) => {
    try {
      await updateApiKey({ id: key.id, isExhausted: !active })
    } catch (error) {
      message.error(t('messages.error'))
    }
  }

  const handleDeleteKey = async (key: ApiKey) => {
    try {
      await deleteApiKey(key.providerId, key.id)
      message.success(t('apiKeys.keyDeleted'))
    } catch (error) {
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
  const [proxyStatus, setProxyStatus] = useState<{
    isRunning: boolean
    port: number
  }>({ isRunning: false, port: 12345 })
  const [proxySessionToken, setProxySessionToken] = useState<string | null>(null)

  const handleCopyCommand = async (provider: Provider, key: ApiKey) => {
    // Fetch current proxy status
    try {
      const status = await window.api.proxy.status()
      setProxyStatus(status)

      // If proxy is running, create a session for this key
      if (status.isRunning) {
        const session = await window.api.session.create(provider.id, key.id)
        setProxySessionToken(session.sessionToken)
      } else {
        setProxySessionToken(null)
      }
    } catch (error) {
      console.error('Failed to get proxy status:', error)
      setProxyStatus({ isRunning: false, port: 12345 })
      setProxySessionToken(null)
    }

    setCopyCommandKey({ provider, key })
    setCopyCommandModalOpen(true)
  }

  // Generate command based on proxy status and terminal type
  const generateCommand = (
    type: ProviderType,
    provider: Provider,
    key: ApiKey,
    useProxy: boolean,
  ): string => {
    const config = getProviderTypeConfig(type)
    const envVars: Record<string, string> = {}

    if (useProxy && proxyStatus.isRunning && proxySessionToken) {
      const baseUrl = `http://localhost:${proxyStatus.port}`
      envVars[config.envBaseUrlName] = baseUrl
      if (type === 'codex') {
        envVars[config.envKeyName] = proxySessionToken
      } else {
        envVars['API_TIMEOUT_MS'] = '3000000'
        envVars['CLAUDE_CODE_ATTRIBUTION_HEADER'] = '0'
        envVars['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1'
        envVars['ANTHROPIC_AUTH_TOKEN'] = proxySessionToken
      }
    } else {
      envVars[config.envBaseUrlName] = provider.baseUrl
      if (type === 'codex') {
        envVars[config.envKeyName] = key.value
      } else {
        envVars['API_TIMEOUT_MS'] = '3000000'
        envVars['CLAUDE_CODE_ATTRIBUTION_HEADER'] = '0'
        envVars['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1'
        envVars['ANTHROPIC_AUTH_TOKEN'] = key.value
      }
    }

    return formatEnvCommand(envVars, config.cliCommand, terminalType)
  }

  // Handle edit key
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
  const handleSaveKey = async (input: {
    id?: string
    providerId: string
    alias?: string
    value: string
    types: ProviderType[]
    config?: Record<string, unknown>
    costMultiplier?: number
    usageType?: 'none' | 'newapi' | 'custom'
    usageUrl?: string
    usagePath?: string
    usageHeaders?: string
  }) => {
    if (input.id) {
      await window.api.apiKey.update({
        id: input.id,
        alias: input.alias,
        value: input.value,
        types: input.types,
        config: input.config,
        costMultiplier: input.costMultiplier,
        usageType: input.usageType,
        usageUrl: input.usageUrl,
        usagePath: input.usagePath,
        usageHeaders: input.usageHeaders,
      })
    } else {
      await window.api.apiKey.create({
        providerId: input.providerId,
        alias: input.alias,
        value: input.value,
        types: input.types,
        config: input.config,
        costMultiplier: input.costMultiplier,
        usageType: input.usageType,
        usageUrl: input.usageUrl,
        usagePath: input.usagePath,
        usageHeaders: input.usageHeaders,
      })
    }
    fetchAllApiKeys(providers.map((p) => p.id))
  }

  return (
    <div className={styles.container}>
      {/* Header - Fixed */}
      <div className={styles.header}>
        <div>
          <Title level={3} className='!m-0 !mb-1'>
            {t('keys.title') || 'API 密钥'}
          </Title>
          <Text type='secondary'>{t('keys.subtitle') || '管理您的 API 密钥和供应商'}</Text>
        </div>
        <Space>
          <Button icon={<GlobalOutlined />} onClick={() => setGlobalConfigOpen(true)} size='large'>
            {t('globalConfig.title') || '全局配置'}
          </Button>
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
        <Segmented
          value={activeFilter}
          onChange={(value) => setActiveFilter(value as string)}
          options={filterOptions}
          className={styles.filterSegmented}
        />
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
              <Title level={4} className='!mb-2'>
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
                      {balance !== undefined && (
                        <Tag icon={<WalletOutlined />} color='blue'>
                          ${balance.toFixed(2)}
                        </Tag>
                      )}
                      {provider.lastPricingSyncedAt && provider.cachedModelPricing && (
                        <Tooltip title={`${t('keys.syncPricing')} - ${new Date(provider.lastPricingSyncedAt).toLocaleString()}`}>
                          <Tag color='green'>
                            {t('keys.pricingSynced', { count: Object.keys(provider.cachedModelPricing).length })}
                          </Tag>
                        </Tooltip>
                      )}
                    </div>
                    <Space size={8}>
                      <Tooltip title={t('keys.syncPricing')}>
                        <Button
                          type='text'
                          size='small'
                          icon={<CloudDownloadOutlined spin={syncingPricingIds.has(provider.id)} />}
                          onClick={() => handleSyncPricing(provider.id)}
                          disabled={syncingPricingIds.has(provider.id)}
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
                                  {key.types.map((type) => (
                                    <Tooltip
                                      key={type}
                                      title={type === 'codex' ? 'Codex' : 'Claude'}
                                    >
                                      <Avatar
                                        src={TYPE_ICONS[type]}
                                        size={16}
                                        style={{ background: 'transparent' }}
                                      />
                                    </Tooltip>
                                  ))}
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
                                      : key.cachedUsage?.remaining !== undefined
                                        ? `$${key.cachedUsage.remaining.toFixed(2)}`
                                        : '--'}
                                  </span>
                                  {refreshingKeyUsageIds.has(key.id) && (
                                    <ReloadOutlined spin style={{ fontSize: 12, marginLeft: 4 }} />
                                  )}
                                </div>
                              </Tooltip>
                            )}
                            {/* Today's cost - 今日费用 */}
                            <div className={styles.statItem}>
                              <FireOutlined style={{ color: token.colorWarning }} />
                              <span className={styles.statValue}>
                                {t('keys.todayCost') || '今日'}: $
                                {(keyCostStats[key.id]?.todayCost || 0).toFixed(4)}
                              </span>
                            </div>
                            {/* Total cost - 累计费用 */}
                            <div className={styles.statItem}>
                              <PlayCircleOutlined style={{ color: token.colorTextSecondary }} />
                              <span className={styles.statValue}>
                                {t('keys.totalCost') || '累计'}: $
                                {(keyCostStats[key.id]?.totalCost || 0).toFixed(4)}
                              </span>
                            </div>
                          </div>

                          {/* Actions */}
                          <div className={styles.keyCardActions}>
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
                                      window.api.system.openExternal(provider.website!)
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
            await window.api.provider.update(input as any)
          } else {
            await window.api.provider.create(input as any)
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

      {/* Global Config Modal */}
      <GlobalConfigModal open={globalConfigOpen} onClose={() => setGlobalConfigOpen(false)} />

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
          setProxySessionToken(null)
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
              {proxyStatus.isRunning && proxySessionToken && (
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
                  {copyCommandKey.key.types.map((type) => {
                    const command = generateCommand(
                      type,
                      copyCommandKey.provider,
                      copyCommandKey.key,
                      true,
                    )
                    return (
                      <div key={`proxy-${type}`} className={styles.commandItem}>
                        <div className={styles.commandHeader}>
                          <Space>
                            <Avatar
                              src={TYPE_ICONS[type]}
                              size={20}
                              style={{ background: 'transparent' }}
                            />
                            <Text strong>{type === 'claude' ? 'Claude Code' : 'Codex CLI'}</Text>
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
                              } catch (error) {
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
              {copyCommandKey.key.types.map((type) => {
                const command = generateCommand(
                  type,
                  copyCommandKey.provider,
                  copyCommandKey.key,
                  false,
                )
                return (
                  <div key={`direct-${type}`} className={styles.commandItem}>
                    <div className={styles.commandHeader}>
                      <Space>
                        <Avatar
                          src={TYPE_ICONS[type]}
                          size={20}
                          style={{ background: 'transparent' }}
                        />
                        <Text strong>{type === 'claude' ? 'Claude Code' : 'Codex CLI'}</Text>
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
                          } catch (error) {
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
            </div>
          </SimpleBar>
        )}
      </Modal>
    </div>
  )
}
