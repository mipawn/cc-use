import { useCallback, useEffect, useRef, useState } from 'react'
import { Form, Input, Modal, Select, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import type {
  ApiKey,
  ClientKind,
  CreateApiKeyInput,
  Provider,
  QuerySchemeInfo,
  QueryTestResult,
  UpdateApiKeyInput,
} from '@shared/types'
import { getApi } from '../../api'
import { useAppMessage } from '../../hooks/useAppMessage'
import { effectiveQuery, providerQuotaIsPerKey } from '../../utils/accountQuery'
import QuerySettingsSection, {
  type QueryScriptValue,
  type QuerySectionTestInput,
} from '../query/QuerySettingsSection'

const { Text } = Typography

const ALL_CLIENT_TYPES: ClientKind[] = ['claude_code', 'codex', 'claude_desktop', 'grok']

function recogniseScheme(script: string, schemes: QuerySchemeInfo[]): string {
  if (!script.trim()) return ''
  return schemes.find((scheme) => scheme.script === script)?.id ?? 'custom'
}

interface KeySimpleModalProps {
  open: boolean
  apiKey: ApiKey | null
  providers: Provider[]
  defaultProviderId?: string
  onClose: () => void
  onCreate: (input: CreateApiKeyInput) => Promise<ApiKey>
  onUpdate: (input: UpdateApiKeyInput) => Promise<ApiKey>
  onAfterSave?: (saved: ApiKey, previous?: ApiKey) => void
}

export default function KeySimpleModal({
  open,
  apiKey,
  providers,
  defaultProviderId,
  onClose,
  onCreate,
  onUpdate,
  onAfterSave,
}: KeySimpleModalProps) {
  const { t } = useTranslation()
  const message = useAppMessage()
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [providerId, setProviderId] = useState<string>('')
  const [queryValue, setQueryValue] = useState<QueryScriptValue>({
    enabled: false,
    schemeId: '',
    script: '',
  })
  const [queryError, setQueryError] = useState<string | null>(null)
  const [schemes, setSchemes] = useState<QuerySchemeInfo[]>([])
  const schemesRef = useRef<QuerySchemeInfo[]>([])
  const touchedRef = useRef(false)

  useEffect(() => {
    schemesRef.current = schemes
  }, [schemes])

  useEffect(() => {
    if (!open) return
    let alive = true
    void getApi()
      .balance.schemes('key')
      .then((list) => {
        if (alive) setSchemes(list)
      })
      .catch(() => {
        if (alive) setSchemes([])
      })
    return () => {
      alive = false
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const nextProviderId = apiKey?.providerId ?? defaultProviderId ?? providers[0]?.id ?? ''
    setProviderId(nextProviderId)
    setQueryError(null)
    touchedRef.current = false
    if (apiKey) {
      form.setFieldsValue({
        providerId: apiKey.providerId,
        alias: apiKey.alias ?? '',
        value: apiKey.value,
      })
      const script = apiKey.usageScript ?? ''
      const eff = effectiveQuery(apiKey.queryConfig, apiKey.usageScript)
      setQueryValue({
        enabled: eff?.enabled ?? false,
        schemeId: apiKey.queryConfig
          ? apiKey.queryConfig.schemeId
          : recogniseScheme(script, schemesRef.current),
        script,
      })
    } else {
      form.resetFields()
      form.setFieldsValue({ providerId: nextProviderId })
      const provider = providers.find((item) => item.id === nextProviderId)
      const defaultScript = provider?.defaultKeyConfig?.usageScript ?? ''
      setQueryValue({
        enabled: false,
        schemeId: recogniseScheme(defaultScript, schemesRef.current),
        script: defaultScript,
      })
    }
  }, [open, apiKey, defaultProviderId, providers, form])

  useEffect(() => {
    if (!open || !apiKey || apiKey.queryConfig || touchedRef.current) return
    const recognised = recogniseScheme(queryValue.script, schemes)
    if (recognised !== queryValue.schemeId) {
      setQueryValue((prev) => ({ ...prev, schemeId: recognised }))
    }
  }, [open, apiKey, queryValue.script, queryValue.schemeId, schemes])

  const selectedProvider = providers.find((item) => item.id === providerId)
  const keyScopeQuery = selectedProvider ? providerQuotaIsPerKey(selectedProvider) : false
  const draftKeyValue = Form.useWatch('value', form) as string | undefined

  const handleDraftTest = useCallback(
    async (input: QuerySectionTestInput): Promise<QueryTestResult> => {
      return getApi().balance.testDraft({
        scope: 'key',
        baseUrl: selectedProvider?.baseUrl ?? '',
        httpProxy: selectedProvider?.httpProxy ?? undefined,
        script: input.script,
        apiKey: (draftKeyValue ?? apiKey?.value ?? '').trim(),
      })
    },
    [selectedProvider?.baseUrl, selectedProvider?.httpProxy, draftKeyValue, apiKey?.value],
  )

  const handleOk = async () => {
    try {
      const values = await form.validateFields()
      setQueryError(null)
      const script = queryValue.script.trim()
      if (keyScopeQuery && queryValue.enabled) {
        if (!script) {
          setQueryError(t('keys.queryScriptRequired'))
          return
        }
        try {
          await getApi().balance.checkScript(script, selectedProvider?.baseUrl ?? '')
        } catch (err) {
          setQueryError(String(err))
          return
        }
      }

      setSaving(true)
      const alias = (values.alias as string | undefined)?.trim() || undefined
      const value = (values.value as string).trim()
      const usageFields = keyScopeQuery
        ? {
            usageType: script ? ('custom' as const) : ('none' as const),
            usageScript: apiKey ? script : script || undefined,
            queryConfig: {
              enabled: queryValue.enabled,
              schemeId: queryValue.schemeId || 'custom',
            },
          }
        : {}

      if (apiKey) {
        const saved = await onUpdate({
          id: apiKey.id,
          alias,
          value,
          ...usageFields,
        })
        message.success(t('apiKeys.keyUpdated'))
        onAfterSave?.(saved, apiKey)
      } else {
        const saved = await onCreate({
          providerId: values.providerId,
          alias,
          value,
          types: ALL_CLIENT_TYPES,
          ...usageFields,
        })
        message.success(t('apiKeys.keyAdded'))
        onAfterSave?.(saved)
      }
      onClose()
    } catch (error) {
      if (error && typeof error === 'object' && 'errorFields' in error) return
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      title={apiKey ? t('keysWorkspace.editKey') : t('keysWorkspace.addKey')}
      onCancel={() => {
        if (!saving) onClose()
      }}
      onOk={() => void handleOk()}
      confirmLoading={saving}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      width={560}
      destroyOnHidden
    >
      <Form form={form} layout='vertical'>
        <Form.Item
          name='providerId'
          label={t('gateway.provider')}
          rules={[{ required: true, message: t('profiles.providerRequired') }]}
        >
          <Select
            disabled={Boolean(apiKey || defaultProviderId)}
            options={providers.map((item) => ({ value: item.id, label: item.name }))}
            onChange={(nextId) => {
              setProviderId(nextId)
              const nextProvider = providers.find((item) => item.id === nextId)
              const defaultScript = nextProvider?.defaultKeyConfig?.usageScript ?? ''
              setQueryValue({
                enabled: false,
                schemeId: recogniseScheme(defaultScript, schemesRef.current),
                script: defaultScript,
              })
            }}
          />
        </Form.Item>

        <Form.Item name='alias' label={t('apiKeys.alias')}>
          <Input placeholder={t('apiKeys.aliasPlaceholder')} maxLength={64} />
        </Form.Item>

        <Form.Item
          name='value'
          label={t('apiKeys.apiKey')}
          rules={[{ required: true, message: t('apiKeys.enterApiKey') }]}
        >
          <Input.Password placeholder={t('apiKeys.apiKeyPlaceholder')} autoComplete='off' />
        </Form.Item>

        {keyScopeQuery && (
          <div style={{ marginTop: 12 }}>
            <QuerySettingsSection
              scope='key'
              value={queryValue}
              onChange={(next) => {
                touchedRef.current = true
                setQueryError(null)
                setQueryValue(next)
              }}
              testVisible={Boolean((draftKeyValue ?? apiKey?.value ?? '').trim())}
              onDraftTest={handleDraftTest}
            />
            {queryError && (
              <Text type='danger' style={{ display: 'block', marginTop: 6, fontSize: 12 }}>
                {queryError}
              </Text>
            )}
          </div>
        )}
      </Form>
    </Modal>
  )
}
