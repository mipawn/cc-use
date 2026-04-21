import { useEffect, useMemo, useRef, useState } from 'react'
import { Card, Table, Tag, Button, TreeSelect, Typography, message, Space } from 'antd'
import { ReloadOutlined, ClearOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { getApi } from '../api'
import type { ApiKey, ManagedInstance, Provider } from '@shared/types'

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

export default function Instances() {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [instances, setInstances] = useState<ManagedInstance[]>([])
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [instancesData, providersData] = await Promise.all([
        getApi().managedInstances.list(),
        getApi().provider.list(),
      ])
      setInstances(instancesData)
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
  }, [])

  const providerMap = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers])

  const treeData = useMemo(() => {
    const grouped = new Map<string, ApiKey[]>()
    for (const key of apiKeys) {
      const provider = providerMap.get(key.providerId)
      if (!provider?.isActive) continue
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

  const handleCleanup = async () => {
    try {
      const count = await getApi().managedInstances.cleanup()
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

  const filteredTreeData = (cliType: string) =>
    treeData
      .map((group) => ({
        ...group,
        children: group.children.filter((child) => {
          const key = apiKeyMap.get(child.value)
          return key?.types.includes(cliType as 'claude' | 'codex')
        }),
      }))
      .filter((group) => group.children.length > 0)

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
      title: t('instances.columnAssignKey'),
      key: 'assignKey',
      width: 280,
      render: (_: unknown, record: ManagedInstance) => (
        <TreeSelect
          showSearch
          treeDefaultExpandAll
          placeholder={t('instances.selectKey')}
          value={record.apiKeyId || undefined}
          treeData={filteredTreeData(record.cliType)}
          style={{ width: '100%' }}
          onChange={(value: string) => handleAssignmentChange(record, value)}
          treeNodeFilterProp='title'
          treeNodeLabelProp='label'
        />
      ),
    },
    {
      title: t('instances.columnLastSeen'),
      dataIndex: 'lastSeenAt',
      key: 'lastSeenAt',
      width: 180,
      render: (value: string) => {
        const formattedValue = formatHeartbeat(value)
        return (
          <Text
            ellipsis={{ tooltip: formattedValue }}
            style={{ display: 'block', maxWidth: '100%' }}
          >
            {formattedValue}
          </Text>
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
          <Space>
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
            dataSource={instances}
            scroll={{ x: 900 }}
            pagination={{ pageSize: 10 }}
          />
        </div>
      </Card>
    </div>
  )
}
