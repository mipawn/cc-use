import { useEffect, useMemo, useRef, useState } from 'react'
import { Card, Table, Tag, Button, TreeSelect, Typography, message, Space, Segmented } from 'antd'
import { ReloadOutlined, ClearOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { getApi } from '../api'
import type { ApiKey, ClientKind, ManagedInstance, Provider } from '@shared/types'

const { Text, Title } = Typography

const HEARTBEAT_INTERVAL_SECS = 5

function formatHeartbeat(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

function buildInstanceShortCode(value: string) {
  return value.slice(-8)
}

function getProjectName(path: string) {
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}

function normalizeInstanceCliType(cliType: string) {
  return cliType === 'claude' ? 'claude_code' : cliType
}

function isActiveInstance(instance: ManagedInstance) {
  return ['launching', 'running', 'stale'].includes(instance.status)
}

export function isApiKeyCompatibleWithCliType(key: Pick<ApiKey, 'types'>, cliType: string) {
  const normalizedCliType = normalizeInstanceCliType(cliType)
  return key.types.some((type) => normalizeInstanceCliType(type) === normalizedCliType)
}

interface InstancesProps {
  clientKind: Extract<ClientKind, 'claude_code' | 'grok'>
}

export default function Instances({ clientKind }: InstancesProps) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [instances, setInstances] = useState<ManagedInstance[]>([])
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [view, setView] = useState<'active' | 'history'>('active')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [instancesData, providersData] = await Promise.all([
        getApi().managedInstances.list(clientKind),
        getApi().provider.list(),
      ])
      setInstances(
        instancesData.filter(
          (instance) => normalizeInstanceCliType(instance.cliType) === clientKind,
        ),
      )
      setProviders(providersData)

      const keys = await Promise.all(
        providersData.map((provider) => getApi().apiKey.list(provider.id)),
      )
      setApiKeys(keys.flat())
    } catch (error) {
      console.error('Failed to load managed instances page:', error)
      if (!silent) message.error(t('instances.loadFailed'))
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    load()
    timerRef.current = setInterval(() => load(true), HEARTBEAT_INTERVAL_SECS * 1000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientKind])

  const providerMap = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers])

  const treeData = useMemo(() => {
    const grouped = new Map<string, ApiKey[]>()
    for (const key of apiKeys) {
      const provider = providerMap.get(key.providerId)
      if (!provider?.isActive || !key.isActive || key.isExhausted) continue
      const list = grouped.get(key.providerId) || []
      list.push(key)
      grouped.set(key.providerId, list)
    }

    return Array.from(grouped.entries()).map(([providerId, keys]) => {
      const provider = providerMap.get(providerId)
      return {
        title: provider?.name || providerId,
        value: `provider-${providerId}`,
        selectable: false,
        children: keys.map((key) => ({
          title: key.alias || key.id,
          label: `${provider?.name || providerId} · ${key.alias || key.id}`,
          value: key.id,
        })),
      }
    })
  }, [apiKeys, providerMap])

  const apiKeyMap = useMemo(() => new Map(apiKeys.map((key) => [key.id, key])), [apiKeys])
  const visibleInstances = useMemo(
    () =>
      instances.filter((instance) =>
        view === 'active' ? isActiveInstance(instance) : !isActiveInstance(instance),
      ),
    [instances, view],
  )
  const activeCount = useMemo(() => instances.filter(isActiveInstance).length, [instances])
  const historyCount = instances.length - activeCount

  const statusMeta = useMemo(
    () => ({
      launching: { color: 'gold', label: t('instances.statusLaunching') },
      running: { color: 'green', label: t('instances.statusRunning') },
      stale: { color: 'orange', label: t('instances.statusStale') },
      stopped: { color: 'default', label: t('instances.statusStopped') },
      failed: { color: 'red', label: t('instances.statusFailed') },
    }),
    [t],
  )
  const stopReasonLabels = useMemo(
    () => ({
      launch_failed: t('instances.reasonLaunchFailed'),
      launch_timeout: t('instances.reasonLaunchTimeout'),
      prelaunch_failed: t('instances.reasonPrelaunchFailed'),
      process_exit: t('instances.reasonProcessExit'),
      shell_exit: t('instances.reasonShellExit'),
      heartbeat_timeout: t('instances.reasonHeartbeatTimeout'),
      stale_timeout: t('instances.reasonStaleTimeout'),
      manual_cleanup: t('instances.reasonManualCleanup'),
    }),
    [t],
  )

  const handleCleanup = async () => {
    try {
      const count = await getApi().managedInstances.cleanup(clientKind)
      await load()
      message.success(t('instances.cleanupSuccess', { count }))
    } catch (error) {
      console.error('Failed to cleanup instances:', error)
      message.error(t('instances.cleanupFailed'))
    }
  }

  const handleAssignmentChange = async (instance: ManagedInstance, nextKeyId: string) => {
    try {
      const nextKey = apiKeyMap.get(nextKeyId)
      if (!nextKey) {
        throw new Error('API key not found')
      }
      await getApi().managedInstances.updateAssignment({
        id: instance.id,
        providerId: nextKey.providerId,
        apiKeyId: nextKey.id,
        assignmentSource: 'manual_ui',
      })
      await load()
      message.success(t('instances.assignmentUpdated'))
    } catch (error) {
      console.error('Failed to update managed instance assignment:', error)
      message.error(t('instances.assignmentUpdateFailed'))
    }
  }

  const filteredTreeData = (cliType: string) => {
    const compatibleKeyIds = new Set(
      apiKeys.filter((key) => isApiKeyCompatibleWithCliType(key, cliType)).map((key) => key.id),
    )
    return treeData
      .map((group) => ({
        ...group,
        children: group.children.filter((key) => compatibleKeyIds.has(key.value)),
      }))
      .filter((group) => group.children.length > 0)
  }

  const columns = [
    {
      title: t('instances.columnProject'),
      dataIndex: 'projectPath',
      key: 'projectPath',
      width: 200,
      render: (path: string, record: ManagedInstance) => {
        const instanceLabel = buildInstanceShortCode(record.sessionToken || record.id)
        return (
          <div>
            <Text
              strong
              ellipsis={{ tooltip: path }}
              style={{ display: 'block', maxWidth: '100%' }}
            >
              {getProjectName(path)}
            </Text>
            <Text type='secondary' style={{ fontSize: 11 }}>
              {instanceLabel}
            </Text>
          </div>
        )
      },
    },
    {
      title: t('instances.columnStatus'),
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (value: string) => {
        const meta = statusMeta[value as keyof typeof statusMeta] || {
          color: 'default',
          label: value,
        }
        return <Tag color={meta.color}>{meta.label}</Tag>
      },
    },
    {
      title: t('instances.columnCurrentRoute'),
      key: 'assignKey',
      width: 280,
      render: (_: unknown, record: ManagedInstance) => {
        if (!isActiveInstance(record)) {
          const provider = record.providerId ? providerMap.get(record.providerId) : null
          const key = record.apiKeyId ? apiKeyMap.get(record.apiKeyId) : null
          return (
            <Text type='secondary'>
              {provider?.name || record.providerId || t('common.unknown')} ·{' '}
              {key?.alias || record.apiKeyId || t('common.unknown')}
            </Text>
          )
        }
        return (
          <TreeSelect
            showSearch={{
              filterTreeNode: (input, node) =>
                String(node.title || '')
                  .toLowerCase()
                  .includes(input.toLowerCase()),
            }}
            treeDefaultExpandAll
            placeholder={t('instances.selectKey')}
            value={record.apiKeyId || undefined}
            treeData={filteredTreeData(record.cliType)}
            style={{ width: '100%' }}
            onChange={(value: string) => handleAssignmentChange(record, value)}
            treeNodeLabelProp='label'
          />
        )
      },
    },
    {
      title: t('instances.columnUpdatedAt'),
      key: 'updatedAt',
      width: 180,
      render: (_: unknown, record: ManagedInstance) => {
        const value = record.stoppedAt || record.lastSeenAt
        const formattedValue = formatHeartbeat(value)
        return (
          <div>
            <Text
              ellipsis={{ tooltip: formattedValue }}
              style={{ display: 'block', maxWidth: '100%' }}
            >
              {formattedValue}
            </Text>
            {record.stopReason && (
              <Text type='secondary' style={{ display: 'block', fontSize: 11 }}>
                {stopReasonLabels[record.stopReason as keyof typeof stopReasonLabels] ||
                  record.stopReason}
                {record.exitCode !== null
                  ? ` · ${t('instances.exitCode', { code: record.exitCode })}`
                  : ''}
              </Text>
            )}
          </div>
        )
      },
    },
  ]

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%', minHeight: 0 }}
    >
      <div>
        <Title level={3} className='m-0! mb-1!'>
          {t('instances.title')}
        </Title>
        <Text type='secondary'>
          {t('instances.subtitle')}
          {' · '}
          {t('instances.heartbeatInterval', { seconds: HEARTBEAT_INTERVAL_SECS })}
        </Text>
      </div>

      <Card
        title={t('instances.tableTitle')}
        extra={
          <Space wrap>
            <Segmented<'active' | 'history'>
              value={view}
              onChange={setView}
              options={[
                { value: 'active', label: t('instances.activeView', { count: activeCount }) },
                { value: 'history', label: t('instances.historyView', { count: historyCount }) },
              ]}
            />
            <Button icon={<ClearOutlined />} onClick={handleCleanup}>
              {t('instances.cleanup')}
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => load()} loading={loading}>
              {t('common.refresh')}
            </Button>
          </Space>
        }
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        styles={{
          body: {
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          },
        }}
      >
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <Table
            rowKey='id'
            loading={loading}
            columns={columns}
            dataSource={visibleInstances}
            scroll={{ x: 900 }}
            pagination={{ pageSize: 10 }}
          />
        </div>
      </Card>
    </div>
  )
}
