import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Segmented, Skeleton, Space, Tag, Typography } from 'antd'
import { ReloadOutlined, SwapOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { getApi } from '../api'
import { usePageRefresh } from '../hooks/usePageRefresh'
import type {
  ApiKey,
  DesktopClientKind,
  DesktopConnectionState,
  DesktopOperationResult,
  Provider,
} from '@shared/types'
import { getClientKindLabel } from '@shared/types'
import PageHeader from '../components/common/PageHeader'
import ClientIcon from '../components/common/ClientIcon'
import ProviderIcon from '../components/providers/ProviderIcon'
import ConfigPreviewButton from '../components/launchpad/ConfigPreviewButton'
import RoutePickerModal, {
  getRouteModelLabel,
  type RouteSelection,
} from '../components/common/RoutePickerModal'
import styles from './DesktopPage.module.css'

const { Text } = Typography

function DesktopClientPanel({ clientKind }: { clientKind: DesktopClientKind }) {
  const { t, i18n } = useTranslation()
  const { message, modal } = App.useApp()
  const [state, setState] = useState<DesktopConnectionState | null>(null)
  const [result, setResult] = useState<DesktopOperationResult | null>(null)
  const [providers, setProviders] = useState<Provider[]>([])
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const mounted = useRef(true)
  const confirmation = useRef<ReturnType<typeof modal.confirm> | null>(null)
  const revision = useRef(0)
  const operation = useRef(false)
  const label = getClientKindLabel(clientKind)

  const load = useCallback(async () => {
    if (!mounted.current) return
    const request = ++revision.current
    setLoading(true)
    try {
      const [nextState, nextProviders] = await Promise.all([
        getApi().desktopConnection.state(clientKind),
        getApi().provider.list(),
      ])
      const nextKeys = (
        await Promise.all(nextProviders.map((provider) => getApi().apiKey.list(provider.id)))
      ).flat()
      if (request !== revision.current) return
      setState(nextState)
      setProviders(nextProviders)
      setKeys(nextKeys)
      setFailed(false)
    } catch {
      if (request === revision.current) setFailed(true)
    } finally {
      if (request === revision.current) setLoading(false)
    }
  }, [clientKind])

  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      confirmation.current?.destroy()
      revision.current += 1
    }
  }, [load])
  usePageRefresh(async () => {
    if (!operation.current) await load()
  })

  const applyResult = (next: DesktopOperationResult) => {
    if (!mounted.current) return
    setState(next.state)
    setResult(next)
    setFailed(false)
    if (next.completion === 'partial') throw new Error(t('desktopAccess.partial'))
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

  const apply = async ({ provider, apiKey }: RouteSelection) => {
    if (operation.current || !mounted.current) return
    operation.current = true
    ++revision.current
    setBusy(true)
    try {
      const next = await getApi().desktopConnection.apply(clientKind, provider.id, apiKey.id)
      if (!mounted.current) return
      // Contextual creation lives in the picker's resource overlay. Keep the
      // selected records so the persisted route can be named after it closes.
      setProviders((current) => [...current.filter((item) => item.id !== provider.id), provider])
      setKeys((current) => [...current.filter((item) => item.id !== apiKey.id), apiKey])
      applyResult(next)
    } catch (error) {
      await load()
      throw error
    } finally {
      operation.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const restore = () => {
    confirmation.current = modal.confirm({
      title: t('desktopAccess.restoreTitle', { client: label }),
      content: t('desktopAccess.restoreHint'),
      okText: t('desktopAccess.restore'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        if (operation.current || !mounted.current) return
        operation.current = true
        ++revision.current
        setBusy(true)
        try {
          applyResult(await getApi().desktopConnection.restore(clientKind))
        } catch (error) {
          if (mounted.current) message.error(t('desktopAccess.operationFailed'))
          await load()
          throw error
        } finally {
          operation.current = false
          if (mounted.current) setBusy(false)
        }
      },
    })
  }

  const status = failed ? 'unknown' : state?.status || 'unknown'
  const provider = providers.find((item) => item.id === state?.route?.providerId)
  const apiKey = keys.find((item) => item.id === state?.route?.apiKeyId)
  const changed = state?.lastConfigChange
  const canApply =
    !loading && !failed && !busy && ['official', 'taken_over', 'not_found'].includes(status)

  return (
    <div className={styles.panel} aria-busy={loading || busy}>
      <section className={styles.connection}>
        <div className={styles.identity}>
          <div className={styles.icon}>
            <ClientIcon kind={clientKind} size={28} />
          </div>
          <div>
            <h3>{label}</h3>
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
          </div>
          <Button
            className={styles.refresh}
            icon={<ReloadOutlined />}
            aria-label={t('common.refresh')}
            loading={loading}
            disabled={busy}
            onClick={() => void load()}
          />
        </div>
        {loading && !state ? (
          <Skeleton active paragraph={{ rows: 3 }} />
        ) : (
          <>
            <div className={styles.route}>
              <Text type='secondary'>{t('desktopAccess.currentRoute')}</Text>
              {state?.route ? (
                <div className={styles.routeIdentity}>
                  {provider && <ProviderIcon icon={provider.icon} name={provider.name} size={28} />}
                  <div>
                    <strong>{provider?.name || t('desktopAccess.resourceUnavailable')}</strong>
                    <p>
                      {apiKey?.alias ||
                        (apiKey
                          ? t('instances.unnamedKey')
                          : t('desktopAccess.resourceUnavailable'))}
                    </p>
                  </div>
                </div>
              ) : (
                <p>
                  {t(
                    status === 'official' ? 'desktopAccess.officialRoute' : 'desktopAccess.noRoute',
                  )}
                </p>
              )}
              {apiKey && (
                <Text type='secondary'>
                  {t('desktopAccess.models')}:{' '}
                  {getRouteModelLabel(apiKey, clientKind, t('keys.catalogProvider'))}
                </Text>
              )}
            </div>
            <Space wrap>
              <Button
                type='primary'
                icon={<SwapOutlined />}
                loading={busy}
                disabled={!canApply}
                onClick={() => setPickerOpen(true)}
              >
                {t(status === 'taken_over' ? 'desktopAccess.switch' : 'desktopAccess.connect')}
              </Button>
              <ConfigPreviewButton key={clientKind} clientKind={clientKind} />
              {status === 'taken_over' && (
                <Button danger disabled={busy || loading} onClick={restore}>
                  {t('desktopAccess.restore')}
                </Button>
              )}
            </Space>
          </>
        )}
      </section>
      <aside className={styles.guide}>
        <h3>{t('desktopAccess.boundaryTitle')}</h3>
        <p>{t('desktopAccess.boundaryHint')}</p>
        <p>{t('desktopAccess.routeHint')}</p>
        <p>{t('desktopAccess.noDetection')}</p>
      </aside>
      <div className={styles.feedback}>
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
            description={
              <>
                {state.syncFailure.source === 'key_edit' && (
                  <>
                    {t('desktopAccess.syncFailedHint')}
                    <br />
                  </>
                )}
                {state.syncFailure.message}
              </>
            }
          />
        )}
        {changed && (
          <section className={styles.notice}>
            <strong>{t('desktopAccess.lastConfigChange')}</strong>
            <Text type='secondary'>
              {new Date(changed.changedAt).toLocaleString(i18n.language)} ·{' '}
              {t(`desktopAccess.change.${changed.action}`)} ·{' '}
              {t(`desktopAccess.source.${changed.source}`)}
            </Text>
            <p>{t('desktopAccess.reopenHint', { client: label })}</p>
          </section>
        )}
      </div>
      <RoutePickerModal
        open={pickerOpen}
        clientKind={clientKind}
        providers={providers}
        apiKeys={keys}
        currentKeyId={state?.route?.apiKeyId}
        title={`${label} · ${t('desktopAccess.switch')}`}
        actionText={t(status === 'taken_over' ? 'desktopAccess.switch' : 'desktopAccess.connect')}
        onCancel={() => {
          if (!operation.current) setPickerOpen(false)
        }}
        onSelect={apply}
      />
    </div>
  )
}

export default function DesktopPage() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const clientKind: DesktopClientKind =
    params.get('client') === 'claude_desktop' ? 'claude_desktop' : 'codex'
  return (
    <div className={styles.container}>
      <PageHeader title={t('workspace.desktopAccess')} description={t('desktopAccess.subtitle')} />
      <div>
        <Segmented
          value={clientKind}
          onChange={(value) => {
            const next = new URLSearchParams(params)
            next.set('client', String(value))
            setParams(next)
          }}
          options={[
            { value: 'codex', label: 'Codex Desktop' },
            { value: 'claude_desktop', label: 'Claude Desktop' },
          ]}
        />
      </div>
      <DesktopClientPanel key={clientKind} clientKind={clientKind} />
    </div>
  )
}
