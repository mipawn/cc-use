import { getApi } from '../../api'
import { useEffect, useState, useRef } from 'react'
import { Modal, Form, Input, Select, Typography, Tooltip, Space, Collapse } from 'antd'
import { useAppMessage } from '../../hooks/useAppMessage'
import { UploadOutlined, LinkOutlined, SettingOutlined, WalletOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import type { Provider, CreateProviderInput, ProviderPreset } from '@shared/types'
import styles from './ProviderModal.module.css'

import claudeIcon from '../../assets/provider-icons/claude.svg'
import openaiIcon from '../../assets/provider-icons/openai.svg'
import deepseekIcon from '../../assets/provider-icons/deepseek.svg'
import newapiIcon from '../../assets/provider-icons/newapi.svg'

const { Text } = Typography
const { TextArea } = Input

const PRESET_ICONS: { key: string; icon: string; label: string }[] = [
  { key: 'claude', icon: claudeIcon, label: 'Claude' },
  { key: 'openai', icon: openaiIcon, label: 'OpenAI' },
  { key: 'deepseek', icon: deepseekIcon, label: 'DeepSeek' },
  { key: 'newapi', icon: newapiIcon, label: 'NewAPI' },
]

const PRESET_ICON_MAP: Record<string, string> = Object.fromEntries(
  PRESET_ICONS.map((i) => [i.key, i.icon]),
)

const BALANCE_TYPES = ['none', 'newapi', 'custom', 'deepseek'] as const
type BalanceType = (typeof BALANCE_TYPES)[number]

const USAGE_TYPES = ['none', 'newapi', 'custom'] as const
type UsageType = (typeof USAGE_TYPES)[number]

interface ProviderModalProps {
  open: boolean
  provider: Provider | null
  onClose: () => void
  onSave: (input: CreateProviderInput & { id?: string; isActive?: boolean }) => Promise<void>
}

export default function ProviderModal({ open, provider, onClose, onSave }: ProviderModalProps) {
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [balanceType, setBalanceType] = useState<BalanceType>('none')
  const [usageType, setUsageType] = useState<UsageType>('none')
  const [selectedIcon, setSelectedIcon] = useState<string>('claude')
  const [customIconPath, setCustomIconPath] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [preset, setPreset] = useState<ProviderPreset | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const message = useAppMessage()

  // The catalogue is code, not user data; it only seeds a new provider.
  useEffect(() => {
    if (!open) return
    getApi()
      .provider.presets()
      .then(setPresets)
      .catch(() => setPresets([]))
  }, [open])

  useEffect(() => {
    if (open) {
      if (provider) {
        form.setFieldsValue({
          name: provider.name,
          baseUrl: provider.baseUrl,
          httpProxy: provider.httpProxy,
          website: provider.website,
          remark: provider.remark,
          token: provider.token,
          walletBalanceType: provider.walletBalanceType,
          walletBalanceUrl: provider.walletBalanceUrl,
          walletBalancePath: provider.walletBalancePath,
          walletBalanceHeaders: provider.walletBalanceHeaders,
          walletBalanceUserId: provider.walletBalanceUserId,
          usageType: provider.usageType,
          usageUrl: provider.usageUrl,
          usagePath: provider.usagePath,
          usageHeaders: provider.usageHeaders,
          requestAdapter: provider.requestAdapter,
        })
        setBalanceType(provider.walletBalanceType)
        setUsageType(normalizeUsageType(provider.usageType))
        setPreset(null)
        if (provider.icon) {
          if (PRESET_ICON_MAP[provider.icon]) {
            setSelectedIcon(provider.icon)
            setCustomIconPath(null)
          } else {
            setSelectedIcon('custom')
            setCustomIconPath(provider.icon)
          }
        } else {
          setSelectedIcon('claude')
          setCustomIconPath(null)
        }
        // Show advanced if there's balance config
        setShowAdvanced(provider.walletBalanceType !== 'none')
      } else {
        form.resetFields()
        form.setFieldsValue({
          walletBalanceType: 'none',
          usageType: 'none',
          requestAdapter: 'none',
        })
        setBalanceType('none')
        setUsageType('none')
        setSelectedIcon('claude')
        setCustomIconPath(null)
        setShowAdvanced(false)
        setPreset(null)
      }
    }
  }, [open, provider, form])

  /**
   * Fill the form from a template. Everything the template supplies is written
   * into the form, so the user sees exactly what will be saved and can edit any
   * of it — nothing is applied behind the form's back.
   */
  const applyPreset = (next: ProviderPreset) => {
    setPreset(next)
    const balance = BALANCE_TYPES.includes(next.walletBalanceType as BalanceType)
      ? (next.walletBalanceType as BalanceType)
      : 'none'
    const usage = normalizeUsageType(next.usageType)
    form.setFieldsValue({
      name: next.defaultName || form.getFieldValue('name') || '',
      baseUrl: next.baseUrl || form.getFieldValue('baseUrl') || '',
      walletBalanceType: balance,
      walletBalanceUrl: next.walletBalanceUrl ?? undefined,
      usageType: usage,
      usageUrl: next.usageUrl ?? undefined,
      requestAdapter: next.requestAdapter || 'none',
    })
    setBalanceType(balance)
    setUsageType(usage)
    if (PRESET_ICON_MAP[next.icon]) {
      setSelectedIcon(next.icon)
      setCustomIconPath(null)
    }
  }

  const handleSubmit = async () => {
    try {
      setLoading(true)
      const values = await form.validateFields()
      const iconValue = selectedIcon === 'custom' ? customIconPath : selectedIcon

      await onSave({
        id: provider?.id,
        name: values.name?.trim(),
        baseUrl: values.baseUrl?.trim(),
        httpProxy: values.httpProxy?.trim(),
        website: values.website?.trim(),
        remark: values.remark?.trim(),
        token: values.token?.trim(),
        icon: iconValue || undefined,
        walletBalanceType: values.walletBalanceType,
        walletBalanceUrl: values.walletBalanceUrl?.trim(),
        walletBalancePath: values.walletBalancePath?.trim(),
        walletBalanceHeaders: values.walletBalanceHeaders?.trim(),
        walletBalanceUserId: values.walletBalanceUserId?.trim(),
        usageType: values.usageType,
        usageUrl: values.usageUrl?.trim(),
        usagePath: values.usagePath?.trim(),
        usageHeaders: values.usageHeaders?.trim(),
        requestAdapter: values.requestAdapter,
        // The template's request adapter and key defaults travel with the
        // provider. Editing the address or the icon never silently drops them.
        presetId: provider ? provider.presetId : preset?.id,
        defaultKeyConfig: provider
          ? (provider.defaultKeyConfig ?? undefined)
          : preset?.defaultKeyConfig,
        isActive: provider?.isActive ?? true,
      })

      message.success(provider ? t('providers.providerUpdated') : t('providers.providerCreated'))
      onClose()
    } catch (error) {
      if (error instanceof Error) {
        message.error(error.message)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleIconUpload = async (file: File) => {
    try {
      const buffer = await file.arrayBuffer()
      const path = await getApi().icon.upload(buffer, file.name)
      setCustomIconPath(path)
      setSelectedIcon('custom')
    } catch {
      message.error(t('messages.error'))
    }
  }

  return (
    <Modal
      title={provider ? t('providers.editProvider') : t('providers.newProvider')}
      open={open}
      onCancel={onClose}
      onOk={handleSubmit}
      okText={t('common.confirm')}
      cancelText={t('common.cancel')}
      confirmLoading={loading}
      width={720}
      destroyOnHidden
      className={styles.modal}
    >
      <SimpleBar className={styles.scrollContainer}>
        <div className={styles.body}>
          <Form
            form={form}
            layout='vertical'
            className={styles.form}
            initialValues={{ walletBalanceType: 'none', usageType: 'none' }}
          >
            {/* A template is a starting point, not a lock: picking one fills in
                the fields below, and each of them stays editable. Presets are
                named, not branded — they select a template, so a vendor logo
                would say the wrong thing. */}
            {!provider && presets.length > 0 && (
              <>
                <div className={styles.sectionHeader}>
                  <SettingOutlined className={styles.sectionIcon} />
                  <Text strong>{t('providers.preset') || '预设'}</Text>
                </div>
                <div className={styles.presetRow}>
                  {presets.map((item) => (
                    <button
                      key={item.id}
                      type='button'
                      className={`${styles.presetChip} ${
                        preset?.id === item.id ? styles.presetChipActive : ''
                      }`}
                      onClick={() => applyPreset(item)}
                    >
                      {presetLabel(item.id, t)}
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* Main Form Grid */}
            <div className={styles.formGrid}>
              {/* Left Column - Basic Info */}
              <div className={styles.formColumn}>
                <div className={styles.sectionHeader}>
                  <SettingOutlined className={styles.sectionIcon} />
                  <Text strong>{t('providers.basicConfig')}</Text>
                </div>

                <Form.Item
                  name='name'
                  label={t('common.name')}
                  rules={[{ required: true, message: t('providers.enterName') }]}
                >
                  <Input
                    placeholder={t('providers.namePlaceholder')}
                    size='large'
                    className={styles.input}
                  />
                </Form.Item>

                <Form.Item
                  name='baseUrl'
                  label={t('providers.baseUrl')}
                  rules={[
                    { required: true, message: t('providers.enterBaseUrl') },
                    { type: 'url', message: t('providers.invalidUrl') },
                  ]}
                >
                  <Input
                    placeholder={t('providers.baseUrlPlaceholder')}
                    size='large'
                    className={styles.input}
                  />
                </Form.Item>

                <Form.Item
                  name='token'
                  label={t('providers.token')}
                  extra={
                    preset?.needsAccountCredential
                      ? t('providers.accountCredentialHint') ||
                        '账户访问凭据，只用于余额查询，不会进入推理请求'
                      : undefined
                  }
                >
                  <Input.Password
                    placeholder={t('providers.tokenPlaceholder')}
                    size='large'
                    className={styles.input}
                  />
                </Form.Item>

                {/* Icon Selector */}
                <Form.Item label={t('providers.icon')}>
                  <div className={styles.iconGrid}>
                    {PRESET_ICONS.map((item) => (
                      <Tooltip key={item.key} title={item.label}>
                        <div
                          className={`${styles.iconItem} ${selectedIcon === item.key ? styles.iconItemActive : ''}`}
                          onClick={() => {
                            setSelectedIcon(item.key)
                            setCustomIconPath(null)
                          }}
                        >
                          <img src={item.icon} alt={item.label} className={styles.iconImg} />
                        </div>
                      </Tooltip>
                    ))}
                    <Tooltip title={t('providers.uploadIcon')}>
                      <div
                        className={`${styles.iconItem} ${selectedIcon === 'custom' ? styles.iconItemActive : ''}`}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        {customIconPath ? (
                          <img
                            src={`file://${customIconPath}`}
                            alt='custom'
                            className={styles.iconImg}
                          />
                        ) : (
                          <UploadOutlined className={styles.uploadIcon} />
                        )}
                      </div>
                    </Tooltip>
                    <input
                      ref={fileInputRef}
                      type='file'
                      accept='image/*'
                      className={styles.hiddenInput}
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) handleIconUpload(file)
                      }}
                    />
                  </div>
                </Form.Item>
              </div>

              {/* Right Column - Additional Info */}
              <div className={styles.formColumn}>
                <div className={styles.sectionHeader}>
                  <LinkOutlined className={styles.sectionIcon} />
                  <Text strong>{t('providers.additionalInfo') || '附加信息'}</Text>
                </div>

                <Form.Item name='website' label={t('providers.website')}>
                  <Input
                    placeholder={t('providers.websitePlaceholder')}
                    prefix={<LinkOutlined className={styles.inputIcon} />}
                    size='large'
                    className={styles.input}
                  />
                </Form.Item>

                <Form.Item name='remark' label={t('providers.remark')}>
                  <TextArea
                    rows={5}
                    placeholder={t('providers.remarkPlaceholder')}
                    className={styles.textarea}
                  />
                </Form.Item>
              </div>
            </div>

            {/* Advanced Settings - Collapsible */}
            <Collapse
              ghost
              activeKey={showAdvanced ? ['advanced'] : []}
              onChange={(keys) => setShowAdvanced(keys.includes('advanced'))}
              className={styles.advancedCollapse}
              items={[
                {
                  key: 'advanced',
                  // Mount the panel even while collapsed. Otherwise its
                  // Form.Items never register, and a save that never opened
                  // the section would drop the preset's query settings instead
                  // of storing them.
                  forceRender: true,
                  label: (
                    <Space>
                      <WalletOutlined />
                      <span>{t('providers.advancedSettings') || '高级设置'}</span>
                    </Space>
                  ),
                  children: (
                    <div className={styles.advancedContent}>
                      <Form.Item
                        name='httpProxy'
                        label={t('providers.httpProxy')}
                        rules={[{ type: 'url', message: t('providers.invalidUrl') }]}
                        extra={t('providers.httpProxyHint')}
                      >
                        <Input
                          allowClear
                          placeholder={t('providers.httpProxyPlaceholder')}
                          size='large'
                          className={styles.input}
                        />
                      </Form.Item>

                      <Form.Item name='walletBalanceType' label={t('providers.balanceType')}>
                        <Select
                          onChange={(value) => setBalanceType(value)}
                          options={[
                            {
                              value: 'none',
                              label: t('providers.balanceTypeNone'),
                            },
                            {
                              value: 'newapi',
                              label: t('providers.balanceTypeNewapi'),
                            },
                            {
                              value: 'custom',
                              label: t('providers.balanceTypeCustom'),
                            },
                            {
                              value: 'deepseek',
                              label: t('providers.balanceTypeDeepseek'),
                            },
                          ]}
                        />
                      </Form.Item>

                      {balanceType === 'newapi' && (
                        <>
                          <div className={styles.hint}>
                            <Text type='secondary'>{t('providers.newapiHint')}</Text>
                          </div>
                          <Form.Item name='walletBalanceUserId' label={t('providers.newapiUserId')}>
                            <Input placeholder={t('providers.newapiUserIdPlaceholder')} />
                          </Form.Item>
                        </>
                      )}

                      {(balanceType === 'custom' || balanceType === 'deepseek') && (
                        <>
                          <Form.Item
                            name='walletBalanceUrl'
                            label={t('providers.balanceUrl')}
                            rules={[
                              {
                                required: balanceType === 'custom',
                                message: t('providers.enterBalanceUrl'),
                              },
                            ]}
                            extra={
                              balanceType === 'deepseek'
                                ? t('providers.deepseekBalanceUrlHint') ||
                                  '留空则使用 DeepSeek 官方余额地址；改为第三方地址时以这里保存的为准'
                                : t('providers.balanceUrlHint')
                            }
                          >
                            <Input placeholder='{baseUrl}/api/user/balance' />
                          </Form.Item>

                          {/* Path and headers only apply to a custom shape;
                              DeepSeek's response is parsed by its own branch. */}
                          {balanceType === 'custom' && (
                            <>
                              <Form.Item
                                name='walletBalancePath'
                                label={t('providers.balancePath')}
                                rules={[
                                  {
                                    required: balanceType === 'custom',
                                    message: t('providers.enterBalancePath'),
                                  },
                                ]}
                                extra={t('providers.balancePathHint')}
                              >
                                <Input placeholder='data.balance' className={styles.monoInput} />
                              </Form.Item>

                              <Form.Item
                                name='walletBalanceHeaders'
                                label={t('providers.customHeaders')}
                                extra={t('providers.curlHint')}
                              >
                                <TextArea
                                  rows={3}
                                  placeholder='{"Authorization": "Bearer YOUR_TOKEN"}'
                                  className={styles.monoInput}
                                />
                              </Form.Item>
                            </>
                          )}
                        </>
                      )}

                      <Form.Item
                        name='requestAdapter'
                        label={t('providers.requestAdapter')}
                        extra={t('providers.requestAdapterHint')}
                      >
                        <Select
                          options={[
                            { value: 'none', label: t('providers.requestAdapterNone') },
                            { value: 'opencode-go', label: 'OpenCode Go' },
                          ]}
                        />
                      </Form.Item>

                      <Form.Item name='usageType' label={t('providers.usageType')}>
                        <Select
                          onChange={(value) => setUsageType(value)}
                          options={[
                            { value: 'none', label: t('providers.usageTypeNone') },
                            { value: 'newapi', label: t('providers.usageTypeNewapi') },
                            { value: 'custom', label: t('providers.usageTypeCustom') },
                          ]}
                        />
                      </Form.Item>

                      {usageType === 'custom' && (
                        <>
                          <Form.Item
                            name='usageUrl'
                            label={t('providers.usageUrl')}
                            extra={t('providers.usageUrlHint')}
                          >
                            <Input placeholder='{baseUrl}/api/usage/token' />
                          </Form.Item>
                          <Form.Item
                            name='usagePath'
                            label={t('providers.usagePath')}
                            extra={t('providers.usagePathHint')}
                          >
                            <TextArea
                              rows={2}
                              placeholder='data.total_available'
                              className={styles.monoInput}
                            />
                          </Form.Item>
                          <Form.Item
                            name='usageHeaders'
                            label={t('providers.usageHeaders')}
                            extra={t('providers.curlHint')}
                          >
                            <TextArea
                              rows={3}
                              placeholder='{"Authorization": "Bearer YOUR_TOKEN"}'
                              className={styles.monoInput}
                            />
                          </Form.Item>
                        </>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          </Form>
        </div>
      </SimpleBar>
    </Modal>
  )
}

/** `opencode-go` and the like are service types this build may not name yet. */
function presetLabel(id: string, t: (key: string) => string): string {
  const key = `providers.presetNames.${id}`
  const translated = t(key)
  return translated === key ? id : translated
}

function normalizeUsageType(value: string | null | undefined): UsageType {
  return USAGE_TYPES.includes(value as UsageType) ? (value as UsageType) : 'none'
}
