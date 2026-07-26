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
  InputNumber,
  Typography,
  Space,
  Segmented,
  theme,
  Tooltip,
  Select,
  Tabs,
  Button,
  Badge,
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
import type { ApiKeyEditorInput } from '../../utils/apiKeyEditor'
import {
  modelMappingValueForSave,
  parseModelMapping,
  type ExactModelMapping,
} from '../../utils/modelMapping'
import styles from './KeyEditModal.module.css'

const { Text } = Typography
const { TextArea } = Input

interface KeyEditModalProps {
  open: boolean
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

  const [usageType, setUsageType] = useState<'none' | 'newapi' | 'custom'>('none')
  const [usageUrl, setUsageUrl] = useState('')
  const [usagePath, setUsagePath] = useState('')
  const [usageHeaders, setUsageHeaders] = useState('')
  const [costMultiplier, setCostMultiplier] = useState<number>(1)
  const [haikuModel, setHaikuModel] = useState('')
  const [sonnetModel, setSonnetModel] = useState('')
  const [opusModel, setOpusModel] = useState('')
  const [modelOverrides, setModelOverrides] = useState<ModelOverrideRow[]>([])
  const [codexModel, setCodexModel] = useState('')
  const [grokModel, setGrokModel] = useState('')
  const [clientConfigs, setClientConfigs] = useState<Partial<Record<ClientKind, ClientConfig>>>({})

  const currentProvider = useMemo(() => {
    const pid = defaultProviderId || apiKey?.providerId
    return pid ? providers.find((p) => p.id === pid) : null
  }, [defaultProviderId, apiKey, providers])

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

    if (apiKey) {
      form.setFieldsValue({
        alias: apiKey.alias || '',
        value: apiKey.value,
      })
      const nextTypes = (apiKey.types?.length ? apiKey.types : ['claude_code']).map((type) =>
        type === 'claude' ? 'claude_code' : type,
      ) as ClientKind[]
      setSelectedTypes(nextTypes)
      const config = { ...(apiKey.config || {}) }
      delete config.prelaunchCommand
      setClaudeConfigJson(JSON.stringify(config, null, 2))
    } else {
      form.resetFields()
      form.setFieldsValue({ alias: '', value: '' })
      setSelectedTypes(['claude_code'])
      setClaudeConfigJson('{}')
    }
    setConfigMode('preview')

    if (apiKey) {
      setUsageType(apiKey.usageType || 'none')
      setUsageUrl(apiKey.usageUrl || '')
      setUsagePath(apiKey.usagePath || '')
      setCostMultiplier(apiKey.costMultiplier ?? 1)
      const mapping = parseModelMapping(apiKey.modelMapping)
      setHaikuModel(mapping.haiku)
      setSonnetModel(mapping.sonnet)
      setOpusModel(mapping.opus)
      setModelOverrides(mapping.modelOverrides.map(createModelOverrideRow))
      setCodexModel(mapping.codex)
      setGrokModel(mapping.grok)
      if (apiKey.usageHeaders) {
        try {
          setUsageHeaders(JSON.stringify(JSON.parse(apiKey.usageHeaders), null, 2))
        } catch {
          setUsageHeaders(apiKey.usageHeaders)
        }
      } else {
        setUsageHeaders('')
      }
      setClientConfigs(apiKey.clientConfigs || {})
    } else {
      setUsageType('none')
      setUsageUrl('')
      setUsagePath('')
      setUsageHeaders('')
      setCostMultiplier(1)
      setHaikuModel('')
      setSonnetModel('')
      setOpusModel('')
      setModelOverrides([])
      setCodexModel('')
      setGrokModel('')
      setClientConfigs({})
    }

