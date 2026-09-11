import { getApi } from '../../api'
import { useEffect, useState, useRef } from 'react'
import { Modal, Form, Input, Select, Typography, Tooltip, Space, Collapse, Button } from 'antd'
import { useAppMessage } from '../../hooks/useAppMessage'
import {
  UploadOutlined,
  LinkOutlined,
  SettingOutlined,
  WalletOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import type { Provider, CreateProviderInput, ProviderPreset } from '@shared/types'
import styles from './ProviderModal.module.css'

import { PROVIDER_ICON_CHOICES, providerIconSrc } from '../../utils/providerIcon'
import {
  formatRequestBlock,
  headersToStoredValue,
  isStoredHeadersUnreadable,
  parseRequestBlock,
  storedValueToHeaders,
} from '../../utils/providerRequestBlock'
import {
  balanceRequestForRule,
  ruleHasNoRequest,
  usageRequestForRule,
  type QueryRequestDefault,
} from '../../utils/providerQueryDefaults'

const { Text } = Typography
const { TextArea } = Input

const BALANCE_RULES = ['none', 'newapi', 'custom', 'deepseek'] as const
type BalanceRule = (typeof BALANCE_RULES)[number]

const USAGE_RULES = ['none', 'newapi', 'custom', 'opencode-go'] as const
type UsageRule = (typeof USAGE_RULES)[number]

const isIconChoice = (key: string) => PROVIDER_ICON_CHOICES.some((choice) => choice.key === key)

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
  const [selectedIcon, setSelectedIcon] = useState<string>('claude')
  const [customIconPath, setCustomIconPath] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [preset, setPreset] = useState<ProviderPreset | null>(null)

  // The two queries a provider can run, each as its rule plus the request that
  // rule sends. They are held as text because that is how they are edited; the
  // stored columns are read and written through the block grammar.
  const [balanceRule, setBalanceRule] = useState<BalanceRule>('none')
  const [balanceBlock, setBalanceBlock] = useState('')
  const [balanceError, setBalanceError] = useState<string | null>(null)
  const [usageRule, setUsageRule] = useState<UsageRule>('none')
  const [usageBlock, setUsageBlock] = useState('')
  const [usageError, setUsageError] = useState<string | null>(null)

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
          walletBalanceUserId: provider.walletBalanceUserId,
        })
        setPreset(null)
        setBalanceRule(asBalanceRule(provider.walletBalanceType))
        setBalanceBlock(
          blockFromStored(
            provider.walletBalanceUrl,
            provider.walletBalanceHeaders,
            provider.walletBalancePath,
          ),
        )
        setUsageRule(asUsageRule(provider.usageType))
        setUsageBlock(blockFromStored(provider.usageUrl, provider.usageHeaders, provider.usagePath))
        if (provider.icon && isIconChoice(provider.icon)) {
          setSelectedIcon(provider.icon)
          setCustomIconPath(null)
        } else if (providerIconSrc(provider.icon)) {
          // An uploaded file. `custom` is not one: it marks "no mark chosen",
          // and reading it as a path produced a `file://custom` broken image.
          setSelectedIcon('custom')
          setCustomIconPath(provider.icon!)
        } else {
          setSelectedIcon('')
          setCustomIconPath(null)
        }
        // Show advanced if this provider actually queries something.
        setShowAdvanced(
          provider.walletBalanceType !== 'none' || provider.usageType !== 'none',
        )
      } else {
        form.resetFields()
        form.setFieldsValue({ walletBalanceUserId: undefined })
        setSelectedIcon('claude')
        setCustomIconPath(null)
        setShowAdvanced(false)
        setPreset(null)
        setBalanceRule('none')
        setBalanceBlock('')
        setUsageRule('none')
        setUsageBlock('')
      }
      setBalanceError(null)
      setUsageError(null)
    }
  }, [open, provider, form])

  /**
   * Fill the form from a template. Everything the template supplies is written
   * into the form, so the user sees exactly what will be saved and can edit any
   * of it — nothing is applied behind the form's back.
   */
  const applyPreset = (next: ProviderPreset) => {
    setPreset(next)
    setBalanceRule(asBalanceRule(next.walletBalanceType))
    setBalanceBlock(
      blockFromStored(next.walletBalanceUrl, next.walletBalanceHeaders, undefined),
    )
    setUsageRule(asUsageRule(next.usageType))
    setUsageBlock(blockFromStored(next.usageUrl, next.usageHeaders, undefined))
    setBalanceError(null)
    setUsageError(null)
    form.setFieldsValue({
      name: next.defaultName || form.getFieldValue('name') || '',
      baseUrl: next.baseUrl || form.getFieldValue('baseUrl') || '',
    })
    // A template that names a mark selects it; the blank one names none, and
    // leaving the previous choice standing would claim a vendor it never named.
    setSelectedIcon(isIconChoice(next.icon) ? next.icon : '')
    setCustomIconPath(null)
  }

  /**
   * Switch the rule a query is read with, and restate its request.
   *
   * Changing the rule replaces the block with that rule's own request: a URL
   * written for one service means nothing to another, and carrying it over
   * would send it to a place it was never meant for.
   */
  const changeBalanceRule = (rule: BalanceRule) => {
    setBalanceRule(rule)
    setBalanceBlock(blockFromDefault(balanceRequestForRule(rule, presets)))
    setBalanceError(null)
  }

  const changeUsageRule = (rule: UsageRule) => {
    setUsageRule(rule)
    setUsageBlock(blockFromDefault(usageRequestForRule(rule, presets)))
    setUsageError(null)
  }

  const handleSubmit = async () => {
    try {
      setLoading(true)
      const values = await form.validateFields()

      const balance = parseRequestBlock(balanceBlock)
      if (!balance.ok) {
        setBalanceError(balance.error)
        return
      }
      const usage = parseRequestBlock(usageBlock)
      if (!usage.ok) {
        setUsageError(usage.error)
        return
      }
      // A custom rule is the user's own definition, so it has nothing to fall
      // back on: without an address there is no query at all.
      if (balanceRule === 'custom' && !balance.request.url) {
        setBalanceError(t('providers.queryNeedsUrl') || '自定义规则必须填写请求地址')
        return
      }
      if (usageRule === 'custom' && !usage.request.url) {
        setUsageError(t('providers.queryNeedsUrl') || '自定义规则必须填写请求地址')
        return
      }

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
        walletBalanceType: balanceRule,
        walletBalanceUrl: balance.request.url || undefined,
        walletBalancePath: balance.request.path || undefined,
        walletBalanceHeaders: headersToStoredValue(balance.request.headers) || undefined,
        walletBalanceUserId: values.walletBalanceUserId?.trim(),
        usageType: usageRule,
        usageUrl: usage.request.url || undefined,
        usagePath: usage.request.path || undefined,
        usageHeaders: headersToStoredValue(usage.request.headers) || undefined,
        requestAdapter: provider ? provider.requestAdapter : (preset?.requestAdapter ?? 'none'),
        // The template's key defaults travel with the provider. Editing the
        // address or the icon never silently drops them.
        presetId: provider ? provider.presetId : (preset?.id ?? 'custom'),
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

  // Which credentials the queries actually name. Asking for a token no request
  // mentions would collect a secret for nothing.
  const queriesText = `${balanceBlock}\n${usageBlock}`
  const queriesToken = queriesText.includes('{token}')
  const queriesUserId = queriesText.includes('{userId}')

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

                {/* Icon Selector */}
                <Form.Item label={t('providers.icon')}>
                  <div className={styles.iconGrid}>
                    {PROVIDER_ICON_CHOICES.map((item) => (
                      <Tooltip key={item.key} title={item.label}>
                        <div
                          className={`${styles.iconItem} ${selectedIcon === item.key ? styles.iconItemActive : ''}`}
                          onClick={() => {
                            setSelectedIcon(item.key)
                            setCustomIconPath(null)
                          }}
                        >
                          <img src={item.src} alt={item.label} className={styles.iconImg} />
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
                  // Mount the panel even while collapsed. Otherwise its inputs
                  // never register, and a save that never opened the section
                  // would store an empty request over the preset's.
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

                      <QueryBlock
                        title={t('providers.balanceQuery') || '账户余额'}
                        rule={balanceRule}
                        ruleOptions={[
                          { value: 'none', label: t('providers.ruleNone') || '不查询' },
                          { value: 'newapi', label: 'NewAPI' },
                          { value: 'deepseek', label: 'DeepSeek' },
                          { value: 'custom', label: t('providers.ruleCustom') || '自定义' },
                        ]}
                        onRuleChange={(value) => changeBalanceRule(value as BalanceRule)}
                        onRestore={() => changeBalanceRule(balanceRule)}
                        block={balanceBlock}
                        onBlockChange={(value) => {
                          setBalanceBlock(value)
                          if (balanceError) setBalanceError(null)
                        }}
                        error={balanceError}
                        unreadableHeaders={isStoredHeadersUnreadable(
                          provider?.walletBalanceHeaders,
                        )}
                      />

                      <QueryBlock
                        title={t('providers.usageQuery') || '账号用量'}
                        rule={usageRule}
                        ruleOptions={[
                          { value: 'none', label: t('providers.ruleNone') || '不查询' },
                          { value: 'newapi', label: 'NewAPI' },
                          { value: 'opencode-go', label: 'OpenCode Go' },
                          { value: 'custom', label: t('providers.ruleCustom') || '自定义' },
                        ]}
                        onRuleChange={(value) => changeUsageRule(value as UsageRule)}
                        onRestore={() => changeUsageRule(usageRule)}
                        block={usageBlock}
                        onBlockChange={(value) => {
                          setUsageBlock(value)
                          if (usageError) setUsageError(null)
                        }}
                        error={usageError}
                        unreadableHeaders={isStoredHeadersUnreadable(provider?.usageHeaders)}
                      />

                      {/* Only the credentials the requests actually name. */}
                      {queriesToken && (
                        <Form.Item
                          name='token'
                          label={t('providers.token')}
                          extra={t('providers.accountCredentialHint')}
                        >
                          <Input.Password
                            placeholder={t('providers.tokenPlaceholder')}
                            size='large'
                            className={styles.input}
                          />
                        </Form.Item>
                      )}
                      {queriesUserId && (
                        <Form.Item name='walletBalanceUserId' label={t('providers.userId')}>
                          <Input placeholder={t('providers.userIdPlaceholder')} />
                        </Form.Item>
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

/**
 * One query, shown as the rule that reads it and the request that carries it.
 *
 * The two are deliberately separate controls: the same request can be read as
 * New API quota or as a DeepSeek balance object, so editing the address must
 * not quietly change how the answer is interpreted.
 */
function QueryBlock({
  title,
  rule,
  ruleOptions,
  onRuleChange,
  onRestore,
  block,
  onBlockChange,
  error,
  unreadableHeaders,
}: {
  title: string
  rule: string
  ruleOptions: { value: string; label: string }[]
  onRuleChange: (value: string) => void
  onRestore: () => void
  block: string
  onBlockChange: (value: string) => void
  error: string | null
  unreadableHeaders: boolean
}) {
  const { t } = useTranslation()
  const sendsNothing = ruleHasNoRequest(rule)

  return (
    <div className={styles.queryBlock}>
      <div className={styles.queryHeader}>
        <Text strong>{title}</Text>
        <Space size={8}>
          <Select
            size='small'
            value={rule}
            onChange={onRuleChange}
            options={ruleOptions}
            style={{ minWidth: 132 }}
          />
          <Tooltip title={t('providers.restoreDefault') || '恢复默认'}>
            <Button size='small' icon={<UndoOutlined />} onClick={onRestore} />
          </Tooltip>
        </Space>
      </div>

      {sendsNothing ? (
        <Text type='secondary' className={styles.queryNote}>
          {t(`providers.ruleNote.${rule}`)}
        </Text>
      ) : (
        <>
          <TextArea
            value={block}
            onChange={(event) => onBlockChange(event.target.value)}
            autoSize={{ minRows: 3, maxRows: 10 }}
            spellCheck={false}
            className={`${styles.queryEditor} ${error ? styles.queryEditorError : ''}`}
            placeholder={t('providers.queryPlaceholder') || 'GET {baseUrl}/api/...'}
          />
          <Text type='secondary' className={styles.queryNote}>
            {t('providers.queryVars') ||
              '发送时替换：{baseUrl} 供应商地址，{key} 推理密钥，{token} 访问令牌，{userId} 用户 ID'}
          </Text>
          {unreadableHeaders && (
            <Text type='warning' className={styles.queryNote}>
              {t('providers.queryHeadersUnreadable') ||
                '原有的请求头无法解析，已显示为空；保存会用这里的内容替换它'}
            </Text>
          )}
        </>
      )}

      {error && (
        <Text type='danger' className={styles.queryNote}>
          {error}
        </Text>
      )}
    </div>
  )
}

/** `opencode-go` and the like are service types this build may not name yet. */
function presetLabel(id: string, t: (key: string) => string): string {
  const key = `providers.presetNames.${id}`
  const translated = t(key)
  return translated === key ? id : translated
}

function asBalanceRule(value: string | null | undefined): BalanceRule {
  return BALANCE_RULES.includes(value as BalanceRule) ? (value as BalanceRule) : 'none'
}

function asUsageRule(value: string | null | undefined): UsageRule {
  return USAGE_RULES.includes(value as UsageRule) ? (value as UsageRule) : 'none'
}

/** Render stored query columns as the editable block. */
function blockFromStored(
  url: string | null | undefined,
  headers: string | null | undefined,
  path: string | null | undefined,
): string {
  return formatRequestBlock({
    url: url ?? '',
    headers: storedValueToHeaders(headers),
    path: path ?? '',
  })
}

function blockFromDefault(fallback: QueryRequestDefault): string {
  return formatRequestBlock({
    url: fallback.url,
    headers: storedValueToHeaders(fallback.headers),
    path: fallback.path,
  })
}
