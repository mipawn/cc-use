/**
 * KeyEditModal - 密钥编辑弹窗
 * 统一新增和编辑体验
 * 支持多选类型，当前仅持久化一份局部配置
 */
import { useEffect, useMemo, useState } from 'react'
import { getApi } from '../../api'
import {
  Modal,
  Form,
  Input,
  Typography,
  Space,
  Segmented,
  theme,
  Tooltip,
  Select,
  Tabs,
  Button,
  Switch,
} from 'antd'
import { useAppMessage } from '../../hooks/useAppMessage'
import {
  SettingOutlined,
  CopyOutlined,
  CheckOutlined,
  DesktopOutlined,
  CodeOutlined,
  DeleteOutlined,
  PlusOutlined,
  DownOutlined,
  RightOutlined,
} from '@ant-design/icons'
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
import { useSettingsStore } from '../../stores/settingsStore'
import { newKeyDefaults, type ApiKeyEditorInput, type KeyEditMode } from '../../utils/apiKeyEditor'
import {
  modelMappingValueForSave,
  parseModelMapping,
  type ExactModelMapping,
  type ModelMappingFields,
} from '../../utils/modelMapping'
import { isOfficialDeepSeekProvider } from '../../utils/officialProviders'
import { STARTER_ACCOUNT_SCRIPT } from '../../utils/providerQueryDefaults'
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

type ModelOverrideRow = ExactModelMapping & { id: number }

let nextModelOverrideRowId = 1

