import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Empty, Input, Modal, Segmented, Space, Tag, Typography } from 'antd'
import {
  CheckOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  StarOutlined,
} from '@ant-design/icons'
import type { ApiKey, ClientKind, Provider } from '@shared/types'
import { getClientKindLabel } from '@shared/types'
import { useTranslation } from 'react-i18next'
import { getApi } from '../../api'
import { supportsKeyClient } from '../../utils/clientSupport'
import { isOfficialDeepSeekProvider } from '../../utils/officialProviders'
import { parseModelMapping } from '../../utils/modelMapping'
import { hasKeyQuery, hasProviderQuery, providerQuotaIsPerKey } from '../../utils/accountQuery'
import { toCreateApiKeyInput } from '../../utils/apiKeyEditor'
import { useProviderStore } from '../../stores/providerStore'
import { useApiKeyStore } from '../../stores/apiKeyStore'
import ProviderIcon from '../providers/ProviderIcon'
const ProviderModal = lazy(() => import('../providers/ProviderModal'))
const KeyEditModal = lazy(() => import('../keys/KeyEditModal'))
import QuotaSnapshot from './QuotaSnapshot'
import styles from './RoutePickerModal.module.css'

const { Text } = Typography
const keyName = (key: ApiKey) => key.alias || `Key ${key.priority + 1}`

