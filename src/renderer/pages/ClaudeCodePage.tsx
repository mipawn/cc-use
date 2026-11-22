import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Empty, Space, Spin, Tabs } from 'antd'
import {
  AppstoreOutlined,
  CodeOutlined,
  HistoryOutlined,
  PlusOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { ClientProfile } from '@shared/types'
import { useAppMessage } from '../hooks/useAppMessage'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'
import { useClientProfileStore } from '../stores/clientProfileStore'
import { useProviderModelCatalogStore } from '../stores/providerModelCatalogStore'
import PageHeader from '../components/common/PageHeader'
import ClientProfileCard from '../components/clients/ClientProfileCard'
import ClientProfileDrawer from '../components/clients/ClientProfileDrawer'
import ClaudeGlobalPrefsPanel from '../components/clients/ClaudeGlobalPrefsPanel'
import Instances from './Instances'
import Sessions from './Sessions'
import { buildStatisticsUrl } from '../utils/observationContext'
import styles from './ClientWorkspace.module.css'

type ClaudeTab = 'profiles' | 'instances' | 'sessions' | 'global'

export default function ClaudeCodePage() {
  const { t } = useTranslation()
  const message = useAppMessage()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const { providers, fetchProviders } = useProviderStore()
  const { apiKeys, fetchAllApiKeys } = useApiKeyStore()
  const { profiles, loading, fetchProfiles, createProfile, updateProfile, deleteProfile } =
    useClientProfileStore()
  const { catalogs, fetchCatalog } = useProviderModelCatalogStore()

  const tabParam = searchParams.get('tab') as ClaudeTab | null
  const activeTab: ClaudeTab =
    tabParam && ['profiles', 'instances', 'sessions', 'global'].includes(tabParam)
      ? tabParam
      : 'profiles'

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingProfile, setEditingProfile] = useState<ClientProfile | null>(null)

  const loadAll = useCallback(async () => {
    await Promise.all([fetchProviders(), fetchProfiles('claude_code')])
  }, [fetchProviders, fetchProfiles])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  useEffect(() => {
    if (providers.length > 0) {
      void fetchAllApiKeys(providers.map((item) => item.id))
      for (const provider of providers) {
        void fetchCatalog(provider.id).catch(() => {})
      }
    }
  }, [providers, fetchAllApiKeys, fetchCatalog])

  usePageRefresh(loadAll)

  const ccProfiles = useMemo(
    () => profiles.filter((item) => item.clientKind === 'claude_code'),
    [profiles],
  )

  const handleSwapKey = async (profile: ClientProfile, nextKeyId: string) => {
    const providerKeyList = apiKeys[profile.providerId] ?? []
    const nextKey = providerKeyList.find((item) => item.id === nextKeyId)
    try {
      await updateProfile({ id: profile.id, apiKeyId: nextKeyId })
      message.success(
        t('profiles.keySwapped', { key: nextKey?.alias || t('instances.unnamedKey') }),
      )
    } catch {
      message.error(t('profiles.keySwapFailed'))
    }
  }

  const handleDuplicate = async (profile: ClientProfile) => {
    try {
      await createProfile({
        name: `${profile.name}${t('profiles.copySuffix')}`,
        clientKind: 'claude_code',
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

  const handleSetDefault = async (profile: ClientProfile) => {
    try {
      await updateProfile({ id: profile.id, isDefault: true })
      message.success(t('profiles.saved'))
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  }

  const setTab = (next: string) => {
    const nextParams = new URLSearchParams(searchParams)
    if (next === 'profiles') nextParams.delete('tab')
    else nextParams.set('tab', next)
    setSearchParams(nextParams, { replace: true })
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title={t('clients.claudeCode')}
        actions={
          activeTab === 'profiles' ? (
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
          ) : undefined
        }
      />

      <Tabs
        activeKey={activeTab}
        onChange={setTab}
        items={[
          {
            key: 'profiles',
            label: (
              <Space size={6}>
                <AppstoreOutlined />
                <span>{t('clients.tabProfiles')}</span>
              </Space>
            ),
            children:
              loading && ccProfiles.length === 0 ? (
                <div className={styles.emptyWrap}>
                  <Spin />
                </div>
              ) : ccProfiles.length === 0 ? (
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
                  {ccProfiles.map((profile) => {
                    const provider = providers.find((item) => item.id === profile.providerId)
                    const providerKeys = apiKeys[profile.providerId] ?? []
                    const apiKey = providerKeys.find((item) => item.id === profile.apiKeyId)
                    return (
                      <ClientProfileCard
                        key={profile.id}
                        profile={profile}
                        provider={provider}
                        apiKey={apiKey}
                        providerKeys={providerKeys}
                        catalogCount={catalogs[profile.providerId]?.models.length ?? 0}
                        onEdit={(item) => {
                          setEditingProfile(item)
                          setDrawerOpen(true)
                        }}
                        onDuplicate={(item) => void handleDuplicate(item)}
                        onDelete={(item) => void handleDelete(item)}
                        onSetDefault={(item) => void handleSetDefault(item)}
                        onSwapKey={handleSwapKey}
                      />
                    )
                  })}
                </div>
              ),
          },
          {
            key: 'instances',
            label: (
              <Space size={6}>
                <CodeOutlined />
                <span>{t('clients.tabInstances')}</span>
              </Space>
            ),
            children: (
              <Instances
                clientKind='claude_code'
                embedded
                onViewRequests={(instanceId) =>
                  navigate(buildStatisticsUrl({ filter: { instanceId } }))
                }
              />
            ),
          },
          {
            key: 'sessions',
            label: (
              <Space size={6}>
                <HistoryOutlined />
                <span>{t('clients.tabSessions')}</span>
              </Space>
            ),
            children: <Sessions />,
          },
          {
            key: 'global',
            label: (
              <Space size={6}>
                <SettingOutlined />
                <span>{t('clients.tabGlobalPrefs')}</span>
              </Space>
            ),
            children: <ClaudeGlobalPrefsPanel />,
          },
        ]}
      />

      <ClientProfileDrawer
        open={drawerOpen}
        clientKind='claude_code'
        profile={editingProfile}
        providers={providers}
        apiKeysByProvider={apiKeys}
        onClose={() => {
          setDrawerOpen(false)
          setEditingProfile(null)
        }}
        onCreate={createProfile}
        onUpdate={updateProfile}
      />
    </div>
  )
}
