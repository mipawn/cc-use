import { useEffect, useMemo, useState } from 'react'
import { Avatar, Button, Empty, Input, Modal, Segmented, Tag, Typography } from 'antd'
import {
  CheckOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  KeyOutlined,
  SearchOutlined,
  StarOutlined,
} from '@ant-design/icons'
import type { ApiKey, ClientKind, Provider } from '@shared/types'
import { getClientKindLabel } from '@shared/types'
import { supportsKeyClient } from '../../utils/clientSupport'
import { isBuiltinDeepSeekProvider } from '../../utils/builtinProviders'
import { parseModelMapping } from '../../utils/modelMapping'
import { computeVisibleReorder } from '../launchpad/reorder'
import claudeIcon from '../../assets/provider-icons/claude.svg'
import openaiIcon from '../../assets/provider-icons/openai.svg'
import deepseekIcon from '../../assets/provider-icons/deepseek.svg'
import newapiIcon from '../../assets/provider-icons/newapi.svg'
import styles from './RoutePickerModal.module.css'

const { Text } = Typography

const PRESET_ICON_MAP: Record<string, string> = {
  claude: claudeIcon,
  claude_code: claudeIcon,
  claude_desktop: claudeIcon,
  codex: openaiIcon,
  openai: openaiIcon,
  deepseek: deepseekIcon,
  newapi: newapiIcon,
}

function providerIcon(provider: Provider) {
  if (!provider.icon) return claudeIcon
  return PRESET_ICON_MAP[provider.icon] || `file://${provider.icon}`
}

function keyName(key: ApiKey) {
  return key.alias || `Key ${key.priority + 1}`
}

export function getRouteModelLabel(key: ApiKey, clientKind: ClientKind): string {
  const mapping = parseModelMapping(key.modelMapping)
  switch (clientKind) {
    case 'codex':
      return mapping.codex || '跟随客户端'
    case 'grok':
      return mapping.grok || '跟随客户端'
    case 'claude_code':
    case 'claude_desktop': {
      const models = [mapping.opus, mapping.sonnet, mapping.haiku].filter(Boolean)
      return models.length > 0 ? Array.from(new Set(models)).join(' / ') : '跟随客户端'
    }
  }
}

export interface RouteSelection {
  provider: Provider
  apiKey: ApiKey
}

interface RoutePickerModalProps {
  open: boolean
  clientKind: ClientKind
  providers: Provider[]
  apiKeys: ApiKey[]
  currentKeyId?: string
  title?: string
  actionText?: string
  onCancel: () => void
  onSelect: (selection: RouteSelection) => Promise<void> | void
  onReorderApiKeys?: (providerId: string, keyIds: string[]) => Promise<void> | void
}

