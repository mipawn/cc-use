/**
 * KeyEditModal - 密钥编辑弹窗
 * 统一新增和编辑体验
 * 各启动台独立模型配置，仅 Claude Code 提供局部配置
 */
import { useEffect, useMemo, useState } from 'react'
import { getApi } from '../../api'
import { Button, Modal, Form, Input, Typography, Space, Select, Tabs, Switch } from 'antd'
import { useAppMessage } from '../../hooks/useAppMessage'
import { DesktopOutlined, CodeOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import type {
  ApiKey,
  Provider,
  ClientKind,
  CliConfig,
  TerminalLaunchPreview,
  ClientConfig,
  UpstreamAuthScheme,
} from '@shared/types'
import { CLIENT_KIND_CONFIGS, getClientKindConfig } from '@shared/types'
import UserAgentField from '../UserAgentField'
import { useSettingsStore } from '../../stores/settingsStore'
import { newKeyDefaults, type ApiKeyEditorInput, type KeyEditMode } from '../../utils/apiKeyEditor'
import {
  modelMappingValueForSave,
  parseModelMapping,
  EMPTY_MODEL_MAPPING,
  validateModelMapping,
  type ModelMappingFields,
} from '../../utils/modelMapping'
import { isOfficialDeepSeekProvider } from '../../utils/officialProviders'
import { hasClientOverride, mergeClientConfig } from '../../utils/clientConfig'
import { STARTER_ACCOUNT_SCRIPT } from '../../utils/providerQueryDefaults'
import ModelMappingEditor from './ModelMappingEditor'
import { readClaudeConfig } from '../../utils/claudeConfig'
import type { ModelEditorActions } from './ModelEditorView'
import styles from './KeyEditModal.module.css'

const { Text } = Typography
const { TextArea } = Input

interface KeyEditModalProps {
  open: boolean
  /**
   * Explicit operation mode. `duplicate` reuses `apiKey` as the source draft
   * but saves a new record, so it must not be inferred from an empty id.
   */
  mode: KeyEditMode
  apiKey: ApiKey | null
  providers: Provider[]
  defaultProviderId?: string
  onClose: () => void
  onSave: (input: ApiKeyEditorInput) => Promise<void>
}

export default function KeyEditModal({
  open,
  mode,
  apiKey,
  providers,
  defaultProviderId,
  onClose,
  onSave,
}: KeyEditModalProps) {
  const { t } = useTranslation()
  const message = useAppMessage()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [editorActions, setEditorActions] = useState<ModelEditorActions | null>(null)
  const [hasPendingModelDraft, setHasPendingModelDraft] = useState(false)
  const watchedKeyValue = Form.useWatch('value', form)

  const [selectedTypes, setSelectedTypes] = useState<ClientKind[]>(['claude_code'])
  const [claudeConfigJson, setClaudeConfigJson] = useState('{}')
  const [launchPreview, setLaunchPreview] = useState<TerminalLaunchPreview | null>(null)
  const { globalSettings } = useSettingsStore()

  // This key's own quota query, and whether it runs. The script is filled in
  // from the start so its shape is visible; the switch is what decides, so a
  // query is never asked by accident because a field happened to have text.
  const [usageEnabled, setUsageEnabled] = useState(false)
  const [usageScript, setUsageScript] = useState(STARTER_ACCOUNT_SCRIPT)
  const [mapping, setMapping] = useState<ModelMappingFields>(EMPTY_MODEL_MAPPING)
  const [clientConfigs, setClientConfigs] = useState<Partial<Record<ClientKind, ClientConfig>>>({})
  const [activeTab, setActiveTab] = useState('usage')
  const [errorClientKind, setErrorClientKind] = useState<ClientKind>()
  const [retiredMapping, setRetiredMapping] = useState(false)
  const currentProvider = useMemo(() => {
    const pid = defaultProviderId || apiKey?.providerId
    return pid ? providers.find((p) => p.id === pid) : null
  }, [defaultProviderId, apiKey, providers])
  const isOfficialDeepSeek = isOfficialDeepSeekProvider(currentProvider)

  const getDefaultAuthSchemeLabel = (clientKind: ClientKind) =>
    clientKind === 'codex' || clientKind === 'grok' ? 'Authorization: Bearer' : 'x-api-key'

  const updateClientConfig = (clientKind: ClientKind, patch: Partial<ClientConfig>) => {
    setClientConfigs((prev) => mergeClientConfig(prev, clientKind, patch))
  }

  const claudeGlobalConfig = useMemo(
    () => globalSettings.claudeConfig || {},
    [globalSettings.claudeConfig],
  )
  const parseConfig = (json: string): CliConfig => readClaudeConfig(json).config

  useEffect(() => {
    if (!open) return

    // A copy starts from the source key's full configuration so the credential,
    // client overrides, model mapping and quota settings all carry over. Only a
    // plain create falls back to provider defaults; both save as a new record.
    const source = mode === 'create' ? null : apiKey

    if (source) {
      form.setFieldsValue({
        alias: source.alias || '',
        value: source.value,
      })
      const nextTypes = (source.types?.length ? source.types : ['claude_code']).map((type) =>
        type === 'claude' ? 'claude_code' : type,
      ) as ClientKind[]
      setSelectedTypes(isOfficialDeepSeek ? nextTypes.filter((type) => type !== 'grok') : nextTypes)
      const config = { ...(source.config || {}) }
      delete config.prelaunchCommand
      setClaudeConfigJson(JSON.stringify(config, null, 2))
    } else {
      // A new key inherits its provider's saved defaults, so filling in only
      // the key value still stores the endpoints, mapping and quota settings
      // the provider was configured with.
      const defaults = newKeyDefaults(currentProvider?.defaultKeyConfig, isOfficialDeepSeek)
      form.resetFields()
      form.setFieldsValue({ alias: '', value: '' })
      setSelectedTypes(
        isOfficialDeepSeek ? defaults.types.filter((type) => type !== 'grok') : defaults.types,
      )
      setClaudeConfigJson(defaults.claudeConfigJson)
      setUsageScript(defaults.usageScript)
      setUsageEnabled(false)
      setMapping(defaults.mapping)
      setClientConfigs(defaults.clientConfigs)
    }

    if (source) {
      setUsageScript(source.usageScript || STARTER_ACCOUNT_SCRIPT)
      setUsageEnabled(Boolean(source.usageScript?.trim()))
      setMapping(parseModelMapping(source.modelMapping))
      setClientConfigs(source.clientConfigs || {})
    }

    // A copy exists to be re-pointed at another model mapping, so start there.
    setActiveTab(mode === 'duplicate' ? 'modelMapping' : 'usage')
    setErrorClientKind(undefined)
    setEditorActions(null)
    setHasPendingModelDraft(false)
    // `currentProvider` carries the saved key defaults a create inherits, so a
    // provider swap has to re-seed the draft.
  }, [open, mode, apiKey, form, isOfficialDeepSeek, currentProvider])

  useEffect(() => {
    if (!open || !apiKey?.id || !selectedTypes.includes('claude_code')) {
      setLaunchPreview(null)
      return
    }

    const providerId = defaultProviderId || apiKey.providerId
    getApi()
      .terminal.getLaunchPreview({
        providerId,
        apiKeyId: apiKey.id,
        cliType: 'claude_code',
      })
      .then(setLaunchPreview)
      .catch(() => setLaunchPreview(null))
  }, [open, apiKey, defaultProviderId, selectedTypes])

  useEffect(() => {
    let active = true
    setRetiredMapping(false)
    if (open && apiKey?.id) {
      getApi()
        .apiKey.retiredMappingReport()
        .then((ids) => {
          if (active) setRetiredMapping(ids.includes(apiKey.id))
        })
        .catch(() => {})
    }
    return () => {
      active = false
    }
  }, [open, apiKey?.id])

  const handleTypesChange = (types: ClientKind[]) => {
    if (types.length === 0) {
      message.warning(t('apiKeys.selectAtLeastOne') || '至少选择一种类型')
      return
    }
    setSelectedTypes(types)
  }

  const handleSubmit = async () => {
    try {
      setLoading(true)
      const values = await form.validateFields()

      const providerId = defaultProviderId || apiKey?.providerId || providers[0]?.id
      if (!providerId) {
        message.error(t('apiKeys.noProvider') || '请先添加供应商')
        return
      }

      if (selectedTypes.includes('claude_code') && !readClaudeConfig(claudeConfigJson).valid) {
        setActiveTab('modelMapping')
        setErrorClientKind('claude_code')
        message.error(t('keys.processModelsInvalidConfig'))
        return
      }
      const invalidEnvNames = selectedTypes.includes('claude_code')
        ? Object.keys(parseConfig(claudeConfigJson)).filter(
            (key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
          )
        : []
      if (invalidEnvNames.length) {
        setActiveTab('modelMapping')
        setErrorClientKind('claude_code')
        message.error(t('keys.invalidEnvNames', { fields: invalidEnvNames.join(', ') }))
        return
      }
      const nativeFields = selectedTypes.includes('claude_code')
        ? ['modelPicker', 'modelOverrides', 'availableModels'].filter(
            (key) => key in parseConfig(claudeConfigJson),
          )
        : []
      if (nativeFields.length) {
        setActiveTab('modelMapping')
        setErrorClientKind('claude_code')
        message.error(t('keys.nativeSettingsUnsupported', { fields: nativeFields.join(', ') }))
        return
      }
      const localConfig = selectedTypes.includes('claude_code')
        ? parseConfig(claudeConfigJson)
        : undefined
      if (localConfig) {
        delete localConfig.prelaunchCommand
      }
      const mappingError = validateModelMapping(mapping, selectedTypes)
      if (mappingError) {
        setActiveTab('modelMapping')
        setErrorClientKind(mappingError.clientKind)
        message.error(
          `${getClientKindConfig(mappingError.clientKind).label}: ${t(`keys.${mappingError.key}`)}`,
        )
        return
      }
      const codeModel = localConfig?.ANTHROPIC_MODEL
      if (
        selectedTypes.includes('claude_code') &&
        mapping.clients.claude_code.catalogMode === 'custom' &&
        typeof codeModel === 'string' &&
        codeModel &&
        !['haiku', 'sonnet', 'opus'].includes(codeModel) &&
        !mapping.clients.claude_code.models.some((model) => model.id === codeModel)
      ) {
        setActiveTab('modelMapping')
        setErrorClientKind('claude_code')
        message.error(t('keys.clientDefaultInvalid'))
        return
      }
      // Evaluated before saving, so a typo is caught here rather than on the
      // next refresh. Nothing is sent and no credential is involved.
      const keyScript = usageEnabled ? usageScript.trim() : ''
      if (usageEnabled && !keyScript) {
        message.error(t('keys.queryScriptRequired'))
        return
      }
      if (keyScript) {
        try {
          await getApi().balance.checkScript(keyScript, currentProvider?.baseUrl ?? '')
        } catch (error) {
          message.error(String(error))
          return
        }
      }

      const serializedModelMapping = modelMappingValueForSave(mapping, mode !== 'create')
      await onSave({
        id: mode === 'edit' ? apiKey?.id : undefined,
        mode,
        providerId,
        alias: values.alias?.trim() || undefined,
        value: values.value?.trim(),
        types: selectedTypes,
        config: localConfig,
        usageScript: mode === 'edit' ? keyScript : keyScript || undefined,
        modelMapping: serializedModelMapping,
        clientConfigs,
      })

      message.success(
        mode === 'edit'
          ? t('apiKeys.keyUpdated') || '密钥已更新'
          : t('apiKeys.keyAdded') || '密钥已添加',
      )
      onClose()
    } catch (error) {
      if (error instanceof Error) {
        message.error(error.message)
      }
    } finally {
      setLoading(false)
    }
  }

  const modalTitle = useMemo(() => {
    const baseTitle =
      mode === 'edit'
        ? t('apiKeys.editKey') || '编辑密钥'
        : mode === 'duplicate'
          ? t('apiKeys.duplicateKey') || '复制密钥'
          : t('apiKeys.addKey') || '添加密钥'
    return currentProvider ? `${baseTitle} - ${currentProvider.name}` : baseTitle
  }, [mode, currentProvider, t])

  const previewJson = useMemo(() => {
    const local = parseConfig(claudeConfigJson)
    const merged = { ...claudeGlobalConfig, ...local }
    const env: Record<string, string> = { ...(launchPreview?.env ?? {}) }
    const protectedKeys = new Set([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'prelaunchCommand',
      'modelPicker',
      'modelOverrides',
      'availableModels',
    ])
    for (const key of new Set([
      ...Object.keys(apiKey?.config ?? {}),
      ...Object.keys(claudeGlobalConfig),
      ...Object.keys(local),
    ])) {
      if (protectedKeys.has(key)) continue
      const value = merged[key]
      if (value === undefined || value === null) delete env[key]
      else env[key] = typeof value === 'string' ? value : JSON.stringify(value)
    }
    for (const [key, fallback] of Object.entries({
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    })) {
      if (key === 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY' ? !(key in merged) : !(key in env))
        env[key] = fallback
    }
    env.ANTHROPIC_BASE_URL =
      launchPreview?.env.ANTHROPIC_BASE_URL ??
      `http://localhost:${globalSettings.proxyPort ?? 12345}`
    env.ANTHROPIC_AUTH_TOKEN =
      launchPreview?.env.ANTHROPIC_AUTH_TOKEN ?? t('keys.generatedAtLaunch')
    delete env.ANTHROPIC_API_KEY
    for (const key of ['modelPicker', 'modelOverrides', 'availableModels']) delete env[key]
    return JSON.stringify({ ...env, __command: launchPreview?.command ?? 'claude' }, null, 2)
  }, [
    launchPreview,
    claudeConfigJson,
    claudeGlobalConfig,
    globalSettings.proxyPort,
    apiKey?.config,
    t,
  ])

  return (
    <Modal
      title={modalTitle}
      open={open}
      onCancel={onClose}
      onOk={handleSubmit}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={loading}
      okButtonProps={{ disabled: hasPendingModelDraft }}
      footer={
        activeTab === 'modelMapping' && editorActions ? (
          editorActions.confirm ? <>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button type='primary' onClick={editorActions.confirm}>
              {editorActions.confirmText}
            </Button>
          </> : null
        ) : undefined
      }
      width={960}
      destroyOnHidden
      className={styles.modal}
    >
      <SimpleBar className={styles.scrollContainer}>
        <Form form={form} layout='vertical' className={styles.form}>
          <div className={styles.identityPane}>
            <Form.Item
              label={t('apiKeys.keyType') || '适用客户端'}
              required
              className={styles.clientSelector}
              extra={t('apiKeys.clientScopeHint') || '选择这把密钥可以用于哪些客户端'}
            >
              <Select
                mode='multiple'
                value={selectedTypes}
                onChange={(values) => handleTypesChange(values as ClientKind[])}
                options={CLIENT_KIND_CONFIGS.filter(
                  (client) => !isOfficialDeepSeek || client.kind !== 'grok',
                ).map((client) => ({
                  value: client.kind,
                  label: client.label,
                }))}
                optionRender={(option) => {
                  const client = getClientKindConfig(option.value as ClientKind)
                  return (
                    <div className={styles.clientOption}>
                      <Space size={8}>
                        {client.form === 'process_injection' ? (
                          <CodeOutlined />
                        ) : (
                          <DesktopOutlined />
                        )}
                        <span>{client.label}</span>
                      </Space>
                      <Text type='secondary' className={styles.clientOptionMeta}>
                        {client.form === 'process_injection'
                          ? t('launchpad.processInjection') || '进程级'
                          : t('launchpad.configTakeover') || '配置级'}
                      </Text>
                    </div>
                  )
                }}
                maxTagCount={2}
                maxTagPlaceholder={(omitted) => `+${omitted.length}`}
                placeholder={t('apiKeys.selectClients') || '选择适用客户端'}
                className={styles.clientSelect}
                size='middle'
              />
            </Form.Item>

            {/* The everyday form is the key value and its alias; everything
              else is reachable in one click without a second dialog. */}
            <Form.Item name='alias' label={t('apiKeys.keyName') || '密钥别名'}>
              <Input
                placeholder={t('apiKeys.keyNamePlaceholder') || '例如：主密钥、备用密钥'}
                size='large'
              />
            </Form.Item>

            <Form.Item
              name='value'
              label={t('apiKeys.apiKey') || 'API 密钥'}
              rules={[{ required: true, message: t('apiKeys.enterApiKey') || '请输入 API 密钥' }]}
            >
              <Input.Password
                placeholder={t('apiKeys.apiKeyPlaceholder') || 'sk-xxx...'}
                size='large'
              />
            </Form.Item>
          </div>
          <div className={styles.configurationPane}>
            {retiredMapping && (
              <Text type='warning' className={styles.hintLine}>
                {t('keys.retiredMappingNotice')}
              </Text>
            )}
          {hasPendingModelDraft && activeTab !== 'modelMapping' && <div className={styles.hintLine}><Text type='warning'>{t('keys.pendingModelDraft')}</Text><Button type='link' size='small' onClick={() => setActiveTab('modelMapping')}>{t('keys.backToModels')}</Button></div>}
          <Tabs
              activeKey={activeTab}
              onChange={(key) => {
                editorActions?.back()
                setActiveTab(key)
              }}
              destroyOnHidden={false}
              className={styles.tabs}
              items={[
                {
                  key: 'usage',
                  label: t('keys.usageConfig') || '额度查询配置',
                  children: (
                    <div className={styles.tabPane}>
                      <div className={styles.usageSwitchRow}>
                        <Switch
                          checked={usageEnabled}
                          onChange={setUsageEnabled}
                          aria-label={t('keys.usageEnabled') || '查询这把密钥的额度'}
                        />
                        <Text>{t('keys.usageEnabled') || '查询这把密钥的额度'}</Text>
                      </div>
                      <TextArea
                        value={usageScript}
                        onChange={(event) => setUsageScript(event.target.value)}
                        disabled={!usageEnabled}
                        autoSize={{ minRows: 8, maxRows: 20 }}
                        spellCheck={false}
                        className={styles.jsonEditor}
                      />
                      <Text
                        type='secondary'
                        style={{ fontSize: 12, display: 'block', marginTop: 8 }}
                      >
                        {t('keys.usageScriptHint') ||
                          '脚本与供应商的账户查询同构：{{baseUrl}} 供应商地址，{{apiKey}} 这把密钥'}
                      </Text>
                    </div>
                  ),
                },
                {
                  key: 'modelMapping',
                  label: t('keys.modelConfiguration'),
                  children: (
                    <ModelMappingEditor
                      types={selectedTypes}
                      value={mapping}
                      onChange={setMapping}
                      claudeConfigJson={claudeConfigJson}
                      onClaudeConfigChange={setClaudeConfigJson}
                      globalClaudeConfig={claudeGlobalConfig}
                      previewJson={previewJson}
                      providerId={currentProvider?.id}
                      apiKeyId={mode === 'edit' ? apiKey?.id : undefined}
                      errorClientKind={errorClientKind}
                      draftKeyValue={
                        typeof watchedKeyValue === 'string'
                          ? watchedKeyValue
                          : (apiKey?.value ?? '')
                      }
                      clientConfigs={clientConfigs}
                      onEditorActionsChange={setEditorActions}
                      onPendingDraftChange={setHasPendingModelDraft}
                    />
                  ),
                },
                {
                  key: 'clientConfigs',
                  label: t('keys.connectionConfig'),
                  children: (
                    <div className={styles.tabPane}>
                      <Text type='secondary' className={styles.hintLine}>
                        {t('keys.connectionConfigHint')}
                      </Text>
                      {/* One row per client, its two controls side by side: a
                          stacked pair per client reads as four unrelated
                          fields rather than two settings for one client. */}
                      <div className={styles.clientList}>
                        {selectedTypes.map((clientKind) => {
                          const config = getClientKindConfig(clientKind)
                          const currentValue = clientConfigs[clientKind]?.baseUrl || ''
                          const currentAuthScheme = clientConfigs[clientKind]?.authScheme
                          const currentUserAgent = clientConfigs[clientKind]?.proxyUserAgent || ''
                          const isOverridden = hasClientOverride(clientConfigs[clientKind])
                          return (
                            <div className={styles.clientRow} key={clientKind}>
                              <div className={styles.clientRowHead}>
                                <Text strong>{config.label}</Text>
                                {isOverridden && (
                                  <Text type='secondary' className={styles.clientRowBadge}>
                                    {t('keys.configOverride')}
                                  </Text>
                                )}
                              </div>
                              <div className={styles.clientRowFields}>
                                <Form.Item
                                  label='Base URL'
                                  extra={t('keys.connectionDefault', {
                                    value: currentProvider?.baseUrl || t('keys.connectionUnset'),
                                  })}
                                  style={{ marginBottom: 0 }}
                                >
                                  <Input
                                    value={currentValue}
                                    onChange={(event) =>
                                      updateClientConfig(clientKind, {
                                        baseUrl: event.target.value.trim(),
                                      })
                                    }
                                    placeholder={
                                      currentProvider?.baseUrl || 'https://api.example.com/v1'
                                    }
                                  />
                                </Form.Item>
                                <Form.Item
                                  label={t('keys.connectionAuth')}
                                  extra={t('keys.connectionDefault', {
                                    value: getDefaultAuthSchemeLabel(clientKind),
                                  })}
                                  style={{ marginBottom: 0 }}
                                >
                                  <Select
                                    value={currentAuthScheme || 'default'}
                                    onChange={(value: 'default' | UpstreamAuthScheme) => {
                                      updateClientConfig(clientKind, {
                                        authScheme: value === 'default' ? undefined : value,
                                      })
                                    }}
                                    options={[
                                      { label: t('keys.connectionUseDefault'), value: 'default' },
                                      { label: 'x-api-key', value: 'x-api-key' },
                                      { label: 'Authorization: Bearer', value: 'bearer' },
                                      { label: t('keys.connectionNoAuth'), value: 'none' },
                                    ]}
                                  />
                                </Form.Item>
                              </div>
                              {/* Chosen identity. Unlike the two fields above,
                                  this one replaces what the client sent rather
                                  than deferring to it. */}
                              <Form.Item
                                label={t('keys.proxyUserAgent') || '转发 User-Agent'}
                                extra={
                                  t('keys.proxyUserAgentHint') ||
                                  '留空保留客户端原值；选定后覆盖，即使请求来自真实 CLI'
                                }
                                style={{ marginBottom: 0, marginTop: 12 }}
                              >
                                <UserAgentField
                                  value={currentUserAgent || ''}
                                  placeholder={t('keys.proxyUserAgentDefault')}
                                  onChange={(value) =>
                                    updateClientConfig(clientKind, {
                                      proxyUserAgent: value || undefined,
                                    })
                                  }
                                />
                              </Form.Item>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ),
                },
              ]}
            />
          </div>
        </Form>
      </SimpleBar>
    </Modal>
  )
}
