import { useState, type ReactNode } from 'react'
import { Button, Empty, Tag, Tooltip, Typography } from 'antd'
import {
  CheckCircleOutlined,
  HolderOutlined,
  QuestionCircleOutlined,
  StarOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import clsx from 'clsx'
import type { Provider, ApiKey, ClientKind } from '@shared/types'
import { supportsKeyClient } from '../../utils/clientSupport'
import claudeIcon from '../../assets/provider-icons/claude.svg'
import openaiIcon from '../../assets/provider-icons/openai.svg'
import deepseekIcon from '../../assets/provider-icons/deepseek.svg'
import newapiIcon from '../../assets/provider-icons/newapi.svg'
import { useAppMessage } from '../../hooks/useAppMessage'
import { computeVisibleReorder } from './reorder'
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

function displayKeyName(apiKey: ApiKey) {
  return apiKey.alias || `${apiKey.value.slice(0, 10)}...${apiKey.value.slice(-4)}`
}

function KeyStatusTag({
  provider,
  apiKey,
  isSelected,
}: {
  provider: Provider
  apiKey: ApiKey
  isSelected: boolean
}) {
  if (!provider.isActive) {
    return (
      <Tag className={styles.statusTag} color='warning'>
        <span className={styles.dot} />
        服务商停用
      </Tag>
    )
  }
  if (!apiKey.isActive) {
    return (
      <Tag className={styles.statusTag} color='red'>
        <span className={styles.dot} />
        密钥停用
      </Tag>
    )
  }
  if (isSelected) {
    return (
      <Tag className={styles.statusTag} color='green'>
        <span className={styles.dot} />
        已接管
      </Tag>
    )
  }
  return (
    <Tag className={styles.statusTag} color='blue'>
      <span className={styles.dot} />
      可接管
    </Tag>
  )
}

type SortableChildrenArgs = {
  attributes: ReturnType<typeof useSortable>['attributes']
  listeners: ReturnType<typeof useSortable>['listeners']
  setActivatorNodeRef: ReturnType<typeof useSortable>['setActivatorNodeRef']
}

function DragHandle({
  label,
  attributes,
  listeners,
  setActivatorNodeRef,
}: SortableChildrenArgs & { label: string }) {
  return (
    <Tooltip title={label}>
      <span
        ref={setActivatorNodeRef}
        className={styles.dragHandle}
        {...attributes}
        {...listeners}
        aria-label={label}
      >
        <HolderOutlined />
      </span>
    </Tooltip>
  )
}

function SortableProviderPanel({
  providerId,
  children,
}: {
  providerId: string
  children: (args: SortableChildrenArgs) => ReactNode
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `provider:${providerId}`,
  })
  return (
    <section
      ref={setNodeRef}
      className={clsx(styles.providerPanel, isDragging && styles.dragging)}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </section>
  )
}