export default function RoutePickerModal({
  open,
  clientKind,
  providers,
  apiKeys,
  currentKeyId,
  title,
  actionText = '使用这条线路',
  onCancel,
  onSelect,
  onReorderApiKeys,
}: RoutePickerModalProps) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'all' | 'builtin'>('all')
  const [providerId, setProviderId] = useState('')
  const [selectedKeyId, setSelectedKeyId] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const compatibleGroups = useMemo(
    () =>
      providers
        .map((provider) => ({
          provider,
          keys: apiKeys.filter(
            (key) => key.providerId === provider.id && supportsKeyClient(provider, key, clientKind),
          ),
        }))
        .filter(({ keys }) => keys.length > 0),
    [apiKeys, clientKind, providers],
  )

  const filteredGroups = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return compatibleGroups
      .filter(({ provider }) => scope === 'all' || isBuiltinDeepSeekProvider(provider))
      .map((group) => ({
        ...group,
        keys: group.keys.filter((key) => {
          if (!normalizedQuery) return true
          const model = getRouteModelLabel(key, clientKind)
          return [group.provider.name, group.provider.baseUrl, key.alias, key.value, model]
            .filter(Boolean)
            .some((value) => String(value).toLocaleLowerCase().includes(normalizedQuery))
        }),
      }))
      .filter(({ keys }) => keys.length > 0)
  }, [clientKind, compatibleGroups, query, scope])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setScope('all')
    setSelectedKeyId(currentKeyId || '')
    const currentProviderId = apiKeys.find((key) => key.id === currentKeyId)?.providerId
    setProviderId(
      currentProviderId ||
        compatibleGroups.find(({ provider }) => provider.isActive)?.provider.id ||
        compatibleGroups[0]?.provider.id ||
        '',
    )
  }, [apiKeys, compatibleGroups, currentKeyId, open])

  useEffect(() => {
    if (!open) return
    setProviderId((currentProviderId) =>
      filteredGroups.some(({ provider }) => provider.id === currentProviderId)
        ? currentProviderId
        : filteredGroups[0]?.provider.id || '',
    )
  }, [filteredGroups, open])

  const activeGroup = filteredGroups.find(({ provider }) => provider.id === providerId)
  const selectedKey = apiKeys.find((key) => key.id === selectedKeyId)
  const selectedProvider = selectedKey
    ? providers.find((provider) => provider.id === selectedKey.providerId)
    : undefined

  useEffect(() => {
    if (selectedKey && providerId && selectedKey.providerId !== providerId) {
      setSelectedKeyId('')
    }
  }, [providerId, selectedKey])

  const handleSubmit = async () => {
    if (!selectedKey || !selectedProvider) return
    setSubmitting(true)
    try {
      await onSelect({ provider: selectedProvider, apiKey: selectedKey })
      onCancel()
    } finally {
      setSubmitting(false)
    }
  }

  const moveKey = async (keyId: string, direction: -1 | 1) => {
    if (!activeGroup || !onReorderApiKeys) return
    const visibleIds = activeGroup.keys.map((key) => key.id)
    const currentIndex = visibleIds.indexOf(keyId)
    const targetId = visibleIds[currentIndex + direction]
    if (!targetId) return
    const providerKeyIds = apiKeys
      .filter((key) => key.providerId === activeGroup.provider.id)
      .map((key) => key.id)
    const nextIds = computeVisibleReorder(providerKeyIds, visibleIds, keyId, targetId)
    if (nextIds) {
      await onReorderApiKeys(activeGroup.provider.id, nextIds)
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      title={title || `选择 ${getClientKindLabel(clientKind)} 线路`}
      width={820}
      destroyOnHidden
      footer={
        <div className={styles.footer}>
          <Text type='secondary'>
            {selectedProvider && selectedKey
              ? `${selectedProvider.name} / ${keyName(selectedKey)}`
              : '请选择一条可用线路'}
          </Text>
          <div className={styles.footerActions}>
            <Button onClick={onCancel}>取消</Button>
            <Button
              type='primary'
              disabled={!selectedKey || !selectedProvider}
              loading={submitting}
              onClick={() => void handleSubmit()}
            >
              {actionText}
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.toolbar}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder='搜索供应商、密钥或模型'
        />
        <Segmented
          value={scope}
          onChange={(value) => setScope(value as 'all' | 'builtin')}
          options={[
            { label: '全部', value: 'all' },
            { label: '内置供应商', value: 'builtin' },
          ]}
        />
      </div>

      {filteredGroups.length === 0 ? (
        <Empty
          className={styles.empty}
          description={
            query || scope === 'builtin'
              ? '没有匹配的线路'
              : `暂无支持 ${getClientKindLabel(clientKind)} 的密钥`
          }
        />
      ) : (
        <div className={styles.picker}>
          <div className={styles.providerColumn}>
            <Text type='secondary' className={styles.columnLabel}>
              供应商
            </Text>
            <div className={styles.providerList}>
              {filteredGroups.map(({ provider, keys }) => (
                <button
                  type='button'
                  key={provider.id}
                  className={`${styles.providerItem} ${
                    provider.id === providerId ? styles.providerItemActive : ''
                  }`}
                  onClick={() => setProviderId(provider.id)}
                >
                  <Avatar src={providerIcon(provider)} size={28} />
                  <span className={styles.providerBody}>
                    <span className={styles.providerNameLine}>
                      <Text strong ellipsis>
                        {provider.name}
                      </Text>
                      {isBuiltinDeepSeekProvider(provider) && (
                        <Tag color='blue' variant='filled'>
                          内置
                        </Tag>
                      )}
                    </span>
                    <Text type='secondary' className={styles.providerMeta}>
                      {keys.length} 个兼容密钥
                    </Text>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className={styles.keyColumn}>
            <Text type='secondary' className={styles.columnLabel}>
              密钥与模型
            </Text>
            <div className={styles.keyList}>
              {activeGroup?.keys.map((key) => {
                const disabled = !activeGroup.provider.isActive || !key.isActive || key.isExhausted
                const selected = key.id === selectedKeyId
                const current = key.id === currentKeyId
                const keyIndex = activeGroup.keys.findIndex((item) => item.id === key.id)
                return (
                  <div
                    key={key.id}
                    className={`${styles.keyItem} ${selected ? styles.keyItemSelected : ''}`}
                    role='button'
                    tabIndex={disabled ? -1 : 0}
                    aria-disabled={disabled}
                    onClick={() => {
                      if (!disabled) setSelectedKeyId(key.id)
                    }}
                    onKeyDown={(event) => {
                      if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
                        setSelectedKeyId(key.id)
                      }
                    }}
                  >
                    <span className={styles.keyIcon}>
                      <KeyOutlined />
                    </span>
                    <span className={styles.keyBody}>
                      <span className={styles.keyNameLine}>
                        <Text strong>{keyName(key)}</Text>
                        {current && (
                          <Tag icon={<StarOutlined />} color='green' variant='filled'>
                            当前
                          </Tag>
                        )}
                        {disabled && (
                          <Tag color='default' variant='filled'>
                            {key.isExhausted ? '额度耗尽' : '已停用'}
                          </Tag>
                        )}
                      </span>
                      <Text type='secondary' className={styles.modelName}>
                        {getRouteModelLabel(key, clientKind)}
                      </Text>
                    </span>
                    {onReorderApiKeys && !query && (
                      <span className={styles.reorderActions}>
                        <Button
                          type='text'
                          size='small'
                          icon={<ArrowUpOutlined />}
                          disabled={keyIndex === 0}
                          aria-label={`上移 ${keyName(key)}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            void moveKey(key.id, -1)
                          }}
                        />
                        <Button
                          type='text'
                          size='small'
                          icon={<ArrowDownOutlined />}
                          disabled={keyIndex === activeGroup.keys.length - 1}
                          aria-label={`下移 ${keyName(key)}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            void moveKey(key.id, 1)
                          }}
                        />
                      </span>
                    )}
                    {selected && <CheckOutlined className={styles.checkIcon} />}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
