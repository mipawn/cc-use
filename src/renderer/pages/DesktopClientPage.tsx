import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, App, Button, Empty, Skeleton, Space, Tag, Typography } from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type {
  ClientProfile,
  DesktopClientKind,
  DesktopConnectionState,
  DesktopOperationResult,
} from '@shared/types'
import { getClientKindLabel } from '@shared/types'
import { getApi } from '../api'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'
import { useClientProfileStore } from '../stores/clientProfileStore'
import { useProviderModelCatalogStore } from '../stores/providerModelCatalogStore'
import PageHeader from '../components/common/PageHeader'
import ClientIcon from '../components/common/ClientIcon'
import ProviderIcon from '../components/providers/ProviderIcon'
import ConfigPreviewButton from '../components/launchpad/ConfigPreviewButton'
import ClientProfileCard from '../components/clients/ClientProfileCard'
import ClientProfileDrawer from '../components/clients/ClientProfileDrawer'
import styles from './ClientWorkspace.module.css'

const { Text } = Typography

interface DesktopClientPageProps {
  clientKind: DesktopClientKind
}

export default function DesktopClientPage({ clientKind }: DesktopClientPageProps) {
  const { t, i18n } = useTranslation()
  const { message, modal } = App.useApp()
  const label = getClientKindLabel(clientKind)

  const { providers, fetchProviders } = useProviderStore()
  const { apiKeys, fetchAllApiKeys } = useApiKeyStore()
  const { profiles, fetchProfiles, createProfile, updateProfile, deleteProfile } =
    useClientProfileStore()
  const { catalogs, fetchCatalog } = useProviderModelCatalogStore()

  const [state, setState] = useState<DesktopConnectionState | null>(null)
  const [result, setResult] = useState<DesktopOperationResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [busyProfileId, setBusyProfileId] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingProfile, setEditingProfile] = useState<ClientProfile | null>(null)

  const mounted = useRef(true)
  const operation = useRef(false)
  const revision = useRef(0)

  const load = useCallback(async () => {
    if (!mounted.current) return
    const req = ++revision.current
    setLoading(true)
    try {
      const [nextState] = await Promise.all([
        getApi().desktopConnection.state(clientKind),
        fetchProviders(),
        fetchProfiles(clientKind),
      ])
      if (!mounted.current || req !== revision.current) return
      setState(nextState)
      setFailed(false)
    } catch {
      if (mounted.current && req === revision.current) setFailed(true)
    } finally {
      if (mounted.current && req === revision.current) setLoading(false)
    }
  }, [clientKind, fetchProviders, fetchProfiles])

  useEffect(() => {
    mounted.current = true
    setResult(null)
    void load()
    return () => {
      mounted.current = false
      revision.current += 1
    }
  }, [load])

  useEffect(() => {
    if (providers.length > 0) {
      void fetchAllApiKeys(providers.map((item) => item.id))
      for (const provider of providers) {
        void fetchCatalog(provider.id).catch(() => {})
      }
    }
  }, [providers, fetchAllApiKeys, fetchCatalog])

  usePageRefresh(async () => {
    if (!operation.current) await load()
  })

  const clientProfiles = useMemo(
    () => profiles.filter((item) => item.clientKind === clientKind),
    [profiles, clientKind],
  )

  const applyResult = (next: DesktopOperationResult) => {
    if (!mounted.current) return
    setState(next.state)
    setResult(next)
    setFailed(false)
    if (next.completion === 'partial') {
      message.warning(t('desktopAccess.partial'))
      return
    }
    message.success(
      t(
        next.configChanged
          ? 'desktopAccess.configSaved'
          : next.routeChanged
            ? 'desktopAccess.routeApplied'
            : 'desktopAccess.unchanged',
      ),
    )
  }

  const handleApplyProfile = async (profile: ClientProfile) => {
    if (operation.current || !mounted.current) return
    operation.current = true
    ++revision.current
    setBusyProfileId(profile.id)
    try {
      const next = await getApi().desktopConnection.apply(
        clientKind,
        profile.providerId,
        profile.apiKeyId,
        profile.id,
      )
      applyResult(next)
    } catch (error) {
      if (mounted.current) {
        message.error(error instanceof Error ? error.message : t('desktopAccess.operationFailed'))
      }
      await load()
    } finally {
      operation.current = false
      if (mounted.current) setBusyProfileId(null)
    }
  }

  const handleRestore = () => {
    modal.confirm({
      title: t('desktopAccess.restoreTitle', { client: label }),
      content: t('desktopAccess.restoreHint'),
      okText: t('desktopAccess.restore'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        if (operation.current || !mounted.current) return
        operation.current = true
        ++revision.current
        setRestoring(true)
        try {
          applyResult(await getApi().desktopConnection.restore(clientKind))
        } catch {
          if (mounted.current) message.error(t('desktopAccess.operationFailed'))
          await load()
        } finally {
          operation.current = false
          if (mounted.current) setRestoring(false)
        }
      },
    })
  }

  const handleSwapKey = async (profile: ClientProfile, nextKeyId: string) => {
    const providerKeyList = apiKeys[profile.providerId] ?? []
    const nextKey = providerKeyList.find((item) => item.id === nextKeyId)
    try {
      await updateProfile({ id: profile.id, apiKeyId: nextKeyId })
      message.success(
        t('profiles.keySwapped', { key: nextKey?.alias || t('instances.unnamedKey') }),
      )
      // Reload desktop state so route + any syncFailure stays exact
      const nextState = await getApi().desktopConnection.state(clientKind)
      if (mounted.current) setState(nextState)
    } catch {
      message.error(t('profiles.keySwapFailed'))
    }
  }

  const handleDuplicate = async (profile: ClientProfile) => {
    try {
      await createProfile({
        name: `${profile.name}${t('profiles.copySuffix')}`,
        clientKind,
        providerId: profile.providerId,
        apiKeyId: profile.apiKeyId,
        isDefault: false,
        modelConfig: profile.modelConfig,
        connectionConfig: profile.connectionConfig,
        launchEnv: profile.launchEnv,
      })
      message.success(t('profiles.created'))
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  }

  const handleDelete = async (profile: ClientProfile) => {
    try {
      await deleteProfile(profile.id)
      message.success(t('profiles.deleted'))
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  }

  const status = failed ? 'unknown' : state?.status || 'unknown'
  const currentProvider = providers.find((item) => item.id === state?.route?.providerId)
  const currentKey = state?.route
    ? (apiKeys[state.route.providerId] ?? []).find((item) => item.id === state.route?.apiKeyId)
    : undefined
  const currentProfile = state?.route?.profileId
    ? clientProfiles.find((item) => item.id === state.route?.profileId)
    : undefined
  const changed = state?.lastConfigChange

  const canRestore = !loading && status !== 'official' && status !== 'not_found'

  return (
    <div className={styles.page} aria-busy={loading || Boolean(busyProfileId) || restoring}>
      <PageHeader
        title={label}
        actions={
          <Button
            type='primary'
            icon={<PlusOutlined />}
            onClick={() => {
              setEditingProfile(null)
              setDrawerOpen(true)
            }}
          >
            {t('profiles.create')}
          </Button>
        }
      />

      {/* Top Desktop Connection Status Card */}
      <section className={styles.statusCard}>
        <div className={styles.statusHeader}>
          <div className={styles.statusIdentity}>
            <ClientIcon kind={clientKind} size={28} />
            <Space size={8} align='center'>
              <Text strong style={{ fontSize: 15 }}>
                {label}
              </Text>
              <Tag
                color={
                  status === 'taken_over'
                    ? 'green'
                    : status === 'error' || status === 'unknown'
                      ? 'orange'
                      : 'default'
                }
              >
                {t(`desktopAccess.status.${status}`)}
              </Tag>
            </Space>
          </div>
          <Space wrap>
            <ConfigPreviewButton key={clientKind} clientKind={clientKind} />
            <Button
              danger
              loading={restoring}
              disabled={!canRestore}
              onClick={handleRestore}
            >
              {t('desktopAccess.restore')}
            </Button>
            <Button
              icon={<ReloadOutlined />}
              aria-label={t('common.refresh')}
              loading={loading}
              onClick={() => void load()}
            />
          </Space>
        </div>

        {loading && !state ? (
          <Skeleton active paragraph={{ rows: 2 }} />
        ) : (
          <div className={styles.statusRoute}>
            <Space size={10}>
              <Text type='secondary'>{t('desktopAccess.currentRoute')}:</Text>
              {state?.route ? (
                <Space size={8}>
                  {currentProvider && (
                    <ProviderIcon
                      icon={currentProvider.icon}
                      name={currentProvider.name}
                      size={20}
                    />
                  )}
                  <Text strong>
                    {currentProfile ? `${currentProfile.name} · ` : ''}
                    {currentProvider?.name || t('desktopAccess.resourceUnavailable')} /{' '}
                    {currentKey?.alias ||
                      (currentKey
                        ? t('instances.unnamedKey')
                        : t('desktopAccess.resourceUnavailable'))}
                  </Text>
                </Space>
              ) : (
                <Text>
                  {t(status === 'official' ? 'desktopAccess.officialRoute' : 'desktopAccess.noRoute')}
                </Text>
              )}
            </Space>
          </div>
        )}

        {failed && (
          <Alert
            type='error'
            showIcon
            title={t('desktopAccess.loadFailed')}
            description={t('desktopAccess.unknownHint')}
            action={<Button onClick={() => void load()}>{t('common.retry')}</Button>}
          />
        )}
        {result?.completion === 'partial' && (
          <Alert
            type='warning'
            showIcon
            title={t('desktopAccess.partial')}
            description={result.warning || t('desktopAccess.partialHint')}
          />
        )}
        {state?.warning &&
          !(result?.completion === 'partial' && result.warning === state.warning) && (
            <Alert type='warning' showIcon title={state.warning} />
          )}
        {state?.syncFailure && (
          <Alert
            type='error'
            showIcon
            title={t(
              state.syncFailure.source === 'key_edit'
                ? 'desktopAccess.syncFailed'
                : 'desktopAccess.configSyncFailed',
            )}
            description={state.syncFailure.message}
          />
        )}
        {changed && (
          <div className={styles.noticeBox}>
            <Space size={8} wrap>
              <strong>{t('desktopAccess.lastConfigChange')}</strong>
              <Text type='secondary'>
                {new Date(changed.changedAt).toLocaleString(i18n.language)} ·{' '}
                {t(`desktopAccess.change.${changed.action}`)} ·{' '}
                {t(`desktopAccess.source.${changed.source}`)}
              </Text>
            </Space>
            <span>{t('desktopAccess.reopenHint', { client: label })}</span>
          </div>
        )}
      </section>

      {/* Desktop Access Profiles */}
      <div className={styles.sectionHeading}>
        <Text strong style={{ fontSize: 15 }}>
          {t('profiles.desktopTitle')} ({clientProfiles.length})
        </Text>
      </div>

      {clientProfiles.length === 0 ? (
        <div className={styles.emptyWrap}>
          <Empty description={t('profiles.empty')}>
            <Button
              type='primary'
              icon={<PlusOutlined />}
              onClick={() => {
                setEditingProfile(null)
                setDrawerOpen(true)
              }}
            >
              {t('profiles.createFirst')}
            </Button>
          </Empty>
        </div>
      ) : (
        <div className={styles.profilesGrid}>
          {clientProfiles.map((profile) => {
            const provider = providers.find((item) => item.id === profile.providerId)
            const providerKeys = apiKeys[profile.providerId] ?? []
            const apiKey = providerKeys.find((item) => item.id === profile.apiKeyId)
            const isApplied =
              status === 'taken_over' &&
              (state?.route?.profileId
                ? state.route.profileId === profile.id
                : state?.route?.providerId === profile.providerId &&
                  state?.route?.apiKeyId === profile.apiKeyId)
            return (
              <ClientProfileCard
                key={profile.id}
                profile={profile}
                provider={provider}
                apiKey={apiKey}
                providerKeys={providerKeys}
                catalogCount={catalogs[profile.providerId]?.models.length ?? 0}
                isAppliedDesktop={isApplied}
                applying={busyProfileId === profile.id}
                onApplyDesktop={(item) => void handleApplyProfile(item)}
                onEdit={(item) => {
                  setEditingProfile(item)
                  setDrawerOpen(true)
                }}
                onDuplicate={(item) => void handleDuplicate(item)}
                onDelete={(item) => void handleDelete(item)}
                onSwapKey={handleSwapKey}
              />
            )
          })}
        </div>
      )}

      <ClientProfileDrawer
        open={drawerOpen}
        clientKind={clientKind}
        profile={editingProfile}
        providers={providers}
        apiKeysByProvider={apiKeys}
        onClose={() => {
          setDrawerOpen(false)
          setEditingProfile(null)
        }}
        onCreate={createProfile}
        onUpdate={async (input) => {
          const updated = await updateProfile(input)
          const nextState = await getApi().desktopConnection.state(clientKind)
          if (mounted.current) setState(nextState)
          return updated
        }}
      />
    </div>
  )
}
