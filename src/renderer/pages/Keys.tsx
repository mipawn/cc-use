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
  message,
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
} from 'antd'
import {
  PlusOutlined,
  KeyOutlined,
  CloudServerOutlined,
  SettingOutlined,
  DeleteOutlined,
  WalletOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  ReloadOutlined,
  GlobalOutlined,
  LinkOutlined,
  PlayCircleOutlined,
  EditOutlined,
  FireOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'
import ProviderModal from '../components/providers/ProviderModal'
import GlobalConfigModal from '../components/providers/GlobalConfigModal'
import KeyEditModal from '../components/keys/KeyEditModal'
import type { Provider, ApiKey, ProviderType } from '@shared/types'
import { getProviderTypeConfig } from '@shared/types'
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
  const { token } = theme.useToken()
  const {
    providers,
    loading: providersLoading,
    fetchProviders,
    refreshBalance,
    deleteProvider,
  } = useProviderStore()
  const {
    apiKeys,
    fetchAllApiKeys,
    getAllApiKeys,
    updateApiKey,
    deleteApiKey,
  } = useApiKeyStore()

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

  // Today's usage stats per key
  const [keyUsageStats, setKeyUsageStats] = useState<Record<string, number>>({})
  // Total usage stats per key (all time)
  const [keyTotalUsageStats, setKeyTotalUsageStats] = useState<Record<string, number>>({})

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

  // Fetch usage stats (today and all time)
  useEffect(() => {
    if (allApiKeys.length === 0) return

    const fetchStats = async () => {
      try {
        // Today's stats
        const todayStats = await window.api.usageLog.getStats('today')
        const todayByKey: Record<string, number> = {}
        todayStats.byKey.forEach((item) => {
          todayByKey[item.keyId] = item.count
        })
        setKeyUsageStats(todayByKey)

        // All time stats
        const allStats = await window.api.usageLog.getStats('all')
        const totalByKey: Record<string, number> = {}
        allStats.byKey.forEach((item) => {
          totalByKey[item.keyId] = item.count
        })
        setKeyTotalUsageStats(totalByKey)
      } catch (error) {
        console.error('Failed to fetch stats:', error)
      }
    }
    fetchStats()
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

  // State for copy command type selection modal
  const [copyCommandModalOpen, setCopyCommandModalOpen] = useState(false)
  const [copyCommandKey, setCopyCommandKey] = useState<{ provider: Provider; key: ApiKey } | null>(null)

  const handleCopyCommand = async (provider: Provider, key: ApiKey, type?: ProviderType) => {
    // If key has multiple types and no type specified, show selection modal
    if (!type && key.types.length > 1) {
      setCopyCommandKey({ provider, key })
      setCopyCommandModalOpen(true)
      return
    }

    // Use specified type or first type
    const selectedType = type || key.types[0]
    const config = getProviderTypeConfig(selectedType)

    let command: string
    if (selectedType === 'codex') {
      command = `${config.envBaseUrlName}="${provider.baseUrl}" ${config.envKeyName}="${key.value}" ${config.cliCommand}`
    } else {
      command = `${config.envBaseUrlName}="${provider.baseUrl}" API_TIMEOUT_MS=3000000 CLAUDE_CODE_ATTRIBUTION_HEADER=0 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 ANTHROPIC_AUTH_TOKEN="${key.value}" ${config.cliCommand}`
    }

    try {
      await navigator.clipboard.writeText(command)
      message.success(t('providers.commandCopied'))
    } catch (error) {
      message.error(t('providers.copyFailed'))
    }
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
  }) => {
    if (input.id) {
      await window.api.apiKey.update({
        id: input.id,
        alias: input.alias,
        value: input.value,
        types: input.types,
        config: input.config,
      })
    } else {
      await window.api.apiKey.create({
        providerId: input.providerId,
        alias: input.alias,
        value: input.value,
        types: input.types,
        config: input.config,
      })
    }
    fetchAllApiKeys(providers.map((p) => p.id))
  }

  return (
    <div className={styles.container}>
      {/* Header - Fixed */}
      <div className={styles.header}>
        <div>
          <Title level={3} className="!m-0 !mb-1">
            {t('keys.title') || 'API 密钥'}
          </Title>
          <Text type="secondary">{t('keys.subtitle') || '管理您的 API 密钥和服务商'}</Text>
        </div>
        <Space>
          <Button
            icon={<GlobalOutlined />}
            onClick={() => setGlobalConfigOpen(true)}
            size="large"
          >
            {t('globalConfig.title') || '全局配置'}
          </Button>
          <Button
            type="primary"
            icon={<CloudServerOutlined />}
            onClick={handleAddProvider}
            size="large"
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
          <div className="empty-state">
            <Spin size="large" />
          </div>
        ) : groupedKeys.length === 0 ? (
          <Card className="empty-state" variant="outlined">
            <KeyOutlined
              className="text-5xl mb-4"
              style={{ color: token.colorTextSecondary }}
            />
            <Title level={4} className="!mb-2">
              {t('keys.noKeys') || '暂无密钥'}
            </Title>
            <Text type="secondary" className="block">
              {t('keys.noKeysHint') || '添加服务商并配置 API 密钥以开始使用'}
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
                    <Tag icon={<WalletOutlined />} color="blue">
                      ${balance.toFixed(2)}
                    </Tag>
                  )}
                </div>
                <Space size={8}>
                  {provider.walletBalanceType !== 'none' && (
                    <Tooltip title={t('providers.refreshBalance')}>
                      <Button
                        type="text"
                        size="small"
                        icon={<ReloadOutlined spin={refreshingIds.has(provider.id)} />}
                        onClick={() => handleRefreshBalance(provider.id)}
                        disabled={refreshingIds.has(provider.id)}
                      />
                    </Tooltip>
                  )}
                  <Tooltip title={t('common.settings')}>
                    <Button
                      type="text"
                      size="small"
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
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                    />
                  </Popconfirm>
                </Space>
              </div>

              {/* Keys Grid - 一排两个 */}
              <Row gutter={[16, 16]}>
                {keys.map((key) => (
                  <Col key={key.id} xs={24} sm={24} md={12}>
                    <Card
                      className={`${styles.keyCard} ${key.isExhausted ? styles.exhausted : ''}`}
                      variant="outlined"
                    >
                      {/* Card Header */}
                      <div className={styles.keyCardHeader}>
                        <div className={styles.keyCardTitle}>
                          <div className={styles.keyStatus}>
                            {key.isExhausted ? (
                              <CloseCircleFilled style={{ color: token.colorError }} />
                            ) : (
                              <CheckCircleFilled style={{ color: token.colorSuccess }} />
                            )}
                          </div>
                          <div className={styles.keyTitleInfo}>
                            <Text strong className={styles.keyAlias}>
                              {key.alias || t('keys.unnamedKey')}
                            </Text>
                            <div className={styles.keyMeta}>
                              {/* Type icons - show all supported types */}
                              {key.types.map((type) => (
                                <Tooltip key={type} title={type === 'codex' ? 'Codex' : 'Claude'}>
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
                          size="small"
                          checked={!key.isExhausted}
                          onChange={(checked) => handleToggleKey(key, checked)}
                        />
                      </div>

                      {/* Stats Row */}
                      <div className={styles.statsRow}>
                        {/* Balance - 余额 */}
                        {balance !== undefined && (
                          <Tooltip title={t('providers.refreshBalance')}>
                            <div
                              className={`${styles.statItem} ${styles.statItemClickable}`}
                              onClick={() => handleRefreshBalance(provider.id)}
                            >
                              <WalletOutlined style={{ color: token.colorPrimary }} />
                              <span className={styles.statValue}>${balance.toFixed(2)}</span>
                              {refreshingIds.has(provider.id) && (
                                <ReloadOutlined spin style={{ fontSize: 12, marginLeft: 4 }} />
                              )}
                            </div>
                          </Tooltip>
                        )}
                        {/* Today's usage - 今日使用量 */}
                        <div className={styles.statItem}>
                          <FireOutlined style={{ color: token.colorWarning }} />
                          <span className={styles.statValue}>
                            {t('keys.todayUsage')}: {keyUsageStats[key.id] || 0}
                          </span>
                        </div>
                        {/* Total usage - 历史使用量 */}
                        <div className={styles.statItem}>
                          <PlayCircleOutlined style={{ color: token.colorTextSecondary }} />
                          <span className={styles.statValue}>
                            {t('keys.totalUsage')}: {keyTotalUsageStats[key.id] || 0}
                          </span>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className={styles.keyCardActions}>
                        <Tooltip title={t('keys.copyCommand')}>
                          <Button
                            type="primary"
                            size="small"
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
                          {provider.website && (
                            <Tooltip title={t('keys.visitWebsite')}>
                              <Button
                                type="text"
                                size="small"
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
                                type="text"
                                size="small"
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
                              type="text"
                              size="small"
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
                              type="text"
                              size="small"
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
                    variant="outlined"
                    onClick={() => handleAddKey(provider.id)}
                  >
                    <PlusOutlined className={styles.addIcon} />
                    <Text type="secondary">{t('apiKeys.addKey')}</Text>
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
      <GlobalConfigModal
        open={globalConfigOpen}
        onClose={() => setGlobalConfigOpen(false)}
      />

      {/* Copy Command Type Selection Modal */}
      <Modal
        title={t('keys.selectCommandType') || '选择命令类型'}
        open={copyCommandModalOpen}
        onCancel={() => {
          setCopyCommandModalOpen(false)
          setCopyCommandKey(null)
        }}
        footer={null}
        width={400}
      >
        {copyCommandKey && (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            {copyCommandKey.key.types.map((type) => (
              <Button
                key={type}
                block
                size="large"
                icon={
                  <Avatar
                    src={TYPE_ICONS[type]}
                    size={20}
                    style={{ background: 'transparent', marginRight: 8 }}
                  />
                }
                onClick={() => {
                  handleCopyCommand(copyCommandKey.provider, copyCommandKey.key, type)
                  setCopyCommandModalOpen(false)
                  setCopyCommandKey(null)
                }}
              >
                {type === 'claude' ? 'Claude Code' : 'Codex CLI'}
              </Button>
            ))}
          </Space>
        )}
      </Modal>
    </div>
  )
}
