import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Empty, Space, Spin, Tabs } from 'antd'
import { AppstoreOutlined, CodeOutlined, PlusOutlined } from '@ant-design/icons'
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
import Instances from './Instances'
import { buildStatisticsUrl } from '../utils/observationContext'
import styles from './ClientWorkspace.module.css'

type GrokTab = 'profiles' | 'instances'

export default function GrokPage() {
  const { t } = useTranslation()
  const message = useAppMessage()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const { providers, fetchProviders } = useProviderStore()
  const { apiKeys, fetchAllApiKeys } = useApiKeyStore()
  const { profiles, loading, fetchProfiles, createProfile, updateProfile, deleteProfile } =
    useClientProfileStore()
  const { catalogs, fetchCatalog } = useProviderModelCatalogStore()

  const tabParam = searchParams.get('tab') as GrokTab | null
  const activeTab: GrokTab = tabParam === 'instances' ? 'instances' : 'profiles'

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingProfile, setEditingProfile] = useState<ClientProfile | null>(null)

  const loadAll = useCallback(async () => {
    await Promise.all([fetchProviders(), fetchProfiles('grok')])
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

  const grokProfiles = useMemo(
    () => profiles.filter((item) => item.clientKind === 'grok'),
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
        clientKind: 'grok',
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
        title={t('clients.grokBuild')}
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
              loading && grokProfiles.length === 0 ? (
                <div className={styles.emptyWrap}>
                  <Spin />
                </div>
              ) : grokProfiles.length === 0 ? (
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
                  {grokProfiles.map((profile) => {
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
                clientKind='grok'
                embedded
                onViewRequests={(instanceId) =>
                  navigate(buildStatisticsUrl({ filter: { instanceId } }))
                }
              />
            ),
          },
        ]}
      />

      <ClientProfileDrawer
        open={drawerOpen}
        clientKind='grok'
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