const createModelOverrideRow = (entry: ExactModelMapping = { source: '', target: '' }) => ({
  ...entry,
  id: nextModelOverrideRowId++,
})

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
  const { token } = theme.useToken()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const [selectedTypes, setSelectedTypes] = useState<ClientKind[]>(['claude_code'])
  const [claudeConfigJson, setClaudeConfigJson] = useState('{}')
  const [configMode, setConfigMode] = useState<'preview' | 'edit'>('preview')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [configCopied, setConfigCopied] = useState(false)
  const [launchPreview, setLaunchPreview] = useState<TerminalLaunchPreview | null>(null)
  const { globalSettings } = useSettingsStore()

  // This key's own quota query, and whether it runs. The script is filled in
  // from the start so its shape is visible; the switch is what decides, so a
  // query is never asked by accident because a field happened to have text.
  const [usageEnabled, setUsageEnabled] = useState(false)
  const [usageScript, setUsageScript] = useState(STARTER_ACCOUNT_SCRIPT)
  const [haikuModel, setHaikuModel] = useState('')
  const [sonnetModel, setSonnetModel] = useState('')
  const [opusModel, setOpusModel] = useState('')
  const [autoMode, setAutoMode] = useState<ModelMappingFields['autoMode']>({
    enabled: false,
    model: '',
    thinking: 'low',
  })
  const [modelOverrides, setModelOverrides] = useState<ModelOverrideRow[]>([])
  const [codexModel, setCodexModel] = useState('')
  const [grokModel, setGrokModel] = useState('')
  const [clientConfigs, setClientConfigs] = useState<Partial<Record<ClientKind, ClientConfig>>>({})
  const [activeTab, setActiveTab] = useState('usage')
  // A copy is opened to be re-pointed at another model mapping, so it starts
  // with the advanced section expanded; a plain create starts minimal.
  const [advancedOpen, setAdvancedOpen] = useState(mode === 'duplicate')

  const currentProvider = useMemo(() => {
    const pid = defaultProviderId || apiKey?.providerId
    return pid ? providers.find((p) => p.id === pid) : null
  }, [defaultProviderId, apiKey, providers])
  const isOfficialDeepSeek = isOfficialDeepSeekProvider(currentProvider)

  const getDefaultAuthSchemeLabel = (clientKind: ClientKind) =>
    clientKind === 'codex' || clientKind === 'grok' ? 'Authorization: Bearer' : 'x-api-key'

  const updateClientConfig = (clientKind: ClientKind, patch: Partial<ClientConfig>) => {
    setClientConfigs((prev) => {
      const next = { ...prev }
      const merged: ClientConfig = { ...(next[clientKind] || {}), ...patch }

      if (!merged.baseUrl?.trim()) delete merged.baseUrl
      if (!merged.authScheme) delete merged.authScheme

      if (!merged.baseUrl && !merged.authScheme) {
        delete next[clientKind]
      } else {
        next[clientKind] = merged
      }

      return next
    })
  }

  const claudeGlobalConfig = useMemo(
    () => globalSettings.claudeConfig || {},
    [globalSettings.claudeConfig],
  )
  const parseConfig = (json: string): CliConfig => {
    try {
      return JSON.parse(json) as CliConfig
    } catch {
      return {}
    }
  }

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
      setHaikuModel(defaults.mapping.haiku)
      setSonnetModel(defaults.mapping.sonnet)
      setOpusModel(defaults.mapping.opus)
      setAutoMode(defaults.mapping.autoMode)
      setModelOverrides(defaults.mapping.modelOverrides.map(createModelOverrideRow))
      setCodexModel(defaults.mapping.codex)
      setGrokModel(defaults.mapping.grok)
      setClientConfigs(defaults.clientConfigs)
    }
    setConfigMode('preview')

    if (source) {
      setUsageScript(source.usageScript || STARTER_ACCOUNT_SCRIPT)
      setUsageEnabled(Boolean(source.usageScript?.trim()))
      const mapping = parseModelMapping(source.modelMapping)
      setHaikuModel(mapping.haiku)
      setSonnetModel(mapping.sonnet)
      setOpusModel(mapping.opus)
      setAutoMode(mapping.autoMode)
      setModelOverrides(mapping.modelOverrides.map(createModelOverrideRow))
      setCodexModel(mapping.codex)
      setGrokModel(mapping.grok)
      setClientConfigs(source.clientConfigs || {})
    }

    // A copy exists to be re-pointed at another model mapping, so start there.
    setActiveTab(mode === 'duplicate' ? 'modelMapping' : 'usage')
    setJsonError(null)
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

  const handleTypesChange = (types: ClientKind[]) => {
    if (types.length === 0) {
      message.warning(t('apiKeys.selectAtLeastOne') || '至少选择一种类型')
      return
    }
    setSelectedTypes(types)
  }

  const buildModelMappingJson = (): string | undefined => {
    return modelMappingValueForSave(
      {
        haiku: haikuModel,
        sonnet: sonnetModel,
        opus: opusModel,
        autoMode,
        modelOverrides,
        codex: codexModel,
        grok: grokModel,
      },
      mode !== 'create',
    )
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

      try {
        if (selectedTypes.includes('claude_code')) JSON.parse(claudeConfigJson)
      } catch {
        setJsonError('JSON 格式错误')
        message.error('JSON 格式错误')
        return
      }

      const localConfig = selectedTypes.includes('claude_code')
        ? parseConfig(claudeConfigJson)
        : undefined
      if (localConfig) {
        delete localConfig.prelaunchCommand
      }
      const incompleteOverride = modelOverrides.some(
        ({ source, target }) => Boolean(source.trim()) !== Boolean(target.trim()),
      )
      if (incompleteOverride) {
        message.error(t('keys.modelOverrideIncomplete') || '精确映射的原模型和上游模型必须同时填写')
        return
      }
      const overrideSources = modelOverrides.map(({ source }) => source.trim()).filter(Boolean)
      if (new Set(overrideSources).size !== overrideSources.length) {
        message.error(t('keys.modelOverrideDuplicate') || '精确映射的原模型不能重复')
        return
      }
      // Evaluated before saving, so a typo is caught here rather than on the
      // next refresh. Nothing is sent and no credential is involved.
      const keyScript = usageEnabled ? usageScript.trim() : ''
      if (keyScript) {
        try {
          await getApi().balance.checkScript(keyScript, currentProvider?.baseUrl ?? '')
        } catch (error) {
          message.error(String(error))
          return
        }
      }

      const serializedModelMapping = buildModelMappingJson()
      await onSave({
        id: mode === 'edit' ? apiKey?.id : undefined,
        mode,
        providerId,
        alias: values.alias?.trim() || undefined,
        value: values.value?.trim(),
        types: selectedTypes,
        config: localConfig,
        usageScript: keyScript || undefined,
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

  const mergedConfigJson = useMemo(
    () => JSON.stringify({ ...claudeGlobalConfig, ...parseConfig(claudeConfigJson) }, null, 2),
    [claudeGlobalConfig, claudeConfigJson],
  )

  const previewJson = useMemo(() => {
    if (launchPreview) {
      return JSON.stringify(
        {
          ...launchPreview.env,
          __command: launchPreview.command,
        },
        null,
        2,
      )
    }
    return mergedConfigJson
  }, [launchPreview, mergedConfigJson])

  const handleCopyConfig = async () => {
    try {
      await navigator.clipboard.writeText(configMode === 'preview' ? previewJson : claudeConfigJson)
      setConfigCopied(true)
      setTimeout(() => setConfigCopied(false), 2000)
      message.success(t('common.copied') || '已复制')
    } catch {
      message.error(t('messages.error') || '复制失败')
    }
  }

  return (
    <Modal
      title={modalTitle}
      open={open}
      onCancel={onClose}
      onOk={handleSubmit}
      okText={t('common.confirm')}
      cancelText={t('common.cancel')}
      confirmLoading={loading}
      width={600}
      destroyOnHidden
      className={styles.modal}
    >
      <SimpleBar className={styles.scrollContainer}>
        <Form form={form} layout='vertical' className={styles.form}>
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
                      {client.form === 'process_injection' ? <CodeOutlined /> : <DesktopOutlined />}
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
              size='large'
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

          <div className={styles.defaultsSummary}>
            <Text type='secondary' style={{ fontSize: 12 }}>
              {t('keys.defaultsSummary', {
                clients: selectedTypes.length,
                models: haikuModel || sonnetModel || opusModel ? 1 : 0,
              }) || '默认配置来自供应商，可展开高级设置修改'}
            </Text>
          </div>

          <Button
            type='link'
            size='small'
            className={styles.advancedToggle}
            onClick={() => setAdvancedOpen((open) => !open)}
            icon={advancedOpen ? <DownOutlined /> : <RightOutlined />}
          >
            {t('keys.advancedSettings') || '高级设置'}
          </Button>

          {/* Kept mounted while collapsed: their values live in component
              state, and an unmounted pane would still save correctly but could
              not report a field error in place. */}
          <div style={{ display: advancedOpen ? undefined : 'none' }}>
            <Tabs
              activeKey={activeTab}
              onChange={setActiveTab}
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
                  label: '模型映射',
                  children: (
                    <div className={styles.tabPane}>
                      <Text
                        type='secondary'
                        style={{ marginBottom: 12, display: 'block', fontSize: 12 }}
                      >
                        {t('keys.modelMappingHint') || '只改写实际发送给上游的模型名称'}
                      </Text>
                      {selectedTypes.some(
                        (type) => type === 'claude_code' || type === 'claude_desktop',
                      ) && (
                        <>
                          <Text strong style={{ marginBottom: 12, display: 'block' }}>
                            Claude
                          </Text>
                          <div className={styles.familyMappingGrid}>
                            <Form.Item
                              label='Haiku'
                              extra={t('keys.modelMapHaikuExtra') || '包含 haiku 的模型 →'}
                            >
                              <Input
                                value={haikuModel}
                                onChange={(e) => setHaikuModel(e.target.value)}
                                placeholder='claude-haiku-4-5'
                              />
                            </Form.Item>
                            <Form.Item
                              label='Sonnet'
                              extra={t('keys.modelMapSonnetExtra') || '包含 sonnet 的模型 →'}
                            >
                              <Input
                                value={sonnetModel}
                                onChange={(e) => setSonnetModel(e.target.value)}
                                placeholder='claude-sonnet-4-5'
                              />
                            </Form.Item>
                            <Form.Item
                              label='Opus'
                              extra={t('keys.modelMapOpusExtra') || '包含 opus 的模型 →'}
                            >
                              <Input
                                value={opusModel}
                                onChange={(e) => setOpusModel(e.target.value)}
                                placeholder='claude-opus-4-7'
                              />
                            </Form.Item>
                          </div>
                          <Form.Item label={t('keys.autoMode')} extra={t('keys.autoModeHint')}>
                            <Switch
                              checked={autoMode.enabled}
                              onChange={(enabled) =>
                                setAutoMode((current) => ({ ...current, enabled }))
                              }
                              aria-label={t('keys.autoMode')}
                            />
                          </Form.Item>
                          {autoMode.enabled && (
                            <>
                              <Form.Item
                                label={t('keys.autoModeModel')}
                                extra={t('keys.autoModeModelHint')}
                              >
                                <Input
                                  value={autoMode.model}
                                  onChange={(event) =>
                                    setAutoMode((current) => ({
                                      ...current,
                                      model: event.target.value,
                                    }))
                                  }
                                  placeholder={t('keys.autoModeModelPlaceholder')}
                                  aria-label={t('keys.autoModeModel')}
                                />
                              </Form.Item>
                              <Form.Item
                                label={t('keys.autoModeThinking')}
                                extra={t('keys.autoModeThinkingHint')}
                              >
                                <Select
                                  value={autoMode.thinking}
                                  onChange={(
                                    thinking: ModelMappingFields['autoMode']['thinking'],
                                  ) => setAutoMode((current) => ({ ...current, thinking }))}
                                  aria-label={t('keys.autoModeThinking')}
                                  options={[
                                    { value: 'low', label: t('keys.autoModeThinkingLow') },
                                    {
                                      value: 'disabled',
                                      label: t('keys.autoModeThinkingDisabled'),
                                    },
                                    {
                                      value: 'preserve',
                                      label: t('keys.autoModeThinkingPreserve'),
                                    },
                                  ]}
                                />
                              </Form.Item>
                            </>
                          )}
                          <div className={styles.exactMappingSection}>
                            <div className={styles.exactMappingHeader}>
                              <div>
                                <Text strong>{t('keys.modelOverrides') || '精确映射（高级）'}</Text>
                                <Text type='secondary' className={styles.exactMappingHint}>
                                  {t('keys.modelOverridesHint') ||
                                    '具体模型优先于上方家族映射；全部未命中时保持原模型'}
                                </Text>
                              </div>
                              <Button
                                type='dashed'
                                size='small'
                                icon={<PlusOutlined />}
                                onClick={() =>
                                  setModelOverrides((current) => [
                                    ...current,
                                    createModelOverrideRow(),
                                  ])
                                }
                              >
                                {t('keys.modelOverrideAdd') || '添加'}
                              </Button>
                            </div>
                            {modelOverrides.length === 0 ? (
                              <Text type='secondary' className={styles.exactMappingEmpty}>
                                {t('keys.modelOverridesEmpty') || '暂无精确映射'}
                              </Text>
                            ) : (
                              <div className={styles.exactMappingList}>
                                {modelOverrides.map((entry) => (
                                  <div className={styles.exactMappingRow} key={entry.id}>
                                    <Input
                                      value={entry.source}
                                      onChange={(event) =>
                                        setModelOverrides((current) =>
                                          current.map((item) =>
                                            item.id === entry.id
                                              ? { ...item, source: event.target.value }
                                              : item,
                                          ),
                                        )
                                      }
                                      placeholder={
                                        t('keys.modelOverrideSourcePlaceholder') ||
                                        '原模型，如 claude-opus-4-8'
                                      }
                                      aria-label={t('keys.modelOverrideSource') || '原模型'}
                                    />
                                    <span className={styles.mappingArrow}>→</span>
                                    <Input
                                      value={entry.target}
                                      onChange={(event) =>
                                        setModelOverrides((current) =>
                                          current.map((item) =>
                                            item.id === entry.id
                                              ? { ...item, target: event.target.value }
                                              : item,
                                          ),
                                        )
                                      }
                                      placeholder={
                                        t('keys.modelOverrideTargetPlaceholder') ||
                                        '上游模型，如 claude-opus-4-6'
                                      }
                                      aria-label={t('keys.modelOverrideTarget') || '上游模型'}
                                    />
                                    <Button
                                      type='text'
                                      danger
                                      icon={<DeleteOutlined />}
                                      aria-label={t('common.delete') || '删除'}
                                      onClick={() =>
                                        setModelOverrides((current) =>
                                          current.filter((item) => item.id !== entry.id),
                                        )
                                      }
                                    />
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </>
                      )}
                      {selectedTypes.includes('codex') && (
                        <div>
                          <Text strong style={{ marginBottom: 12, display: 'block' }}>
                            Codex Desktop
                          </Text>
                          <Form.Item
                            label={t('keys.modelMapCodex') || '上游模型'}
                            extra={
                              t('keys.modelMapCodexExtra') ||
                              '留空时使用 Codex 里选择的模型；填写后只替换请求中的模型名称，不转换 Responses 协议'
                            }
                          >
                            <Input
                              value={codexModel}
                              onChange={(e) => setCodexModel(e.target.value)}
                              placeholder={t('keys.modelMapCodexPlaceholder') || '默认跟随客户端'}
                            />
                          </Form.Item>
                        </div>
                      )}
                      {selectedTypes.includes('grok') && (
                        <div>
                          <Text strong style={{ marginBottom: 12, display: 'block' }}>
                            Grok Build
                          </Text>
                          <Form.Item
                            label={t('keys.modelMapGrok') || '上游模型'}
                            extra={
                              t('keys.modelMapGrokExtra') ||
                              '留空时使用 Grok Build 自己请求的模型；填写后只替换请求中的模型名称'
                            }
                          >
                            <Input
                              value={grokModel}
                              onChange={(e) => setGrokModel(e.target.value)}
                              placeholder={t('keys.modelMapGrokPlaceholder') || '默认跟随客户端'}
                            />
                          </Form.Item>
                        </div>
                      )}
                    </div>
                  ),
                },
                ...(selectedTypes.includes('claude_code')
                  ? [
                      {
                        key: 'claudeConfig',
                        label: '局部配置',
                        children: (
                          <div className={styles.tabPane}>
                            <div className={styles.configSection}>
                              <div className={styles.configHeader}>
                                <Space>
                                  <SettingOutlined style={{ color: token.colorPrimary }} />
                                  <Text strong>Claude Code 局部配置</Text>
                                </Space>
                                <Tooltip
                                  title={configCopied ? t('common.copied') : t('common.copy')}
                                >
                                  <button
                                    type='button'
                                    className={styles.copyButton}
                                    onClick={handleCopyConfig}
                                  >
                                    {configCopied ? (
                                      <CheckOutlined style={{ color: token.colorSuccess }} />
                                    ) : (
                                      <CopyOutlined />
                                    )}
                                  </button>
                                </Tooltip>
                              </div>

                              <Segmented
                                value={configMode}
                                onChange={(value) => setConfigMode(value as 'preview' | 'edit')}
                                options={[
                                  { value: 'preview', label: '预览' },
                                  { value: 'edit', label: '编辑局部' },
                                ]}
                                block
                                className={styles.configTabs}
                              />

                              <TextArea
                                value={configMode === 'preview' ? previewJson : claudeConfigJson}
                                readOnly={configMode === 'preview'}
                                onChange={(e) => {
                                  setClaudeConfigJson(e.target.value)
                                  if (jsonError) setJsonError(null)
                                }}
                                className={`${styles.jsonEditor} ${jsonError ? styles.jsonEditorError : ''}`}
                                autoSize={{ minRows: 8, maxRows: 16 }}
                                placeholder='{}'
                              />

                              <Text type='secondary' className={styles.errorText}>
                                {configMode === 'preview'
                                  ? '预览态展示 Claude Code 全局配置、局部配置和启动注入环境合并后的结果。'
                                  : '这里只编辑这把密钥自己的局部配置；全局配置在 Claude Code 页面维护。'}
                              </Text>

                              {jsonError && (
                                <Text type='danger' className={styles.errorText}>
                                  {jsonError}
                                </Text>
                              )}
                            </div>
                          </div>
                        ),
                      },
                    ]
                  : []),
                {
                  key: 'clientConfigs',
                  label: '客户端配置',
                  children: (
                    <div className={styles.tabPane}>
                      <Text type='secondary' className={styles.hintLine}>
                        为不同客户端指定专用 URL 和上游认证方式，留空则使用默认配置
                      </Text>
                      {/* One row per client, its two controls side by side: a
                          stacked pair per client reads as four unrelated
                          fields rather than two settings for one client. */}
                      <div className={styles.clientList}>
                        {selectedTypes.map((clientKind) => {
                          const config = getClientKindConfig(clientKind)
                          const currentValue = clientConfigs[clientKind]?.baseUrl || ''
                          const currentAuthScheme = clientConfigs[clientKind]?.authScheme
                          const isOverridden = !!currentValue || !!currentAuthScheme
                          return (
                            <div className={styles.clientRow} key={clientKind}>
                              <div className={styles.clientRowHead}>
                                <Text strong>{config.label}</Text>
                                {isOverridden && (
                                  <Text type='secondary' className={styles.clientRowBadge}>
                                    已覆盖
                                  </Text>
                                )}
                              </div>
                              <div className={styles.clientRowFields}>
                                <Form.Item
                                  label='Base URL'
                                  extra={`默认 ${currentProvider?.baseUrl || '未设置'}`}
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
                                  label='上游认证方式'
                                  extra={`默认 ${getDefaultAuthSchemeLabel(clientKind)}`}
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
                                      { label: '默认', value: 'default' },
                                      { label: 'x-api-key', value: 'x-api-key' },
                                      { label: 'Authorization: Bearer', value: 'bearer' },
                                      { label: '不发认证头', value: 'none' },
                                    ]}
                                  />
                                </Form.Item>
                              </div>
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
