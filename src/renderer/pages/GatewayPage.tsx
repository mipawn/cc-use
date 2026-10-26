import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
  theme,
} from 'antd'
import {
  ApiOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import SimpleBar from 'simplebar-react'
import { useTranslation } from 'react-i18next'
import type { Gateway } from '@shared/types'
import { getApi } from '../api'
import { useAppMessage } from '../hooks/useAppMessage'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { useServiceStatus } from '../hooks/useServiceStatus'
import { useApiKeyStore } from '../stores/apiKeyStore'
import { useProviderStore } from '../stores/providerStore'
import { useSettingsStore } from '../stores/settingsStore'
import styles from './GatewayPage.module.css'

function maskToken(token: string): string {
  if (token.length <= 16) return token
  return `${token.slice(0, 12)}…${token.slice(-4)}`
}

export default function GatewayPage() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const message = useAppMessage()
  const { providers, fetchProviders } = useProviderStore()
  const { apiKeys, fetchApiKeys, fetchAllApiKeys } = useApiKeyStore()
  const proxyPort = useSettingsStore((state) => state.globalSettings.proxyPort)
  const { status, restart, loading: restarting } = useServiceStatus()

  const [gateways, setGateways] = useState<Gateway[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Gateway | null>(null)
  const [name, setName] = useState('')
  const [providerId, setProviderId] = useState<string>()
  const [apiKeyId, setApiKeyId] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})

  const address = useMemo(() => `http://127.0.0.1:${proxyPort}`, [proxyPort])
  const keyOptions = useMemo(
    () =>
      (providerId ? (apiKeys[providerId] ?? []) : []).map((key) => ({
        value: key.id,
        // Never echo the secret value here; the key id is enough to disambiguate.
        label: key.alias?.trim() || key.id.slice(0, 8),
      })),
    [apiKeys, providerId],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setGateways(await getApi().gateway.list())
    } catch (loadError) {
      // Surface the failure inline; this callback is also used by page refresh,
      // so it must stay dependency-free rather than closing over `message`.
      setError(String(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    void fetchProviders()
  }, [load, fetchProviders])

  useEffect(() => {
    if (providers.length === 0) return
    void fetchAllApiKeys(providers.map((provider) => provider.id)).catch((error) => {
      console.error('Failed to load API keys for gateway page:', error)
    })
  }, [providers, fetchAllApiKeys])

  usePageRefresh(load)

  const openCreate = () => {
    setEditing(null)
    setName('')
    setProviderId(undefined)
    setApiKeyId(undefined)
    setModalOpen(true)
  }

  const openEdit = (gateway: Gateway) => {
    setEditing(gateway)
    setName(gateway.displayName)
    setProviderId(gateway.providerId)
    setApiKeyId(gateway.apiKeyId)
    void fetchApiKeys(gateway.providerId).catch((error) => {
      console.error('Failed to load API keys for gateway:', error)
    })
    setModalOpen(true)
  }

  const handleProviderChange = (value: string) => {
    setProviderId(value)
    const keys = apiKeys[value] ?? []
    if (!keys.some((key) => key.id === apiKeyId)) setApiKeyId(undefined)
    void fetchApiKeys(value).catch((error) => {
      console.error('Failed to load API keys for gateway:', error)
    })
  }

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed || !providerId || !apiKeyId) {
      message.error(t('gateway.required'))
      return
    }
    setSaving(true)
    try {
      if (editing) {
        await getApi().gateway.update(editing.sessionToken, {
          name: trimmed,
          providerId,
          apiKeyId,
        })
      } else {
        await getApi().gateway.create(trimmed, providerId, apiKeyId)
      }
      setModalOpen(false)
      await load()
      message.success(t('gateway.saved'))
    } catch (saveError) {
      message.error(String(saveError))
    } finally {
      setSaving(false)
    }
  }

  const toggleGateway = async (gateway: Gateway, active: boolean) => {
    setGateways((current) =>
      current.map((item) =>
        item.sessionToken === gateway.sessionToken ? { ...item, isActive: active } : item,
      ),
    )
    try {
      await getApi().gateway.update(gateway.sessionToken, { isActive: active })
      message.success(active ? t('gateway.enabledToast') : t('gateway.disabledToast'))
    } catch (toggleError) {
      setGateways((current) =>
        current.map((item) =>
          item.sessionToken === gateway.sessionToken
            ? { ...item, isActive: gateway.isActive }
            : item,
        ),
      )
      message.error(String(toggleError))
    }
  }

  const remove = async (gateway: Gateway) => {
    try {
      await getApi().gateway.delete(gateway.sessionToken)
      setGateways((current) => current.filter((item) => item.sessionToken !== gateway.sessionToken))
      message.success(t('gateway.deleted'))
    } catch (deleteError) {
      message.error(String(deleteError))
    }
  }

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      message.success(t('common.copied'))
    } catch (copyError) {
      message.error(String(copyError))
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('gateway.title')}
          </Typography.Title>
          <Typography.Text type='secondary'>{t('gateway.subtitle')}</Typography.Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            {t('common.refresh')}
          </Button>
          <Button type='primary' icon={<PlusOutlined />} onClick={openCreate}>
            {t('gateway.create')}
          </Button>
        </Space>
      </div>

      {!status.isRunning && (
        <Alert
          type='warning'
          showIcon
          message={t('gateway.daemonOff')}
          description={t('gateway.daemonOffHint')}
          action={
            <Button size='small' loading={restarting} onClick={() => void restart()}>
              {t('gateway.startService')}
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      {error && (
        <Alert
          type='error'
          showIcon
          message={t('gateway.loadFailed')}
          description={error}
          action={
            <Button size='small' onClick={() => void load()}>
              {t('common.retry')}
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      <div className={styles.content}>
        {loading && gateways.length === 0 ? (
          <div className={styles.loadingState}>
            <Spin size='large' />
          </div>
        ) : gateways.length === 0 ? (
          <Empty description={t('gateway.empty')}>
            <Button type='primary' icon={<PlusOutlined />} onClick={openCreate}>
              {t('gateway.create')}
            </Button>
          </Empty>
        ) : (
          <SimpleBar className={styles.scrollContent}>
            <div className={styles.grid}>
              {gateways.map((gateway) => (
                <Card
                  key={gateway.sessionToken}
                  className={styles.gatewayCard}
                  title={
                    <Space size={8}>
                      <ApiOutlined style={{ color: token.colorPrimary }} />
                      <span className={styles.cardTitle}>{gateway.displayName}</span>
                      <Tag color={gateway.isActive ? 'green' : 'default'}>
                        {gateway.isActive ? t('common.active') : t('common.inactive')}
                      </Tag>
                    </Space>
                  }
                  extra={
                    <Space size={4}>
                      <Switch
                        size='small'
                        checked={gateway.isActive}
                        aria-label={t('gateway.enabled')}
                        onChange={(active) => void toggleGateway(gateway, active)}
                      />
                      <Button
                        type='text'
                        size='small'
                        icon={<EditOutlined />}
                        aria-label={t('common.edit')}
                        onClick={() => openEdit(gateway)}
                      />
                      <Popconfirm
                        title={t('gateway.deleteConfirm')}
                        okButtonProps={{ danger: true }}
                        okText={t('common.delete')}
                        cancelText={t('common.cancel')}
                        onConfirm={() => void remove(gateway)}
                      >
                        <Button
                          type='text'
                          size='small'
                          danger
                          icon={<DeleteOutlined />}
                          aria-label={t('common.delete')}
                        />
                      </Popconfirm>
                    </Space>
                  }
                >
                  <div className={styles.row}>
                    <span className={styles.label}>{t('gateway.provider')}</span>
                    <span className={styles.value}>
                      {gateway.providerName || '—'} / {gateway.keyAlias || '—'}
                    </span>
                  </div>
                  <div className={styles.row}>
                    <span className={styles.label}>{t('gateway.address')}</span>
                    <code className={styles.code}>{address}</code>
                    <Button
                      type='text'
                      size='small'
                      icon={<CopyOutlined />}
                      aria-label={t('gateway.copyAddress')}
                      onClick={() => void copy(address)}
                    />
                  </div>
                  <div className={styles.row}>
                    <span className={styles.label}>{t('gateway.localKey')}</span>
                    <code className={styles.code}>
                      {revealed[gateway.sessionToken]
                        ? gateway.sessionToken
                        : maskToken(gateway.sessionToken)}
                    </code>
                    <Button
                      type='text'
                      size='small'
                      icon={
                        revealed[gateway.sessionToken] ? <EyeInvisibleOutlined /> : <EyeOutlined />
                      }
                      aria-label={t('gateway.localKey')}
                      onClick={() =>
                        setRevealed((current) => ({
                          ...current,
                          [gateway.sessionToken]: !current[gateway.sessionToken],
                        }))
                      }
                    />
                    <Button
                      type='text'
                      size='small'
                      icon={<CopyOutlined />}
                      aria-label={t('gateway.copyKey')}
                      onClick={() => void copy(gateway.sessionToken)}
                    />
                  </div>
                  <Typography.Paragraph type='secondary' className={styles.hint}>
                    {t('gateway.usageHint')}
                  </Typography.Paragraph>
                  <Typography.Paragraph type='secondary' className={styles.hint}>
                    {t('gateway.userAgentHint')}
                  </Typography.Paragraph>
                </Card>
              ))}
            </div>
          </SimpleBar>
        )}
      </div>

      <Modal
        open={modalOpen}
        title={editing ? t('gateway.edit') : t('gateway.create')}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={saving}
        onOk={() => void save()}
        onCancel={() => setModalOpen(false)}
        destroyOnHidden
      >
        <Space direction='vertical' size={16} style={{ width: '100%' }}>
          <div>
            <div className={styles.fieldLabel}>{t('gateway.name')}</div>
            <Input
              value={name}
              maxLength={64}
              placeholder={t('gateway.namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div>
            <div className={styles.fieldLabel}>{t('gateway.provider')}</div>
            <Select
              style={{ width: '100%' }}
              value={providerId}
              placeholder={t('gateway.providerPlaceholder')}
              options={providers.map((provider) => ({
                value: provider.id,
                label: provider.name,
              }))}
              onChange={handleProviderChange}
            />
          </div>
          <div>
            <div className={styles.fieldLabel}>{t('gateway.key')}</div>
            <Select
              style={{ width: '100%' }}
              value={apiKeyId}
              placeholder={
                providerId ? t('gateway.keyPlaceholder') : t('gateway.selectProviderFirst')
              }
              disabled={!providerId}
              options={keyOptions}
              onChange={setApiKeyId}
            />
          </div>
          <Typography.Text type='secondary'>{t('gateway.singleKeyHint')}</Typography.Text>
        </Space>
      </Modal>
    </div>
  )
}
