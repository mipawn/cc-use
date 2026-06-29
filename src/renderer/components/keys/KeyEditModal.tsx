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
  Checkbox,
  Typography,
  Space,
  Segmented,
  theme,
  Tooltip,
  Select,
  Tabs,
  Button,
} from 'antd'
import { useAppMessage } from '../../hooks/useAppMessage'
import {
  SettingOutlined,
  CopyOutlined,
  CheckOutlined,
  DesktopOutlined,
  CodeOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import type {
  ApiKey,
  Provider,
  ClientKind,
  CliConfig,
  TerminalLaunchPreview,
} from '@shared/types'
import { CLIENT_KIND_CONFIGS } from '@shared/types'
import { useSettingsStore } from '../../stores/settingsStore'
import styles from './KeyEditModal.module.css'

const { Text } = Typography
const { TextArea } = Input

interface KeyEditModalProps {
  open: boolean
  apiKey: ApiKey | null
  providers: Provider[]
  defaultProviderId?: string
  onClose: () => void
  onSave: (input: {
    id?: string
    providerId: string
    alias?: string
    value: string
    types: ClientKind[]
    config?: CliConfig
    costMultiplier?: number
    usageType?: 'none' | 'newapi' | 'custom'
    usageUrl?: string
    usagePath?: string
    usageHeaders?: string
    modelMapping?: string
  }) => Promise<void>
}

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
  const [defaultModel, setDefaultModel] = useState('')

  const currentProvider = useMemo(() => {
    const pid = defaultProviderId || apiKey?.providerId
    return pid ? providers.find((p) => p.id === pid) : null
  }, [defaultProviderId, apiKey, providers])

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
      const nextTypes = (apiKey.types?.length ? apiKey.types : ['claude_code'])
        .map((type) => (type === 'claude' ? 'claude_code' : type)) as ClientKind[]
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
      if (apiKey.modelMapping) {
        try {
          const m = JSON.parse(apiKey.modelMapping)
          setHaikuModel(m.haiku || '')
          setSonnetModel(m.sonnet || '')
          setOpusModel(m.opus || '')
          setDefaultModel(m.default || '')
        } catch {
          setHaikuModel('')
          setSonnetModel('')
          setOpusModel('')
          setDefaultModel('')
        }
      } else {
        setHaikuModel('')
        setSonnetModel('')
        setOpusModel('')
        setDefaultModel('')
      }
      if (apiKey.usageHeaders) {
        try {
          setUsageHeaders(JSON.stringify(JSON.parse(apiKey.usageHeaders), null, 2))
        } catch {
          setUsageHeaders(apiKey.usageHeaders)
        }
      } else {
        setUsageHeaders('')
      }
    } else {
      setUsageType('none')
      setUsageUrl('')
      setUsagePath('')
      setUsageHeaders('')
      setCostMultiplier(1)
      setHaikuModel('')
      setSonnetModel('')
      setOpusModel('')
      setDefaultModel('')
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

  const handleTypeChange = (type: ClientKind, checked: boolean) => {
    if (checked) {
      setSelectedTypes((prev) => [...prev, type])
    } else {
      const newTypes = selectedTypes.filter((t) => t !== type)
      if (newTypes.length === 0) {
        message.warning(t('apiKeys.selectAtLeastOne') || '至少选择一种类型')
        return
      }
      setSelectedTypes(newTypes)
    }
  }

  const buildModelMappingJson = (): string | undefined => {
    const map: Record<string, string> = {}
    if (haikuModel.trim()) map.haiku = haikuModel.trim()
    if (sonnetModel.trim()) map.sonnet = sonnetModel.trim()
    if (opusModel.trim()) map.opus = opusModel.trim()
    if (defaultModel.trim()) map.default = defaultModel.trim()
    return Object.keys(map).length > 0 ? JSON.stringify(map) : undefined
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

      const localConfig = selectedTypes.includes('claude_code') ? parseConfig(claudeConfigJson) : undefined
      if (localConfig) {
        delete localConfig.prelaunchCommand
      }
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
        modelMapping: buildModelMappingJson(),
      })

      message.success(apiKey?.id ? t('apiKeys.keyUpdated') || '密钥已更新' : t('apiKeys.keyAdded') || '密钥已添加')
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
    const baseTitle = apiKey?.id ? t('apiKeys.editKey') || '编辑密钥' : t('apiKeys.addKey') || '添加密钥'
    return currentProvider ? `${baseTitle} - ${currentProvider.name}` : baseTitle
  }, [apiKey, currentProvider, t])

  const mergedConfigJson = useMemo(() => (
    JSON.stringify({ ...claudeGlobalConfig, ...parseConfig(claudeConfigJson) }, null, 2)
  ), [claudeGlobalConfig, claudeConfigJson])

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
          >
            <Space size={16} wrap>
              {CLIENT_KIND_CONFIGS.map((client) => (
                <Checkbox
                  key={client.kind}
                  checked={selectedTypes.includes(client.kind)}
                  onChange={(e) => handleTypeChange(client.kind, e.target.checked)}
                >
                  <Space>
                    {client.form === 'process_injection' ? <CodeOutlined /> : <DesktopOutlined />}
                    {client.label}
                  </Space>
                </Checkbox>
              ))}
            </Space>
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
                      <Input placeholder={t('apiKeys.keyNamePlaceholder') || '例如：主密钥、备用密钥'} size='large' />
                    </Form.Item>

                    <Form.Item
                      name='value'
                      label={t('apiKeys.apiKey') || 'API 密钥'}
                      rules={[{ required: true, message: t('apiKeys.enterApiKey') || '请输入 API 密钥' }]}
                    >
                      <Input.Password placeholder={t('apiKeys.apiKeyPlaceholder') || 'sk-xxx...'} size='large' />
                    </Form.Item>

                    <Form.Item
                      label={t('keys.costMultiplier') || '费用倍率'}
                      extra={t('keys.costMultiplierHint') || '中转站分组倍率，默认 1 表示按官方价格计算'}
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
                            if (!usageHeaders) setUsageHeaders('{\n  "Authorization": "Bearer {key}"\n}')
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
                          extra={t('keys.usageUrlVarHint') || '支持变量: {baseUrl} = 供应商地址, {key} = API 密钥'}
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
                          extra={t('keys.usagePathMapHint') || '支持单路径（如 data.balance）或 JSON 映射表'}
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
                          extra={t('keys.usageHeadersVarHint') || '支持变量: {key} = API 密钥, {baseUrl} = 供应商地址'}
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
                    <Text type='secondary' style={{ marginBottom: 12, display: 'block', fontSize: 12 }}>
                      {t('keys.modelMappingHint') || '根据模型名称自动匹配类别并替换，仅对 Claude 类型生效'}
                    </Text>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
                      <Form.Item label='Haiku' extra={t('keys.modelMapHaikuExtra') || '包含 haiku 的模型 →'}>
                        <Input
                          value={haikuModel}
                          onChange={(e) => setHaikuModel(e.target.value)}
                          placeholder='claude-haiku-4-5'
                        />
                      </Form.Item>
                      <Form.Item label='Sonnet' extra={t('keys.modelMapSonnetExtra') || '包含 sonnet 的模型 →'}>
                        <Input
                          value={sonnetModel}
                          onChange={(e) => setSonnetModel(e.target.value)}
                          placeholder='claude-sonnet-4-5'
                        />
                      </Form.Item>
                      <Form.Item label='Opus' extra={t('keys.modelMapOpusExtra') || '包含 opus 的模型 →'}>
                        <Input
                          value={opusModel}
                          onChange={(e) => setOpusModel(e.target.value)}
                          placeholder='claude-opus-4-7'
                        />
                      </Form.Item>
                      <Form.Item label={t('keys.modelMapDefault') || '兜底模型'} extra={t('keys.modelMapDefaultExtra') || '以上都不匹配时使用'}>
                        <Input
                          value={defaultModel}
                          onChange={(e) => setDefaultModel(e.target.value)}
                          placeholder={t('keys.modelMapDefaultPlaceholder') || '留空则保持原名'}
                        />
                      </Form.Item>
                    </div>
                  </div>
                ),
              },
              ...(selectedTypes.includes('claude_code')
                ? [{
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
                            <button type='button' className={styles.copyButton} onClick={handleCopyConfig}>
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
                  }]
                : []),
            ]}
          />
        </Form>
      </SimpleBar>
    </Modal>
  )
}