    setJsonError(null)
  }, [open, apiKey, form])

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
        modelOverrides,
        codex: codexModel,
        grok: grokModel,
      },
      Boolean(apiKey),
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
      const serializedModelMapping = buildModelMappingJson()
      await onSave({
        id: apiKey?.id,
        providerId,
        alias: values.alias?.trim() || undefined,
        value: values.value?.trim(),
        types: selectedTypes,
        config: localConfig,
        costMultiplier,
        usageType,
        usageUrl: usageType === 'custom' ? usageUrl?.trim() : undefined,
        usagePath: usageType === 'custom' ? usagePath?.trim() : undefined,
        usageHeaders: usageType === 'custom' ? usageHeaders?.trim() : undefined,
        modelMapping: serializedModelMapping,
        clientConfigs,
      })

      message.success(
        apiKey?.id
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
    const baseTitle = apiKey?.id
      ? t('apiKeys.editKey') || '编辑密钥'
      : t('apiKeys.addKey') || '添加密钥'
    return currentProvider ? `${baseTitle} - ${currentProvider.name}` : baseTitle
  }, [apiKey, currentProvider, t])

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
              options={CLIENT_KIND_CONFIGS.map((client) => ({
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

          <Tabs
            defaultActiveKey='basic'
            destroyOnHidden={false}
            className={styles.tabs}
            items={[
              {
                key: 'basic',
                label: '基础',
                children: (
                  <div className={styles.tabPane}>
                    <Form.Item name='alias' label={t('apiKeys.keyName') || '密钥别名'}>
                      <Input
                        placeholder={t('apiKeys.keyNamePlaceholder') || '例如：主密钥、备用密钥'}
                        size='large'
                      />
                    </Form.Item>

                    <Form.Item
                      name='value'
                      label={t('apiKeys.apiKey') || 'API 密钥'}
                      rules={[
                        { required: true, message: t('apiKeys.enterApiKey') || '请输入 API 密钥' },
                      ]}
                    >
                      <Input.Password
                        placeholder={t('apiKeys.apiKeyPlaceholder') || 'sk-xxx...'}
                        size='large'
                      />
                    </Form.Item>

                    <Form.Item
                      label={t('keys.costMultiplier') || '费用倍率'}
                      extra={
                        t('keys.costMultiplierHint') || '中转站分组倍率，默认 1 表示按官方价格计算'
                      }
                    >
                      <InputNumber
                        value={costMultiplier}
                        onChange={(val) => setCostMultiplier(val ?? 1)}
                        min={0}
                        step={0.1}
                        precision={2}
                        style={{ width: '100%' }}
                        size='large'
                        addonAfter='x'
                      />
                    </Form.Item>

                    <Form.Item label={t('keys.usageConfig') || '额度查询配置'}>
                      <Select
                        value={usageType}
                        onChange={(value) => {
                          setUsageType(value)
                          if (value === 'custom') {
                            if (!usageUrl) setUsageUrl('{baseUrl}/api/usage/token/')
                            if (!usagePath) setUsagePath('data.total_available')
                            if (!usageHeaders)
                              setUsageHeaders('{\n  "Authorization": "Bearer {key}"\n}')
                          }
                        }}
                        options={[
                          { value: 'none', label: t('keys.usageTypeNone') || '不查询' },
                          { value: 'newapi', label: t('keys.usageTypeNewapi') || 'NewAPI' },
                          { value: 'custom', label: t('keys.usageTypeCustom') || '自定义' },
                        ]}
                        style={{ width: '100%' }}
                      />
                    </Form.Item>

                    {usageType === 'custom' && (
                      <>
                        <Form.Item
                          label={t('keys.usageUrl') || '查询 URL'}
                          extra={
                            t('keys.usageUrlVarHint') ||
                            '支持变量: {baseUrl} = 供应商地址, {key} = API 密钥'
                          }
                        >
                          <Input
                            value={usageUrl}
                            onChange={(e) => setUsageUrl(e.target.value)}
                            placeholder='{baseUrl}/api/usage/token/'
                          />
                        </Form.Item>
                        <Form.Item
                          label={
                            <Space>
                              <span>{t('keys.usagePath') || 'JSON 路径'}</span>
                              <Button
                                type='link'
                                size='small'
                                className={styles.templateBtn}
                                onClick={() => {
                                  setUsagePath(
                                    JSON.stringify(
                                      {
                                        remaining: 'data.total_available',
                                        total: 'data.total_granted',
                                        isUnlimited: 'data.unlimited_quota',
                                      },
                                      null,
                                      2,
                                    ),
                                  )
                                }}
                              >
                                {t('keys.usagePathMapTemplate') || '映射表模板'}
                              </Button>
                            </Space>
                          }
                          extra={
                            t('keys.usagePathMapHint') ||
                            '支持单路径（如 data.balance）或 JSON 映射表'
                          }
                        >
                          <TextArea
                            value={usagePath}
                            onChange={(e) => setUsagePath(e.target.value)}
                            placeholder='data.total_available'
                            autoSize={{ minRows: 1, maxRows: 8 }}
                            className={styles.jsonEditor}
                          />
                        </Form.Item>
                        <Form.Item
                          label={t('keys.usageHeaders') || '自定义 Headers'}
                          extra={
                            t('keys.usageHeadersVarHint') ||
                            '支持变量: {key} = API 密钥, {baseUrl} = 供应商地址'
                          }
                        >
                          <Input.TextArea
                            value={usageHeaders}
                            onChange={(e) => setUsageHeaders(e.target.value)}
                            placeholder={'{\n  "Authorization": "Bearer {key}"\n}'}
                            autoSize={{ minRows: 3, maxRows: 6 }}
                            style={{ fontFamily: 'monospace', fontSize: 12 }}
                          />
                        </Form.Item>
                      </>
                    )}
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
                            '仅改写发给中转站的 model，不改变 Codex 模型列表'
                          }
                        >
                          <Input
                            value={codexModel}
                            onChange={(e) => setCodexModel(e.target.value)}
                            placeholder={
                              t('keys.modelMapCodexPlaceholder') || '例如：deepseek-chat'
                            }
                          />
                        </Form.Item>
                      </div>
                    )}
                    {selectedTypes.includes('grok') && (
                      <div>
                        <Text strong style={{ marginBottom: 12, display: 'block' }}>
                          Grok Build
                        </Text>
                        <Form.Item label='上游模型' extra='仅改写 Grok Build 发给中转站的 model'>
                          <Input
                            value={grokModel}
                            onChange={(e) => setGrokModel(e.target.value)}
                            placeholder='例如：grok-build-0.1'
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
                              <Tooltip title={configCopied ? t('common.copied') : t('common.copy')}>
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
                    <Text
                      type='secondary'
                      style={{ marginBottom: 16, display: 'block', fontSize: 12 }}
                    >
                      为不同客户端指定专用 URL 和上游认证方式,留空则使用默认配置
                    </Text>
                    <Space direction='vertical' style={{ width: '100%' }} size={16}>
                      {selectedTypes.map((clientKind) => {
                        const config = getClientKindConfig(clientKind)
                        const currentValue = clientConfigs[clientKind]?.baseUrl || ''
                        const currentAuthScheme = clientConfigs[clientKind]?.authScheme
                        const isOverridden = !!currentValue || !!currentAuthScheme
                        return (
                          <div key={clientKind}>
                            <Space style={{ marginBottom: 8 }}>
                              <Text strong>{config.label}</Text>
                              {isOverridden && <Badge status='processing' text='已覆盖' />}
                            </Space>
                            <Space direction='vertical' style={{ width: '100%' }} size={8}>
                              <Form.Item
                                label='Base URL'
                                extra={`默认: ${currentProvider?.baseUrl || '(未设置)'}`}
                                style={{ marginBottom: 0 }}
                              >
                                <Input
                                  value={currentValue}
                                  onChange={(e) =>
                                    updateClientConfig(clientKind, {
                                      baseUrl: e.target.value.trim(),
                                    })
                                  }
                                  placeholder={
                                    currentProvider?.baseUrl || 'https://api.example.com/v1'
                                  }
                                  size='large'
                                />
                              </Form.Item>
                              <Form.Item
                                label='上游认证方式'
                                extra={`默认: ${getDefaultAuthSchemeLabel(clientKind)}`}
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
                                  size='large'
                                />
                              </Form.Item>
                            </Space>
                          </div>
                        )
                      })}
                    </Space>
                  </div>
                ),
              },
            ]}
          />
        </Form>
      </SimpleBar>
    </Modal>
  )
}
