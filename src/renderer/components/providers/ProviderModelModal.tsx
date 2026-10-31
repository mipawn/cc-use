import { useEffect, useState } from 'react'
import { Alert, Button, Input, Modal, Select, Spin, Typography } from 'antd'
import { ReloadOutlined, UndoOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import type { ApiKey, GatewayConnectionConfig, Provider, ProviderModelCatalog } from '@shared/types'
import { useModelCatalogQuery } from '../../hooks/useModelCatalogQuery'
import { useProviderModelCatalogStore } from '../../stores/providerModelCatalogStore'
import { useAppMessage } from '../../hooks/useAppMessage'
import { EMPTY_MODEL_MAPPING } from '../../utils/modelMapping'
import ModelCatalogManager from '../keys/ModelCatalogManager'
import type { ModelEditorActions } from '../keys/ModelEditorView'
import UserAgentField from '../UserAgentField'
import styles from './ProviderModelModal.module.css'

interface Props {
  provider: Provider
  apiKeys: ApiKey[]
  onClose: () => void
}
export default function ProviderModelModal({ provider, apiKeys, onClose }: Props) {
  const { t } = useTranslation()
  const message = useAppMessage()
  const { fetchCatalog, saveCatalog } = useProviderModelCatalogStore()
  const [snapshot, setSnapshot] = useState<ProviderModelCatalog | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [reading, setReading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadVersion, setLoadVersion] = useState(0)
  const [actions, setActions] = useState<ModelEditorActions | null>(null)
  const [apiKeyId, setApiKeyId] = useState<string | undefined>(
    apiKeys.length === 1 ? apiKeys[0].id : undefined,
  )
  useEffect(() => {
    // The provider page may still be loading keys when this window opens; once
    // exactly one arrives, preselect it instead of leaving the query disabled.
    if (apiKeyId === undefined && apiKeys.length === 1) setApiKeyId(apiKeys[0].id)
  }, [apiKeys, apiKeyId])
  const [baseUrl, setBaseUrl] = useState('')
  const [authScheme, setAuthScheme] = useState<GatewayConnectionConfig['authScheme']>('bearer')
  const selectedKey = apiKeys.find((key) => key.id === apiKeyId)
  const validUrl =
    !baseUrl.trim() ||
    (() => {
      try {
        const url = new URL(baseUrl.trim())
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          Boolean(url.host) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        )
      } catch {
        return false
      }
    })()
  const query = useModelCatalogQuery({
    provider,
    providerId: provider.id,
    apiKeyId,
    keyValue: selectedKey?.value ?? '',
    connectionConfig: { baseUrl: baseUrl.trim() || null, authScheme },
    enabled: validUrl,
  })
  const validUa = !/[\r\n]/u.test(query.userAgent)
  useEffect(() => {
    let alive = true
    setReading(true)
    setReadError(null)
    void fetchCatalog(provider.id)
      .then(
        (catalog) => {
          if (alive) {
            const latest = useProviderModelCatalogStore.getState().catalogs[provider.id]
            setSnapshot(latest && latest.revision > catalog.revision ? latest : catalog)
          }
        },
        (error: unknown) => {
          if (alive) setReadError(String(error))
        },
      )
      .finally(() => {
        if (alive) setReading(false)
      })
    return () => {
      alive = false
    }
  }, [fetchCatalog, provider.id, loadVersion])
  const save = async (models: ProviderModelCatalog['models']) => {
    if (!snapshot || reading || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      await saveCatalog(provider.id, models, snapshot.revision)
      message.success(t('keys.catalogSaved'))
      onClose()
    } catch (error) {
      setSaveError(String(error))
    } finally {
      setSaving(false)
    }
  }
  const queryStatusKey =
    query.status === 'missingCredential'
      ? 'keys.catalogKeyRequired'
      : query.status === 'loading'
        ? 'keys.catalogLoading'
        : query.status === 'empty'
          ? 'keys.catalogEmpty'
          : query.status === 'idle'
            ? 'keys.catalogIdle'
            : query.stale
              ? 'keys.catalogStaleShort'
              : query.status === 'ready'
                ? 'keys.catalogFreshShort'
                : undefined

  return (
    <Modal
      open
      title={
        <div className={styles.title}>
          <span>{t('keys.viewModels')}</span>
          <Typography.Text type='secondary'>{provider.name}</Typography.Text>
        </div>
      }
      width={820}
      style={{ top: 24 }}
      onCancel={() => {
        if (!saving) onClose()
      }}
      closable={!saving}
      keyboard={!saving}
      maskClosable={!saving}
      destroyOnHidden
      footer={
        <div className={styles.footer}>
          <Button disabled={saving} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type='primary'
            loading={saving}
            disabled={reading || !snapshot || !actions?.confirm}
            onClick={() => actions?.confirm?.()}
          >
            {t('keys.catalogSave')}
          </Button>
        </div>
      }
    >
      <SimpleBar className={styles.body}>
        <div className={styles.content}>
          <section className={styles.querySection} aria-label={t('keys.queryConnection')}>
            <div className={styles.queryHeader}>
              <Typography.Text strong>{t('keys.queryConnection')}</Typography.Text>
              {queryStatusKey && (
                <Typography.Text type='secondary' className={styles.queryStatus}>
                  {t(queryStatusKey)}
                </Typography.Text>
              )}
            </div>
            <div className={styles.queryRow}>
              <label htmlFor='provider-model-query-key'>{t('keys.queryKey')}</label>
              <Select
                id='provider-model-query-key'
                aria-label={t('keys.queryKey')}
                className={styles.keySelect}
                value={apiKeyId}
                placeholder={t('gateway.keyPlaceholder')}
                disabled={saving}
                options={apiKeys.map((key) => ({ value: key.id, label: key.alias || key.id }))}
                onChange={setApiKeyId}
              />
              <Button
                icon={<ReloadOutlined />}
                loading={query.status === 'loading'}
                disabled={saving || !query.canQuery || !validUa}
                onClick={() => query.query({ force: true })}
              >
                {t(query.catalog ? 'keys.catalogRefresh' : 'keys.catalogLoad')}
              </Button>
            </div>
            <details className={styles.connectionDetails}>
              <summary>
                <span>{t('gateway.connection')}</span>
                <code title={query.route.baseUrl}>
                  {query.route.baseUrl || t('keys.connectionUnset')}
                </code>
              </summary>
              <div className={styles.connectionFields}>
                <Typography.Text type='secondary' className={styles.connectionHint}>
                  {t('keys.queryConnectionHint')}
                </Typography.Text>
                <div className={styles.field}>
                  <label htmlFor='provider-model-query-url'>{t('gateway.baseUrl')}</label>
                  <div className={styles.urlField}>
                    <Input
                      id='provider-model-query-url'
                      aria-label={t('gateway.baseUrl')}
                      value={baseUrl}
                      placeholder={provider.baseUrl || t('keys.connectionUnset')}
                      status={validUrl ? undefined : 'error'}
                      disabled={saving}
                      onChange={(event) => setBaseUrl(event.target.value)}
                    />
                    <Button
                      type='text'
                      icon={<UndoOutlined />}
                      aria-label={t('gateway.restoreDefault')}
                      disabled={saving || !baseUrl.trim()}
                      onClick={() => setBaseUrl('')}
                    >
                      {t('gateway.restoreDefault')}
                    </Button>
                  </div>
                </div>
                <details className={styles.advancedDetails}>
                  <summary>{t('gateway.advanced')}</summary>
                  <div className={styles.advancedFields}>
                    <div className={styles.field}>
                      <span>{t('gateway.authScheme')}</span>
                      <Select
                        aria-label={t('gateway.authScheme')}
                        className={styles.authSelect}
                        value={authScheme}
                        disabled={saving}
                        options={[
                          { value: 'bearer', label: t('gateway.authBearer') },
                          { value: 'x-api-key', label: t('gateway.authXApiKey') },
                          { value: 'none', label: t('gateway.authNone') },
                        ]}
                        onChange={setAuthScheme}
                      />
                    </div>
                    <div className={styles.field}>
                      <span>{t('gateway.userAgent')}</span>
                      <UserAgentField
                        value={query.userAgent}
                        placeholder={t('keys.modelListUaDefault')}
                        onChange={query.setUserAgent}
                        onApply={(value) => {
                          if (!/[\r\n]/u.test(value)) query.applyUserAgent(value)
                        }}
                        disabled={saving || !validUrl}
                      />
                    </div>
                  </div>
                </details>
              </div>
            </details>
            {!validUrl && (
              <Typography.Text type='danger' className={styles.inlineNotice}>
                {t('gateway.invalidBaseUrl')}
              </Typography.Text>
            )}
            {!validUa && (
              <Typography.Text type='danger' className={styles.inlineNotice}>
                {t('gateway.invalidUserAgent')}
              </Typography.Text>
            )}
          </section>
          {selectedKey && (!selectedKey.isActive || selectedKey.isExhausted) && (
            <Alert type='warning' showIcon title={t('gateway.keyUnavailable')} />
          )}
          {query.error && (
            <Alert
              type='error'
              showIcon
              title={query.error}
              action={
                <Button
                  size='small'
                  disabled={saving || !query.canQuery || !validUa}
                  onClick={() => query.query({ force: true })}
                >
                  {t('common.retry')}
                </Button>
              }
            />
          )}
          {(readError || saveError) && (
            <Alert
              type='error'
              showIcon
              title={saveError ? t('keys.catalogSaveConflict') : t('gateway.catalogLoadFailed')}
              description={readError || saveError}
              action={
                <Button
                  size='small'
                  loading={reading}
                  onClick={() => {
                    setSnapshot(null)
                    setSaveError(null)
                    setLoadVersion((version) => version + 1)
                  }}
                >
                  {t('keys.catalogReload')}
                </Button>
              }
            />
          )}
          <section className={styles.catalogSection} aria-label={t('keys.providerModelList')}>
            <div className={styles.catalogHeader}>
              <Typography.Text strong>{t('keys.providerModelList')}</Typography.Text>
              <Typography.Text type='secondary'>{t('keys.providerModelHint')}</Typography.Text>
            </div>
            {snapshot ? (
              <ModelCatalogManager
                key={`${provider.id}:${loadVersion}`}
                providerManagement
                disabled={saving}
                label={provider.name}
                value={{
                  ...EMPTY_MODEL_MAPPING.clients.codex,
                  catalogMode: 'custom',
                  models: snapshot.models,
                }}
                catalog={query.catalog}
                onCommit={({ models }) => void save(models)}
                onBack={() => {}}
                onActionsChange={setActions}
              />
            ) : reading ? (
              <div className={styles.reading}>
                <Spin size='small' />
                {t('common.loading')}
              </div>
            ) : null}
          </section>
        </div>
      </SimpleBar>
    </Modal>
  )
}
