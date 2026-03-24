/**
 * KeyEditModal - 密钥编辑弹窗
 * 统一新增和编辑体验
 * 支持多选类型，每种类型有独立配置
 */
import { useEffect, useState, useMemo } from 'react'
import {
  Modal,
  Form,
  Input,
  InputNumber,
  Checkbox,
  Typography,
  Switch,
  Space,
  Segmented,
  theme,
  Tooltip,
  Select,
  Collapse,
  Button,
} from 'antd'
import { useAppMessage } from '../../hooks/useAppMessage'
import { SettingOutlined, CopyOutlined, CheckOutlined, WalletOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import type { ApiKey, Provider, ProviderType, CliConfig } from '@shared/types'
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
    types: ProviderType[]
    config?: CliConfig
    costMultiplier?: number
    usageType?: 'none' | 'newapi' | 'custom'
    usageUrl?: string
    usagePath?: string
    usageHeaders?: string
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

  // 支持的类型（多选）
  const [selectedTypes, setSelectedTypes] = useState<ProviderType[]>(['claude'])
  // 当前编辑的配置类型
  const [activeConfigType, setActiveConfigType] = useState<ProviderType>('claude')

  // 每种类型的配置
  const [claudeConfigJson, setClaudeConfigJson] = useState('{}')
  const [codexConfigJson, setCodexConfigJson] = useState('{}')

  // 是否合并全局配置
  const [claudeIncludeGlobal, setClaudeIncludeGlobal] = useState(true)
  const [codexIncludeGlobal, setCodexIncludeGlobal] = useState(true)

  const [jsonError, setJsonError] = useState<string | null>(null)
  const [configCopied, setConfigCopied] = useState(false)
  const { globalSettings } = useSettingsStore()

  // Usage/quota config state
  const [usageType, setUsageType] = useState<'none' | 'newapi' | 'custom'>('none')
  const [usageUrl, setUsageUrl] = useState('')
  const [usagePath, setUsagePath] = useState('')
  const [usageHeaders, setUsageHeaders] = useState('')
  const [costMultiplier, setCostMultiplier] = useState<number>(1)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const currentProvider = useMemo(() => {
    const pid = defaultProviderId || apiKey?.providerId
    return pid ? providers.find((p) => p.id === pid) : null
  }, [defaultProviderId, apiKey, providers])

  // 获取全局配置（稳定引用，避免 useEffect 无限触发）
  const claudeGlobalConfig = useMemo(
    () => globalSettings.claudeConfig || {},
    [globalSettings.claudeConfig],
  )
  const codexGlobalConfig = useMemo(
    () => globalSettings.codexConfig || {},
    [globalSettings.codexConfig],
  )

  // 解析当前配置
  const parseConfig = (json: string): CliConfig => {
    try {
      return JSON.parse(json) as CliConfig
    } catch {
      return {}
    }
  }

  // 计算需要保存的局部配置
  const getLocalConfigToSave = (
    configJson: string,
    globalConfig: CliConfig,
    includeGlobal: boolean,
  ): CliConfig => {
    const currentConfig = parseConfig(configJson)
    if (!includeGlobal) {
      return currentConfig
    }
    // 只保存与全局不同的部分
    const diff: CliConfig = {}
    for (const [key, value] of Object.entries(currentConfig)) {
      if (JSON.stringify(globalConfig[key]) !== JSON.stringify(value)) {
        diff[key] = value
      }
    }
    return diff
  }

  // 初始化
  useEffect(() => {
    if (open) {
      if (apiKey) {
        // 编辑模式
        form.setFieldsValue({
          alias: apiKey.alias || '',
          value: apiKey.value,
        })
        setSelectedTypes(apiKey.types)
        setActiveConfigType(apiKey.types[0] || 'claude')

        // 合并全局配置和局部配置
        if (apiKey.types.includes('claude')) {
          const merged = { ...claudeGlobalConfig, ...(apiKey.config || {}) }
          setClaudeConfigJson(JSON.stringify(merged, null, 2))
          setClaudeIncludeGlobal(true)
        } else {
          setClaudeConfigJson('{}')
          setClaudeIncludeGlobal(true)
        }
        if (apiKey.types.includes('codex')) {
          const merged = { ...codexGlobalConfig, ...(apiKey.config || {}) }
          setCodexConfigJson(JSON.stringify(merged, null, 2))
          setCodexIncludeGlobal(true)
        } else {
          setCodexConfigJson('{}')
          setCodexIncludeGlobal(true)
        }
      } else {
        // 新增模式
        form.resetFields()
        form.setFieldsValue({
          alias: '',
          value: '',
        })
        setSelectedTypes(['claude'])
        setActiveConfigType('claude')

        // 默认显示全局配置
        if (Object.keys(claudeGlobalConfig).length > 0) {
          setClaudeConfigJson(JSON.stringify(claudeGlobalConfig, null, 2))
        } else {
          setClaudeConfigJson('{}')
        }
        if (Object.keys(codexGlobalConfig).length > 0) {
          setCodexConfigJson(JSON.stringify(codexGlobalConfig, null, 2))
        } else {
          setCodexConfigJson('{}')
        }
        setClaudeIncludeGlobal(true)
        setCodexIncludeGlobal(true)
      }
      // Initialize usage config
      if (apiKey) {
        setUsageType(apiKey.usageType || 'none')
        setUsageUrl(apiKey.usageUrl || '')
        setUsagePath(apiKey.usagePath || '')
        setCostMultiplier(apiKey.costMultiplier ?? 1)
        // Auto-expand advanced if non-default values exist
        setShowAdvanced(
          (apiKey.costMultiplier != null && apiKey.costMultiplier !== 1) ||
            (apiKey.usageType != null && apiKey.usageType !== 'none'),
        )
        // Format headers JSON for display
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
        setShowAdvanced(false)
      }
      setJsonError(null)
    }
  }, [open, apiKey, form, claudeGlobalConfig, codexGlobalConfig])

  // 切换类型选择
  const handleTypeChange = (type: ProviderType, checked: boolean) => {
    if (checked) {
      setSelectedTypes((prev) => [...prev, type])
      // 切换到新选中的类型
      setActiveConfigType(type)
      // 如果是新选中的类型，初始化其配置
      if (type === 'claude' && claudeConfigJson === '{}') {
        if (Object.keys(claudeGlobalConfig).length > 0) {
          setClaudeConfigJson(JSON.stringify(claudeGlobalConfig, null, 2))
        }
      } else if (type === 'codex' && codexConfigJson === '{}') {
        if (Object.keys(codexGlobalConfig).length > 0) {
          setCodexConfigJson(JSON.stringify(codexGlobalConfig, null, 2))
        }
      }
    } else {
      const newTypes = selectedTypes.filter((t) => t !== type)
      if (newTypes.length === 0) {
        message.warning(t('apiKeys.selectAtLeastOne') || '至少选择一种类型')
        return
      }
      setSelectedTypes(newTypes)
      // 如果取消的是当前编辑的类型，切换到另一个
      if (activeConfigType === type) {
        setActiveConfigType(newTypes[0])
      }
    }
  }

  // 切换合并全局配置
  const handleToggleGlobal = (type: ProviderType, checked: boolean) => {
    const globalConfig = type === 'claude' ? claudeGlobalConfig : codexGlobalConfig
    const configJson = type === 'claude' ? claudeConfigJson : codexConfigJson
    const setConfigJson = type === 'claude' ? setClaudeConfigJson : setCodexConfigJson
    const setIncludeGlobal = type === 'claude' ? setClaudeIncludeGlobal : setCodexIncludeGlobal

    const currentConfig = parseConfig(configJson)

    if (checked) {
      // 开启：合并全局配置
      const merged = { ...globalConfig, ...currentConfig }
      setConfigJson(JSON.stringify(merged, null, 2))
    } else {
      // 关闭：移除全局配置的字段
      const local: CliConfig = {}
      for (const [key, value] of Object.entries(currentConfig)) {
        if (JSON.stringify(globalConfig[key]) !== JSON.stringify(value)) {
          local[key] = value
        }
      }
      setConfigJson(JSON.stringify(local, null, 2) || '{}')
    }
    setIncludeGlobal(checked)
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

      // 验证 JSON
      try {
        if (selectedTypes.includes('claude')) {
          JSON.parse(claudeConfigJson)
        }
        if (selectedTypes.includes('codex')) {
          JSON.parse(codexConfigJson)
        }
      } catch {
        setJsonError('JSON 格式错误')
        message.error('JSON 格式错误')
        return
      }

      // 保存密钥（编辑或新增都保存为一条记录，支持多类型）
      // 使用第一个选中类型的配置作为保存的配置
      const primaryType = selectedTypes[0]
      const configJson = primaryType === 'claude' ? claudeConfigJson : codexConfigJson
      const globalConfig = primaryType === 'claude' ? claudeGlobalConfig : codexGlobalConfig
      const includeGlobal = primaryType === 'claude' ? claudeIncludeGlobal : codexIncludeGlobal

      const localConfig = getLocalConfigToSave(configJson, globalConfig, includeGlobal)

      await onSave({
        id: apiKey?.id,
        providerId,
        alias: values.alias?.trim() || undefined,
        value: values.value?.trim(),
        types: selectedTypes,
        config: Object.keys(localConfig).length > 0 ? localConfig : undefined,
        costMultiplier,
        usageType,
        usageUrl: usageType === 'custom' ? usageUrl?.trim() : undefined,
        usagePath: usageType === 'custom' ? usagePath?.trim() : undefined,
        usageHeaders: usageType === 'custom' ? usageHeaders?.trim() : undefined,
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
    if (currentProvider) {
      return `${baseTitle} - ${currentProvider.name}`
    }
    return baseTitle
  }, [apiKey, currentProvider, t])

  const currentConfigJson = activeConfigType === 'claude' ? claudeConfigJson : codexConfigJson
  const setCurrentConfigJson =
    activeConfigType === 'claude' ? setClaudeConfigJson : setCodexConfigJson
  const currentIncludeGlobal =
    activeConfigType === 'claude' ? claudeIncludeGlobal : codexIncludeGlobal
  const currentGlobalConfig = activeConfigType === 'claude' ? claudeGlobalConfig : codexGlobalConfig
  const hasGlobalConfig = Object.keys(currentGlobalConfig).length > 0

  // 构建完整的配置预览（包含 baseUrl 和 token）
  const getFullConfigPreview = (configJson: string, type: ProviderType): string => {
    try {
      const config = JSON.parse(configJson)
      const baseUrlKey = type === 'claude' ? 'ANTHROPIC_BASE_URL' : 'OPENAI_BASE_URL'
      const apiKeyKey = type === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'

      const fullConfig = {
        [baseUrlKey]: currentProvider?.baseUrl || '',
        [apiKeyKey]: '${API_KEY}',
        ...config,
      }
      return JSON.stringify(fullConfig, null, 2)
    } catch {
      return configJson
    }
  }

  const displayConfigJson = getFullConfigPreview(currentConfigJson, activeConfigType)

  // 复制配置（用明文 API Key 替换占位符）
  const handleCopyConfig = async () => {
    try {
      const apiKeyValue = form.getFieldValue('value') || ''
      const configToCopy = displayConfigJson.replace('${API_KEY}', apiKeyValue)
      await navigator.clipboard.writeText(configToCopy)
      setConfigCopied(true)
      setTimeout(() => setConfigCopied(false), 2000)
      message.success(t('common.copied') || '已复制')
    } catch (error) {
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
          {/* Key Type - Multi Select */}
          <Form.Item
            label={t('apiKeys.keyType') || '密钥类型'}
            required
            extra={
              selectedTypes.length > 1
                ? t('apiKeys.multiTypeHint') || '将为每种类型创建一个密钥'
                : undefined
            }
          >
            <Space size={16}>
              <Checkbox
                checked={selectedTypes.includes('claude')}
                onChange={(e) => handleTypeChange('claude', e.target.checked)}
              >
                <Space>
                  <span
                    className={styles.typeIndicator}
                    style={{ background: token.colorPrimary }}
                  />
                  Claude Code
                </Space>
              </Checkbox>
              <Checkbox
                checked={selectedTypes.includes('codex')}
                onChange={(e) => handleTypeChange('codex', e.target.checked)}
              >
                <Space>
                  <span
                    className={styles.typeIndicator}
                    style={{ background: token.colorSuccess }}
                  />
                  Codex CLI
                </Space>
              </Checkbox>
            </Space>
          </Form.Item>

          {/* Alias */}
          <Form.Item name='alias' label={t('apiKeys.keyName') || '密钥别名'}>
            <Input
              placeholder={t('apiKeys.keyNamePlaceholder') || '例如：主密钥、备用密钥'}
              size='large'
            />
          </Form.Item>

          {/* API Key Value */}
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

          {/* Advanced: Cost & Usage Config - Collapsible */}
          <Collapse
            ghost
            activeKey={showAdvanced ? ['advanced'] : []}
            onChange={(keys) => setShowAdvanced(keys.includes('advanced'))}
            className={styles.advancedCollapse}
            items={[
              {
                key: 'advanced',
                label: (
                  <Space>
                    <WalletOutlined />
                    <span>{t('keys.advancedConfig') || '额度与费用'}</span>
                  </Space>
                ),
                children: (
                  <div className={styles.advancedContent}>
                    {/* Cost Multiplier */}
                    <Form.Item
                      label={t('keys.costMultiplier') || '费用倍率'}
                      extra={
                        t('keys.costMultiplierHint') ||
                        '中转站分组倍率，默认 1 表示按官方价格计算'
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

                    {/* Usage/Quota Config */}
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
            ]}
          />

          {/* Config Section */}
          <div className={styles.configSection}>
            <div className={styles.configHeader}>
              <Space>
                <SettingOutlined style={{ color: token.colorPrimary }} />
                <Text strong>{t('apiKeys.configTitle') || '配置'}</Text>
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

            {/* Config Type Tabs (only show if multiple types selected) */}
            {selectedTypes.length > 1 && (
              <Segmented
                value={activeConfigType}
                onChange={(value) => setActiveConfigType(value as ProviderType)}
                options={selectedTypes.map((type) => ({
                  value: type,
                  label: (
                    <Space>
                      <span
                        className={styles.typeIndicator}
                        style={{
                          background: type === 'claude' ? token.colorPrimary : token.colorSuccess,
                        }}
                      />
                      {type === 'claude' ? 'Claude' : 'Codex'}
                    </Space>
                  ),
                }))}
                block
                className={styles.configTabs}
              />
            )}

            {/* Global Config Toggle */}
            {hasGlobalConfig && (
              <div className={styles.globalToggle}>
                <Text type='secondary' style={{ fontSize: 12 }}>
                  {t('apiKeys.mergeGlobal') || '合并全局配置'}
                </Text>
                <Switch
                  size='small'
                  checked={currentIncludeGlobal}
                  onChange={(checked) => handleToggleGlobal(activeConfigType, checked)}
                />
              </div>
            )}

            <TextArea
              value={displayConfigJson}
              onChange={(e) => {
                // 解析用户输入，移除 baseUrl 和 apiKey 字段后保存
                try {
                  const parsed = JSON.parse(e.target.value)
                  const baseUrlKey =
                    activeConfigType === 'claude' ? 'ANTHROPIC_BASE_URL' : 'OPENAI_BASE_URL'
                  const apiKeyKey =
                    activeConfigType === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
                  delete parsed[baseUrlKey]
                  delete parsed[apiKeyKey]
                  setCurrentConfigJson(JSON.stringify(parsed, null, 2))
                } catch {
                  // JSON 格式错误时直接保存原始值
                  setCurrentConfigJson(e.target.value)
                }
                if (jsonError) setJsonError(null)
              }}
              className={`${styles.jsonEditor} ${jsonError ? styles.jsonEditorError : ''}`}
              autoSize={{ minRows: 8, maxRows: 14 }}
              placeholder='{}'
            />

            {jsonError && (
              <Text type='danger' className={styles.errorText}>
                {jsonError}
              </Text>
            )}
          </div>
        </Form>
      </SimpleBar>
    </Modal>
  )
}
