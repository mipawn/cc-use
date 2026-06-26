import { useState } from 'react'
import { Button, Empty, Tag, Tooltip, Typography } from 'antd'
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CheckCircleOutlined,
  QuestionCircleOutlined,
  StarOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import clsx from 'clsx'
import type { Provider, ApiKey, ClientKind } from '@shared/types'
import { supportsKeyClient } from '../../utils/clientSupport'
import claudeIcon from '../../assets/provider-icons/claude.svg'
import openaiIcon from '../../assets/provider-icons/openai.svg'
import deepseekIcon from '../../assets/provider-icons/deepseek.svg'
import newapiIcon from '../../assets/provider-icons/newapi.svg'
import styles from './TakeoverConfigTab.module.css'

const { Text } = Typography

export type TakeoverStatus = 'taken_over' | 'official' | 'not_found' | 'unknown' | 'error'

const PRESET_ICON_MAP: Record<string, string> = {
  claude: claudeIcon,
  claude_code: claudeIcon,
  claude_desktop: claudeIcon,
  codex: openaiIcon,
  openai: openaiIcon,
  deepseek: deepseekIcon,
  newapi: newapiIcon,
}

export interface TakeoverConfigTabProps {
  status: TakeoverStatus
  providers: Provider[]
  allKeys: ApiKey[]
  activeKeyId: string
  /** 旧入口兼容；新版优先看 targetClientKind + key 自身类型 */
  compatibleProviderType?: string
  /** 目标客户端类型（新版，使用 ClientKind） */
  targetClientKind?: ClientKind
  onTakeover: (keyId: string) => Promise<void>
  onReorderProviders?: (providerIds: string[]) => Promise<void> | void
  onReorderApiKeys?: (providerId: string, keyIds: string[]) => Promise<void> | void
  onEdit?: (key: ApiKey) => void
  onDelete?: (key: ApiKey) => void
  onToggleEnabled?: (key: ApiKey, enabled: boolean) => void
}

function statusBadge(status: TakeoverStatus) {
  switch (status) {
    case 'taken_over':
      return (
        <Tag color='green' icon={<CheckCircleOutlined />}>
          已接管
        </Tag>
      )
    case 'official':
      return <Tag color='blue'>官方配置</Tag>
    case 'not_found':
      return (
        <Tag color='default' icon={<QuestionCircleOutlined />}>
          配置不存在
        </Tag>
      )
    case 'error':
      return (
        <Tag color='warning' icon={<WarningOutlined />}>
          检测失败
        </Tag>
      )
    default:
      return <Tag color='warning'>未知</Tag>
  }
}

function getProviderIconSrc(provider: Provider): string {
  if (!provider.icon) {
    return PRESET_ICON_MAP[provider.type ?? 'claude'] || PRESET_ICON_MAP.claude
  }
  if (PRESET_ICON_MAP[provider.icon]) {
    return PRESET_ICON_MAP[provider.icon]
  }
  return `file://${provider.icon}`
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  const next = [...items]
  const [item] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, item)
  return next
}

function mergeVisibleOrder(allIds: string[], visibleIds: string[], nextVisibleIds: string[]) {
  const visibleSet = new Set(visibleIds)
  let visibleIndex = 0
  return allIds.map((id) => {
    if (!visibleSet.has(id)) return id
    const nextId = nextVisibleIds[visibleIndex]
    visibleIndex += 1
    return nextId
  })
}

function displayKeyName(apiKey: ApiKey) {
  return apiKey.alias || `${apiKey.value.slice(0, 10)}...${apiKey.value.slice(-4)}`
}

function KeyStatusTag({ apiKey, isSelected }: { apiKey: ApiKey; isSelected: boolean }) {
  if (!apiKey.isActive) {
    return (
      <Tag className={styles.statusTag} color='red'>
        <span className={styles.dot} />
        Offline
      </Tag>
    )
  }
  if (isSelected) {
    return (
      <Tag className={styles.statusTag} color='green'>
        <span className={styles.dot} />P{apiKey.priority} Active
      </Tag>
    )
  }
  return (
    <Tag className={styles.statusTag} color='default'>
      <span className={styles.dot} />
      Standby
    </Tag>
  )
}

