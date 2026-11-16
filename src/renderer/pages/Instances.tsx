import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Empty, Segmented, Space, Table, Tag, Typography, App } from 'antd'
import { ReloadOutlined, ClearOutlined, SwapOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { getApi } from '../api'
import { usePageRefresh } from '../hooks/usePageRefresh'
import RoutePickerModal, { type RouteSelection } from '../components/common/RoutePickerModal'
import ClientIcon from '../components/common/ClientIcon'
import {
  getClientKindLabel,
  type ApiKey,
  type ClientKind,
  type ManagedInstance,
  type Provider,
} from '@shared/types'
import styles from './Instances.module.css'

const { Text, Title } = Typography
const HEARTBEAT_INTERVAL_MS = 5000
export type InstanceClient = Extract<ClientKind, 'claude_code' | 'grok'>
export type InstanceView = 'active' | 'history'

function normalizeInstanceCliType(cliType: string) {
  return cliType === 'claude' ? 'claude_code' : cliType
}

function isActiveInstance(instance: ManagedInstance) {
  return ['launching', 'running', 'stale'].includes(instance.status)
}

export function isApiKeyCompatibleWithCliType(key: Pick<ApiKey, 'types'>, cliType: string) {
  return key.types.some(
    (type) => normalizeInstanceCliType(type) === normalizeInstanceCliType(cliType),
  )
}

interface InstancesProps {
  clientKind?: InstanceClient
  embedded?: boolean
  view?: InstanceView
  onViewChange?: (view: InstanceView) => void
  onViewRequests?: (id: string) => void
}

export default function Instances({
  clientKind,
  embedded = false,
  view: controlledView,
  onViewChange,
  onViewRequests,
}: InstancesProps) {
  const { t, i18n } = useTranslation()
  const { message } = App.useApp()
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [instances, setInstances] = useState<ManagedInstance[]>([])
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [localView, setLocalView] = useState<InstanceView>('active')
  const [assignmentTarget, setAssignmentTarget] = useState<ManagedInstance | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const revision = useRef(0)
  const submission = useRef(false)
  const cleanupPending = useRef(false)
  // A new scope gets a new lifetime, even after switching away and back to the
  // same client. Old operations must not start new reads or release new locks.
  const identity = useMemo(() => ({ clientKind, active: false }), [clientKind])
  const view = controlledView ?? localView

  const load = useCallback(
    async (silent = false) => {
      if (!identity.active) return
      const request = ++revision.current
      if (!silent) setLoading(true)
      try {
        // The per-client endpoint is capped at 100 recent records. Always obtain
        // the complete active population separately, including old live instances.
        const clients: InstanceClient[] = clientKind ? [clientKind] : ['claude_code', 'grok']
        const [active, histories, nextProviders] = await Promise.all([
          getApi().managedInstances.list(),
          Promise.all(clients.map((kind) => getApi().managedInstances.list(kind))),
          getApi().provider.list(),
        ])
        if (!identity.active || request !== revision.current) return
        const keys = (
          await Promise.all(nextProviders.map((provider) => getApi().apiKey.list(provider.id)))
        ).flat()
        if (!identity.active || request !== revision.current) return
        const byId = new Map<string, ManagedInstance>()
        for (const instance of [
          ...histories.flat().filter((item) => !isActiveInstance(item)),
          ...active,
        ]) {
          if (clients.includes(normalizeInstanceCliType(instance.cliType) as InstanceClient))
            byId.set(instance.id, instance)
        }
        setInstances([...byId.values()].sort((a, b) => b.launchedAt.localeCompare(a.launchedAt)))
        setProviders(nextProviders)
        setApiKeys(keys)
        setLoadFailed(false)
      } catch {
        if (identity.active && request === revision.current) setLoadFailed(true)
      } finally {
        if (identity.active && request === revision.current) setLoading(false)
      }
    },
    [clientKind, identity],
  )

  useEffect(() => {
    identity.active = true
    submission.current = false
    cleanupPending.current = false
    setPendingId(null)
    setCleaning(false)
    setInstances([])
    setAssignmentTarget(null)
    void load()
    const timer = setInterval(() => void load(true), HEARTBEAT_INTERVAL_MS)
    return () => {
      identity.active = false
      revision.current += 1
      clearInterval(timer)
    }
  }, [identity, load])
  usePageRefresh(() => load())

  const providerMap = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers])
  const keyMap = useMemo(() => new Map(apiKeys.map((key) => [key.id, key])), [apiKeys])
  const visibleInstances = instances.filter((instance) =>
    view === 'active' ? isActiveInstance(instance) : !isActiveInstance(instance),
  )
  const activeCount = instances.filter(isActiveInstance).length
  const statusMeta: Record<string, { color: string; label: string }> = {
    launching: { color: 'gold', label: t('instances.statusLaunching') },
    running: { color: 'green', label: t('instances.statusRunning') },
    stale: { color: 'orange', label: t('instances.statusStale') },
    stopped: { color: 'default', label: t('instances.statusStopped') },
    failed: { color: 'red', label: t('instances.statusFailed') },
  }
  const reasons: Record<string, string> = {
    launch_failed: t('instances.reasonLaunchFailed'),
    launch_timeout: t('instances.reasonLaunchTimeout'),
    prelaunch_failed: t('instances.reasonPrelaunchFailed'),
    process_exit: t('instances.reasonProcessExit'),
    shell_exit: t('instances.reasonShellExit'),
    heartbeat_timeout: t('instances.reasonHeartbeatTimeout'),
    stale_timeout: t('instances.reasonStaleTimeout'),
    manual_cleanup: t('instances.reasonManualCleanup'),
  }

  const handleCleanup = async () => {
    if (!identity.active || cleanupPending.current) return
    cleanupPending.current = true
    setCleaning(true)
    try {
      const clients: InstanceClient[] = clientKind ? [clientKind] : ['claude_code', 'grok']
      const results = await Promise.allSettled(
        clients.map((kind) => getApi().managedInstances.cleanup(kind)),
      )
      if (!identity.active) return
      const count = results.reduce(
        (sum, result) => sum + (result.status === 'fulfilled' ? result.value : 0),
        0,
      )
      await load()
      if (!identity.active) return
      if (results.some((result) => result.status === 'rejected'))
        message.warning(t('instances.cleanupPartial', { count }))
      else message.success(t('instances.cleanupSuccess', { count }))
    } catch {
      if (identity.active) message.error(t('instances.cleanupFailed'))
    } finally {
      if (identity.active) {
        cleanupPending.current = false
        setCleaning(false)
      }
    }
  }

  const handleAssignment = async ({ provider, apiKey }: RouteSelection) => {
    if (!identity.active || !assignmentTarget || submission.current) return
    const id = assignmentTarget.id
    submission.current = true
    setPendingId(id)
    try {
      // Backend validates state/ownership/compatibility again at submission.
      await getApi().managedInstances.updateAssignment({
        id,
        providerId: provider.id,
        apiKeyId: apiKey.id,
        assignmentSource: 'manual_ui',
      })
      if (!identity.active) return
      await load(true)
      if (identity.active) message.success(t('instances.assignmentUpdated'))
    } catch {
      if (!identity.active) return
      await load(true)
      if (identity.active) throw new Error(t('instances.assignmentUpdateFailed'))
    } finally {
      if (identity.active) {
        submission.current = false
        setPendingId(null)
      }
    }
  }

  const columns = [
    {
      title: t('instances.columnProject'),
      dataIndex: 'projectPath',
      key: 'projectPath',
      width: 200,
      render: (path: string, record: ManagedInstance) => (
        <div>
          <Text strong ellipsis={{ tooltip: path }} className={styles.directory}>
            {path.split('/').filter(Boolean).at(-1) || path}
          </Text>
          {/* sessionToken is a credential, including its suffix. Only show instance ID. */}
          <Text type='secondary' className={styles.secondary}>
            {record.id.slice(-8)}
          </Text>
        </div>
      ),
    },
    {
      title: t('instances.columnCli'),
      key: 'client',
      width: 140,
      render: (_: unknown, record: ManagedInstance) => {
        const kind = normalizeInstanceCliType(record.cliType) as InstanceClient
        return (
          <Space size={6}>
            <ClientIcon kind={kind} size={16} />
            {getClientKindLabel(kind)}
          </Space>
        )
      },
    },
    {
      title: t('instances.columnStatus'),
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (value: string) => (
        <Tag color={statusMeta[value]?.color}>{statusMeta[value]?.label || value}</Tag>
      ),
    },
    {
      title: t('instances.columnCurrentRoute'),
      key: 'route',
      width: 230,
      render: (_: unknown, record: ManagedInstance) => {
        const provider = record.providerId ? providerMap.get(record.providerId) : null
        const key = record.apiKeyId ? keyMap.get(record.apiKeyId) : null
        return (
          <div>
            <Text className={styles.directory} ellipsis={{ tooltip: provider?.name }}>
              {provider?.name || t('common.unknown')}
            </Text>
            <Text type='secondary' className={styles.secondary}>
              {key?.alias || (key ? t('instances.unnamedKey') : t('common.unknown'))}
            </Text>
          </div>
        )
      },
    },
    {
      title: t('instances.columnUpdatedAt'),
      key: 'updatedAt',
      width: 170,
      render: (_: unknown, record: ManagedInstance) => {
        const value = record.stoppedAt || record.lastSeenAt
        const date = new Date(value)
        return (
          <div>
            <Text>
              {Number.isNaN(date.getTime())
                ? value
                : date.toLocaleString(i18n?.language || 'zh-CN')}
            </Text>
            {record.stopReason && (
              <Text type='secondary' className={styles.secondary}>
                {reasons[record.stopReason] || record.stopReason}
                {record.exitCode !== null
                  ? ` · ${t('instances.exitCode', { code: record.exitCode })}`
                  : ''}
              </Text>
            )}
          </div>
        )
      },
    },
    {
      title: t('common.more'),
      key: 'actions',
      width: 150,
      render: (_: unknown, record: ManagedInstance) => (
        <Space size={0}>
          {isActiveInstance(record) && (
            <Button
              type='text'
              size='small'
              icon={<SwapOutlined />}
              loading={pendingId === record.id}
              onClick={() => setAssignmentTarget(record)}
            >
              {t('instances.switchRoute')}
            </Button>
          )}
          {onViewRequests && (
            <Button type='link' size='small' onClick={() => onViewRequests(record.id)}>
              {t('instances.requests')}
            </Button>
          )}
        </Space>
      ),
    },
  ]

  return (
    <div className={styles.container}>
      {!embedded && (
        <div>
          <Title level={3}>{t('instances.title')}</Title>
          <Text type='secondary'>{t('instances.subtitle')}</Text>
        </div>
      )}
      <div className={styles.toolbar}>
        <Segmented
          value={view}
          onChange={(next) => {
            setLocalView(next as InstanceView)
            onViewChange?.(next as InstanceView)
          }}
          options={[
            { value: 'active', label: t('instances.activeView', { count: activeCount }) },
            {
              value: 'history',
              label: t('instances.historyView', { count: instances.length - activeCount }),
            },
          ]}
        />
        <Space>
          <Button icon={<ClearOutlined />} loading={cleaning} onClick={() => void handleCleanup()}>
            {t('instances.cleanup')}
          </Button>
          <Button
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => void load()}
            aria-label={t('common.refresh')}
          />
        </Space>
      </div>
      {loadFailed && (
        <Alert
          type='error'
          showIcon
          title={t('instances.loadFailed')}
          action={
            <Button size='small' onClick={() => void load()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {view === 'history' && <Text type='secondary'>{t('instances.historyLimit')}</Text>}
      <div className={styles.table}>
        <Table
          rowKey='id'
          loading={loading}
          columns={columns}
          dataSource={visibleInstances}
          scroll={{ x: 990 }}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          locale={{
            emptyText: loadFailed ? (
              t('instances.loadFailed')
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t(
                  view === 'active' ? 'instances.emptyActive' : 'instances.emptyHistory',
                )}
              >
                {view === 'active' && (
                  <Space wrap>
                    {(!clientKind || clientKind === 'claude_code') && (
                      <Text code copyable>
                        cc-use claude
                      </Text>
                    )}
                    {(!clientKind || clientKind === 'grok') && (
                      <Text code copyable>
                        cc-use grok
                      </Text>
                    )}
                  </Space>
                )}
              </Empty>
            ),
          }}
        />
      </div>
      {assignmentTarget && (
        <RoutePickerModal
          key={assignmentTarget.id}
          open
          clientKind={normalizeInstanceCliType(assignmentTarget.cliType) as InstanceClient}
          providers={providers}
          apiKeys={apiKeys}
          currentKeyId={assignmentTarget.apiKeyId || undefined}
          title={t('instances.switchRoute')}
          actionText={t('instances.applyRoute')}
          onCancel={() => {
            if (!submission.current) setAssignmentTarget(null)
          }}
          onSelect={handleAssignment}
        />
      )}
    </div>
  )
}