function SortableKeyRow({
  keyId,
  selected,
  children,
}: {
  keyId: string
  selected: boolean
  children: (args: SortableChildrenArgs) => ReactNode
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: `key:${keyId}`,
  })
  return (
    <div
      ref={setNodeRef}
      className={clsx(styles.tableRow, selected && styles.selectedRow, isDragging && styles.dragging)}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      role='row'
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </div>
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
  const message = useAppMessage()
  const [movingId, setMovingId] = useState<string | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
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

  const reorderVisibleProviders = async (activeProviderId: string, overProviderId: string) => {
    if (!onReorderProviders) return
    const visibleIds = grouped.map(({ provider }) => provider.id)
    const nextProviderIds = computeVisibleReorder(
      providers.map((provider) => provider.id),
      visibleIds,
      activeProviderId,
      overProviderId,
    )
    if (!nextProviderIds) return
    setMovingId(`provider:${activeProviderId}`)
    try {
      await onReorderProviders(nextProviderIds)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '服务商排序保存失败')
    } finally {
      setMovingId(null)
    }
  }

  const reorderVisibleKeys = async (providerId: string, activeKeyId: string, overKeyId: string) => {
    if (!onReorderApiKeys) return
    const providerKeys = allKeys.filter((key) => key.providerId === providerId)
    const group = grouped.find(({ provider }) => provider.id === providerId)
    if (!group) return

    const visibleIds = group.keys.map((key) => key.id)
    const nextKeyIds = computeVisibleReorder(
      providerKeys.map((key) => key.id),
      visibleIds,
      activeKeyId,
      overKeyId,
    )
    if (!nextKeyIds) return
    setMovingId(`key:${activeKeyId}`)
    try {
      await onReorderApiKeys(providerId, nextKeyIds)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '密钥排序保存失败')
    } finally {
      setMovingId(null)
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id)
    const overId = event.over ? String(event.over.id) : ''
    if (!overId || activeId === overId) return

    if (activeId.startsWith('provider:') && overId.startsWith('provider:')) {
      void reorderVisibleProviders(
        activeId.replace('provider:', ''),
        overId.replace('provider:', ''),
      )
      return
    }

    if (activeId.startsWith('key:') && overId.startsWith('key:')) {
      const activeKeyId = activeId.replace('key:', '')
      const overKeyId = overId.replace('key:', '')
      const providerId = grouped.find(({ keys }) => keys.some((key) => key.id === activeKeyId))
        ?.provider.id
      const overProviderId = grouped.find(({ keys }) => keys.some((key) => key.id === overKeyId))
        ?.provider.id
      if (providerId && providerId === overProviderId) {
        void reorderVisibleKeys(providerId, activeKeyId, overKeyId)
      }
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
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext
            items={grouped.map(({ provider }) => `provider:${provider.id}`)}
            strategy={verticalListSortingStrategy}
          >
            {grouped.map(({ provider, keys }) => {
              return (
                <SortableProviderPanel key={provider.id} providerId={provider.id}>
                  {(handleProps) => (
                    <>
                      <div className={styles.providerHeader}>
                        <div className={styles.providerTitle}>
                          {onReorderProviders && grouped.length > 1 && (
                            <DragHandle label='拖拽排序服务商' {...handleProps} />
                          )}
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
                        {movingId === `provider:${provider.id}` && (
                          <Tag color='processing' className={styles.savingTag}>
                            保存中
                          </Tag>
                        )}
                      </div>
                      <div
                        className={styles.table}
                        role='table'
                        aria-label={`${provider.name} 密钥`}
                      >
                        <div className={styles.tableHead} role='row'>
                          <div role='columnheader'>密钥</div>
                          <div role='columnheader'>状态</div>
                          <div role='columnheader'>操作</div>
                        </div>
                        <SortableContext
                          items={keys.map((key) => `key:${key.id}`)}
                          strategy={verticalListSortingStrategy}
                        >
                          {keys.map((key) => {
                            const isSelected = activeKeyId === key.id
                            const canTakeover = provider.isActive && key.isActive
                            return (
                              <SortableKeyRow key={key.id} keyId={key.id} selected={isSelected}>
                                {(keyHandleProps) => (
                                  <>
                                    <div className={styles.nameCell} role='cell'>
                                      <div className={styles.keyNameLine}>
                                        {onReorderApiKeys && keys.length > 1 && (
                                          <DragHandle label='拖拽排序密钥' {...keyHandleProps} />
                                        )}
                                        <Tooltip title={displayKeyName(key)}>
                                          <Text
                                            strong={isSelected}
                                            ellipsis
                                            className={styles.keyName}
                                          >
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
                                    <div className={styles.statusCell} role='cell'>
                                      <KeyStatusTag
                                        provider={provider}
                                        apiKey={key}
                                        isSelected={isSelected}
                                      />
                                      {movingId === `key:${key.id}` && (
                                        <Tag color='processing' className={styles.savingTag}>
                                          保存中
                                        </Tag>
                                      )}
                                    </div>
                                    <div className={styles.actionCell} role='cell'>
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
                                  </>
                                )}
                              </SortableKeyRow>
                            )
                          })}
                        </SortableContext>
                      </div>
                    </>
                  )}
                </SortableProviderPanel>
              )
            })}
          </SortableContext>
        </DndContext>
      )}
    </div>
  )
}