export default function TakeoverConfigTab({
  status,
  providers,
  allKeys,
  activeKeyId,
  compatibleProviderType,
  targetClientKind,
  onTakeover,
  onReorderProviders,
  onReorderApiKeys,
}: TakeoverConfigTabProps) {
  const [movingId, setMovingId] = useState<string | null>(null)
  const filteredProviders =
    compatibleProviderType && !targetClientKind
      ? providers.filter((p) => p.type === compatibleProviderType)
      : providers

  const grouped = filteredProviders
    .map((provider) => ({
      provider,
      keys: allKeys.filter(
        (k) =>
          k.providerId === provider.id &&
          (!targetClientKind || supportsKeyClient(provider, k, targetClientKind)),
      ),
    }))
    .filter((group) => group.keys.length > 0)

  const moveProvider = async (providerId: string, direction: -1 | 1) => {
    if (!onReorderProviders) return
    const visibleIds = grouped.map(({ provider }) => provider.id)
    const index = visibleIds.indexOf(providerId)
    const nextIndex = index + direction
    if (index < 0 || nextIndex < 0 || nextIndex >= visibleIds.length) return

    const nextVisibleIds = moveItem(visibleIds, index, nextIndex)
    const nextProviderIds = mergeVisibleOrder(
      providers.map((provider) => provider.id),
      visibleIds,
      nextVisibleIds,
    )
    setMovingId(`provider:${providerId}`)
    try {
      await onReorderProviders(nextProviderIds)
    } finally {
      setMovingId(null)
    }
  }

  const moveKey = async (providerId: string, keyId: string, direction: -1 | 1) => {
    if (!onReorderApiKeys) return
    const providerKeys = allKeys.filter((key) => key.providerId === providerId)
    const group = grouped.find(({ provider }) => provider.id === providerId)
    if (!group) return

    const visibleIds = group.keys.map((key) => key.id)
    const index = visibleIds.indexOf(keyId)
    const nextIndex = index + direction
    if (index < 0 || nextIndex < 0 || nextIndex >= visibleIds.length) return

    const nextVisibleIds = moveItem(visibleIds, index, nextIndex)
    const nextKeyIds = mergeVisibleOrder(
      providerKeys.map((key) => key.id),
      visibleIds,
      nextVisibleIds,
    )
    setMovingId(`key:${keyId}`)
    try {
      await onReorderApiKeys(providerId, nextKeyIds)
    } finally {
      setMovingId(null)
    }
  }

  return (
    <div className={styles.root}>
      {/* 接管状态 */}
      <div className={styles.statusBar}>
        <div className={styles.statusText}>
          <Text strong>当前状态:</Text>
          {statusBadge(status)}
        </div>
      </div>

      {/* 密钥列表 — 按供应商分组 */}
      {grouped.length === 0 ? (
        <Empty
          description='暂无兼容的供应商，请先在「供应商密钥」Tab 中添加'
          style={{ marginTop: 60 }}
        />
      ) : (
        grouped.map(({ provider, keys }, providerIndex) => {
          return (
            <section key={provider.id} className={styles.providerPanel}>
              <div className={styles.providerHeader}>
                <div className={styles.providerTitle}>
                  <span className={styles.iconFrame}>
                    <img
                      src={getProviderIconSrc(provider)}
                      alt=''
                      className={styles.providerIcon}
                    />
                  </span>
                  <Text strong className={styles.providerName}>
                    {provider.name}
                  </Text>
                  <Text type='secondary' className={styles.keyCount}>
                    {keys.length} 个密钥
                  </Text>
                </div>
                {onReorderProviders && grouped.length > 1 && (
                  <div className={styles.sortControls}>
                    <Tooltip title='上移服务商'>
                      <Button
                        type='text'
                        size='small'
                        icon={<ArrowUpOutlined />}
                        disabled={providerIndex === 0}
                        loading={movingId === `provider:${provider.id}`}
                        onClick={() => void moveProvider(provider.id, -1)}
                      />
                    </Tooltip>
                    <Tooltip title='下移服务商'>
                      <Button
                        type='text'
                        size='small'
                        icon={<ArrowDownOutlined />}
                        disabled={providerIndex === grouped.length - 1}
                        loading={movingId === `provider:${provider.id}`}
                        onClick={() => void moveProvider(provider.id, 1)}
                      />
                    </Tooltip>
                  </div>
                )}
              </div>
              <div className={styles.table} role='table' aria-label={`${provider.name} 密钥`}>
                <div className={styles.tableHead} role='row'>
                  <div role='columnheader'>名称 (Name)</div>
                  <div role='columnheader'>级别 (Tier)</div>
                  <div role='columnheader'>延迟 (Latency)</div>
                  <div role='columnheader'>操作 (Action)</div>
                </div>
                {keys.map((key, keyIndex) => {
                  const isSelected = activeKeyId === key.id
                  const canTakeover = key.isActive
                  return (
                    <div
                      key={key.id}
                      className={clsx(styles.tableRow, isSelected && styles.selectedRow)}
                      role='row'
                    >
                      <div className={styles.nameCell} role='cell'>
                        <div className={styles.keyNameLine}>
                          <Tooltip title={displayKeyName(key)}>
                            <Text strong={isSelected} ellipsis className={styles.keyName}>
                              {displayKeyName(key)}
                            </Text>
                          </Tooltip>
                          {isSelected && <StarOutlined className={styles.starIcon} />}
                        </div>
                        {!provider.isActive && (
                          <Text type='secondary' className={styles.note}>
                            服务商已停用
                          </Text>
                        )}
                      </div>
                      <div className={styles.tierCell} role='cell'>
                        <KeyStatusTag apiKey={key} isSelected={isSelected} />
                      </div>
                      <div className={styles.latencyCell} role='cell'>
                        --
                      </div>
                      <div className={styles.actionCell} role='cell'>
                        {onReorderApiKeys && keys.length > 1 && (
                          <div className={styles.sortControls}>
                            <Tooltip title='上移密钥'>
                              <Button
                                type='text'
                                size='small'
                                icon={<ArrowUpOutlined />}
                                disabled={keyIndex === 0}
                                loading={movingId === `key:${key.id}`}
                                onClick={() => void moveKey(provider.id, key.id, -1)}
                              />
                            </Tooltip>
                            <Tooltip title='下移密钥'>
                              <Button
                                type='text'
                                size='small'
                                icon={<ArrowDownOutlined />}
                                disabled={keyIndex === keys.length - 1}
                                loading={movingId === `key:${key.id}`}
                                onClick={() => void moveKey(provider.id, key.id, 1)}
                              />
                            </Tooltip>
                          </div>
                        )}
                        <Button
                          size='small'
                          type={isSelected ? 'default' : 'primary'}
                          variant={isSelected ? 'outlined' : undefined}
                          disabled={!canTakeover}
                          onClick={() => void onTakeover(key.id)}
                        >
                          {isSelected ? '已接管' : '接管'}
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )
        })
      )}
    </div>
  )
}