export function getRouteModelLabel(
  key: Pick<ApiKey, 'config' | 'modelMapping'>,
  clientKind: ClientKind,
  providerLabel = '跟随供应商',
): string {
  const mapping = parseModelMapping(key.modelMapping)
  const client = mapping.clients[clientKind]
  const local =
    clientKind === 'claude_code'
      ? [
          'ANTHROPIC_MODEL',
          'ANTHROPIC_DEFAULT_OPUS_MODEL',
          'ANTHROPIC_DEFAULT_SONNET_MODEL',
          'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        ]
          .map((name) => key.config?.[name])
          .filter((model): model is string => typeof model === 'string' && Boolean(model))
      : clientKind === 'grok'
        ? [client.defaultModel].filter(Boolean)
        : client.catalogMode === 'provider'
          ? []
          : client.models.map((model) => model.displayName || model.id)
  const upstream =
    client.forwardMode === 'fixed'
      ? [client.upstreamModel].filter(Boolean)
      : client.forwardMode === 'family'
        ? [client.opus, client.sonnet, client.haiku].filter(Boolean)
        : []
  const localLabel = Array.from(new Set(local)).join(' / ')
  const upstreamLabel = Array.from(new Set(upstream)).join(' / ')
  return localLabel && upstreamLabel && localLabel !== upstreamLabel
    ? `${localLabel} → ${upstreamLabel}`
    : upstreamLabel || localLabel || providerLabel
}

export interface RouteSelection {
  provider: Provider
  apiKey: ApiKey
}
interface RoutePickerModalProps {
  open: boolean
  clientKind?: ClientKind
  context?: 'client' | 'gateway'
  providers: Provider[]
  apiKeys: ApiKey[]
  currentKeyId?: string
  title?: string
  actionText?: string
  onCancel: () => void
  onSelect: (selection: RouteSelection) => Promise<void> | void
  /** Legacy call sites may still pass this; ordering belongs to resources only. */
  onReorderApiKeys?: (providerId: string, keyIds: string[]) => Promise<void> | void
}

export default function RoutePickerModal({
  open,
  clientKind = 'claude_code',
  context = 'client',
  providers,
  apiKeys,
  currentKeyId,
  title,
  actionText,
  onCancel,
  onSelect,
}: RoutePickerModalProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'all' | 'official'>('all')
  const [providerId, setProviderId] = useState('')
  const [selectedKeyId, setSelectedKeyId] = useState('')
  const [step, setStep] = useState<'select' | 'provider' | 'key'>('select')
  const [createProviderId, setCreateProviderId] = useState<string>()
  const [created, setCreated] = useState(false)
  const [addedProviders, setAddedProviders] = useState<Provider[]>([])
  const [addedKeys, setAddedKeys] = useState<ApiKey[]>([])
  const [snapshot, setSnapshot] = useState<{ providers: Provider[]; keys: ApiKey[] } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [submitError, setSubmitError] = useState(false)
  const [refreshError, setRefreshError] = useState(false)
  const mounted = useRef(true)
  const initialized = useRef(false)
  const submission = useRef(false)
  const revision = useRef(0)
  // Parent polling stays authoritative, without resetting search/selection/drafts.
  useEffect(() => {
    setSnapshot(null)
    revision.current += 1
    // Once reflected by the authoritative parent, local creation overlays retire.
    setAddedProviders((previous) =>
      previous.filter((item) => !providers.some((provider) => provider.id === item.id)),
    )
    setAddedKeys((previous) =>
      previous.filter((item) => !apiKeys.some((key) => key.id === item.id)),
    )
  }, [providers, apiKeys])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      revision.current += 1
    }
  }, [])
  const allProviders = useMemo(() => {
    const base = snapshot?.providers ?? providers
    return [...base, ...addedProviders.filter((p) => !base.some((item) => item.id === p.id))]
  }, [snapshot, providers, addedProviders])
  const allKeys = useMemo(() => {
    const base = snapshot?.keys ?? apiKeys
    return [...base, ...addedKeys.filter((k) => !base.some((item) => item.id === k.id))]
  }, [snapshot, apiKeys, addedKeys])
  const compatibleGroups = useMemo(
    () =>
      allProviders
        .map((provider) => ({
          provider,
          keys: allKeys.filter(
            (key) =>
              key.providerId === provider.id &&
              (context === 'gateway' || supportsKeyClient(provider, key, clientKind)),
          ),
        }))
        .filter((group) => group.keys.length > 0),
    [allProviders, allKeys, clientKind, context],
  )
  const filteredGroups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return compatibleGroups
      .filter(({ provider }) => scope === 'all' || isOfficialDeepSeekProvider(provider))
      .map((group) => ({
        ...group,
        keys: group.keys.filter(
          (key) =>
            !needle ||
            [
              group.provider.name,
              key.alias,
              key.id,
              context === 'gateway'
                ? ''
                : getRouteModelLabel(key, clientKind, t('keys.catalogProvider')),
            ].some((value) => value?.toLocaleLowerCase().includes(needle)),
        ),
      }))
      .filter((group) => group.keys.length > 0)
  }, [compatibleGroups, query, scope, context, clientKind, t])
  useEffect(() => {
    if (!open) {
      initialized.current = false
      revision.current += 1
      return
    }
    if (initialized.current) return
    initialized.current = true
    setStep('select')
    setSubmitError(false)
    setRefreshError(false)
    setCreated(false)
    setQuery('')
    setScope('all')
    setSelectedKeyId(currentKeyId ?? '')
    setProviderId(
      allKeys.find((key) => key.id === currentKeyId)?.providerId ??
        compatibleGroups[0]?.provider.id ??
        '',
    )
  }, [open, currentKeyId, allKeys, compatibleGroups])
  // Browsing/searching providers never clears the selected route.
  const activeGroup =
    filteredGroups.find((group) => group.provider.id === providerId) ?? filteredGroups[0]
  const selectedKey = allKeys.find((key) => key.id === selectedKeyId)
  const selectedProvider = allProviders.find((provider) => provider.id === selectedKey?.providerId)
  const selectable = Boolean(
    selectedKey &&
    selectedProvider &&
    selectedProvider.isActive &&
    selectedKey.isActive &&
    !selectedKey.isExhausted &&
    (context === 'gateway' || supportsKeyClient(selectedProvider, selectedKey, clientKind)),
  )
  const allUnavailable =
    compatibleGroups.length > 0 &&
    !compatibleGroups.some(
      ({ provider, keys }) =>
        provider.isActive && keys.some((key) => key.isActive && !key.isExhausted),
    )
  const handleSubmit = async () => {
    if (!selectedKey || !selectedProvider || !selectable || submission.current) return
    submission.current = true
    setSubmitting(true)
    setSubmitError(false)
    try {
      await onSelect({ provider: selectedProvider, apiKey: selectedKey })
      if (mounted.current) onCancel()
    } catch {
      if (mounted.current) setSubmitError(true)
    } finally {
      submission.current = false
      if (mounted.current) setSubmitting(false)
    }
  }
  const refreshQuota = async () => {
    if (refreshing || submitting) return
    const current = ++revision.current
    setRefreshing(true)
    setRefreshError(false)
    try {
      const tasks: Promise<unknown>[] = []
      if (
        activeGroup &&
        hasProviderQuery(activeGroup.provider) &&
        !providerQuotaIsPerKey(activeGroup.provider)
      ) {
        tasks.push(
          getApi()
            .balance.refresh(activeGroup.provider.id)
            .then((result) => {
              if (result.error || !result.isValid) throw new Error('quota unavailable')
            }),
        )
      }
      if (selectedKey && hasKeyQuery(selectedKey))
        tasks.push(
          getApi()
            .keyUsage.refresh(selectedKey.id)
            .then((result) => {
              if (result.error || result.isValid === false) throw new Error('quota unavailable')
            }),
        )
      const results = await Promise.allSettled(tasks)
      const nextProviders = await getApi().provider.list()
      const keys = (await Promise.all(nextProviders.map((p) => getApi().apiKey.list(p.id)))).flat()
      if (revision.current !== current) return
      setSnapshot({ providers: nextProviders, keys })
      setAddedProviders([])
      setAddedKeys([])
      setRefreshError(results.some((result) => result.status === 'rejected'))
    } catch {
      if (revision.current === current) setRefreshError(true)
    } finally {
      setRefreshing(false)
    }
  }
  const emptyDescription =
    query || scope !== 'all'
      ? 'resources.noMatch'
      : !allProviders.length || !allKeys.length
        ? 'resources.noResources'
        : 'resources.noCompatible'
  return (
    <>
      <Modal
        open={open && step === 'select'}
        title={
          title ??
          t(context === 'gateway' ? 'resources.choose' : 'resources.chooseClient', {
            client: getClientKindLabel(clientKind),
          })
        }
        width={900}
        centered
        classNames={{
          root: styles.modal,
          container: styles.modalContainer,
          header: styles.modalHeader,
          title: styles.modalTitle,
          body: styles.modalBody,
          footer: styles.modalFooter,
        }}
        onCancel={() => {
          if (!submission.current) onCancel()
        }}
        keyboard={!submitting}
        closable={!submitting}
        footer={
          <div className={styles.footer}>
            <Text type='secondary'>
              {selectedProvider && selectedKey
                ? `${selectedProvider.name} / ${keyName(selectedKey)}`
                : t('resources.selectHint')}
            </Text>
            <div className={styles.footerActions}>
              <Button disabled={submitting} onClick={onCancel}>
                {t('common.cancel')}
              </Button>
              <Button
                type='primary'
                disabled={!selectable}
                loading={submitting}
                onClick={() => void handleSubmit()}
              >
                {actionText ?? t('resources.apply')}
              </Button>
            </div>
          </div>
        }
      >
        {submitError && <Alert type='error' showIcon title={t('resources.failed')} />}
        {refreshError && <Alert type='warning' showIcon title={t('resources.refreshFailed')} />}
        {created && <Alert type='success' showIcon title={t('resources.created')} />}
        {allUnavailable && <Alert type='warning' showIcon title={t('resources.unavailable')} />}
        <div className={styles.toolbar}>
          <Input
            aria-label={t('resources.search')}
            allowClear
            prefix={<SearchOutlined />}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('resources.search')}
          />
          <Segmented
            value={scope}
            onChange={(value) => setScope(value as 'all' | 'official')}
            options={[
              { label: t('resources.all'), value: 'all' },
              { label: t('resources.official'), value: 'official' },
            ]}
          />
        </div>
        <div className={styles.creationBar}>
          <Space wrap>
            <Button
              icon={<PlusOutlined />}
              disabled={submitting}
              onClick={() => setStep('provider')}
            >
              {t('resources.addProvider')}
            </Button>
            <Button
              icon={<KeyOutlined />}
              disabled={submitting || !allProviders.length}
              onClick={() => {
                setCreateProviderId(activeGroup?.provider.id ?? allProviders[0]?.id)
                setStep('key')
              }}
            >
              {t('resources.addKey')}
            </Button>
          </Space>
          <Button
            icon={<ReloadOutlined />}
            loading={refreshing}
            disabled={submitting}
            onClick={() => void refreshQuota()}
          >
            {t('resources.refreshQuota')}
          </Button>
        </div>
        {filteredGroups.length === 0 ? (
          <Empty className={styles.empty} description={t(emptyDescription)}>
            {(query || scope !== 'all') && (
              <Button
                onClick={() => {
                  setQuery('')
                  setScope('all')
                }}
              >
                {t('resources.clearSearch')}
              </Button>
            )}
            {emptyDescription === 'resources.noCompatible' && (
              <Button href='#/keys' onClick={onCancel}>
                {t('resources.manage')}
              </Button>
            )}
          </Empty>
        ) : (
          <div className={styles.picker}>
            <div className={styles.providerColumn}>
              <Text type='secondary' className={styles.columnLabel}>
                {t('resources.providers')}
              </Text>
              <div className={styles.providerList}>
                {filteredGroups.map(({ provider, keys }) => (
                  <button
                    type='button'
                    key={provider.id}
                    aria-pressed={activeGroup?.provider.id === provider.id}
                    className={`${styles.providerItem} ${activeGroup?.provider.id === provider.id ? styles.providerItemActive : ''}`}
                    onClick={() => setProviderId(provider.id)}
                  >
                    <ProviderIcon icon={provider.icon} size={28} />
                    <span className={styles.providerBody}>
                      <span className={styles.providerNameLine}>
                        <Text strong ellipsis>
                          {provider.name}
                        </Text>
                        {isOfficialDeepSeekProvider(provider) && (
                          <Tag>{t('resources.officialTag')}</Tag>
                        )}
                      </span>
                      <Text type='secondary' className={styles.providerMeta}>
                        {t('resources.keyCount', { count: keys.length })}
                      </Text>
                      {!provider.isActive && (
                        <Text type='warning'>{t('resources.providerDisabled')}</Text>
                      )}
                    </span>
                  </button>
                ))}
                {activeGroup && !providerQuotaIsPerKey(activeGroup.provider) && (
                  <div className={styles.accountQuota}>
                    <QuotaSnapshot
                      owner='account'
                      usage={null}
                      balance={activeGroup.provider.cachedWalletBalance}
                      currency={activeGroup.provider.cachedWalletBalanceCurrency}
                      checkedAt={activeGroup.provider.lastBalanceCheckedAt}
                    />
                    {activeGroup.provider.cachedUsage && (
                      <QuotaSnapshot
                        owner='account'
                        usage={activeGroup.provider.cachedUsage}
                        checkedAt={activeGroup.provider.lastUsageCheckedAt}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className={styles.keyColumn}>
              <Text type='secondary' className={styles.columnLabel}>
                {t('resources.keys')}
              </Text>
              <div className={styles.keyList}>
                {activeGroup?.keys.map((key) => {
                  const disabled =
                    !activeGroup.provider.isActive || !key.isActive || key.isExhausted
                  const selected = key.id === selectedKeyId
                  return (
                    <div
                      key={key.id}
                      className={`${styles.keyItem} ${selected ? styles.keyItemSelected : ''}`}
                      role='button'
                      tabIndex={disabled ? -1 : 0}
                      aria-disabled={disabled}
                      aria-pressed={selected}
                      onClick={() => {
                        if (!disabled && !submitting) setSelectedKeyId(key.id)
                      }}
                      onKeyDown={(event) => {
                        if (
                          !disabled &&
                          !submitting &&
                          (event.key === 'Enter' || event.key === ' ')
                        ) {
                          event.preventDefault()
                          setSelectedKeyId(key.id)
                        }
                      }}
                    >
                      <span className={styles.keyIcon}>
                        <KeyOutlined />
                      </span>
                      <div className={styles.keyBody}>
                        <span className={styles.keyNameLine}>
                          <Text strong>{keyName(key)}</Text>
                          {key.id === currentKeyId && (
                            <Tag icon={<StarOutlined />} color='success'>
                              {t('resources.current')}
                            </Tag>
                          )}
                          {disabled && (
                            <Tag>
                              {t(key.isExhausted ? 'resources.exhausted' : 'resources.disabled')}
                            </Tag>
                          )}
                        </span>
                        <Text type='secondary' className={styles.modelName}>
                          {context === 'gateway'
                            ? t('resources.gatewayModels')
                            : getRouteModelLabel(key, clientKind, t('keys.catalogProvider'))}
                        </Text>
                        <QuotaSnapshot
                          owner='key'
                          usage={key.cachedUsage}
                          checkedAt={key.lastUsageCheckedAt}
                        />
                      </div>
                      {selected && <CheckOutlined className={styles.checkIcon} />}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
        <Text type='secondary' className={styles.cacheHint}>
          {t('resources.cacheHint')} {t('resources.createHint')}
        </Text>
      </Modal>
      {/* One visible modal at a time: the selection host retains the target and draft. */}
      <Suspense fallback={null}>
        {open && step === 'provider' && (
          <ProviderModal
            open
            provider={null}
            defaultClientKind={context === 'client' ? clientKind : undefined}
            onClose={() => setStep((current) => (current === 'provider' ? 'select' : current))}
            onSave={async (input) => {
              const provider = await useProviderStore.getState().createProvider(input)
              setAddedProviders((previous) => [...previous, provider])
              setCreateProviderId(provider.id)
              setProviderId(provider.id)
              setStep('key')
            }}
          />
        )}
        {open && step === 'key' && (
          <KeyEditModal
            open
            defaultClientKind={context === 'client' ? clientKind : undefined}
            mode='create'
            apiKey={null}
            providers={allProviders}
            defaultProviderId={createProviderId}
            onClose={() => setStep('select')}
            onSave={async (input) => {
              const key = await useApiKeyStore.getState().createApiKey(toCreateApiKeyInput(input))
              setAddedKeys((previous) => [...previous, key])
              setSelectedKeyId(key.id)
              setProviderId(key.providerId)
              setCreated(true)
              // Saving is complete. A failed first quota query must not invite duplicate saves.
              if (hasKeyQuery(key))
                void getApi()
                  .keyUsage.refresh(key.id)
                  .then((result) => {
                    if (mounted.current && (result.error || result.isValid === false))
                      setRefreshError(true)
                    if (mounted.current && result.usage)
                      setAddedKeys((previous) =>
                        previous.map((item) =>
                          item.id === key.id
                            ? {
                                ...item,
                                cachedUsage: result.usage,
                                lastUsageCheckedAt: new Date().toISOString(),
                              }
                            : item,
                        ),
                      )
                  })
                  .catch(() => {
                    if (mounted.current) setRefreshError(true)
                  })
            }}
          />
        )}
      </Suspense>
    </>
  )
}
