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
  ACCOUNT_RULES,
  accountRequestForPreset,
  accountRequestForRule,
  accountRuleOf,
  accountStorageForRule,
  requestSlotForRule,
  ruleHasNoRequest,
  type AccountRule,
  type QueryRequestDefault,
} from '../../utils/providerQueryDefaults'

const { Text } = Typography
const { TextArea } = Input

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

  // The account query: which rule reads it, and the request that carries it.
  // Held as text because that is how it is edited; the stored columns are read
  // and written through the block grammar.
  const [accountRule, setAccountRule] = useState<AccountRule>('custom')
  const [accountBlock, setAccountBlock] = useState('')
  const [accountError, setAccountError] = useState<string | null>(null)

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
        const rule = accountRuleOf(provider)
        setAccountRule(rule)
        setAccountBlock(blockForStoredRequest(provider, rule))
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
        setShowAdvanced(rule !== 'none')
      } else {
        form.resetFields()
        form.setFieldsValue({ walletBalanceUserId: undefined })
        setSelectedIcon('claude')
        setCustomIconPath(null)
        setShowAdvanced(false)
        setPreset(null)
        // A new provider starts on the hand-written rule with its template
        // filled in: the account query is a field to complete, not a switch
        // to find. Picking a template still moves it to that service's rule.
        setAccountRule('custom')
        setAccountBlock(blockFromDefault(accountRequestForRule('custom', [])))
      }
      setAccountError(null)
    }
  }, [open, provider, form])

  /**
   * Fill the form from a template, in full.
   *
   * The template decides every field it governs, including the ones it leaves
   * empty. Carrying the previous template's address forward would point a New
   * API provider at DeepSeek's endpoint and leave the user to notice — the
   * dialog would look like it had applied the template when it had not.
   */
  const applyPreset = (next: ProviderPreset) => {
    setPreset(next)
    // The blank template is the hand-written rule, so it lands where a new
    // provider already starts rather than switching the query off.
    const rule: AccountRule = next.id === 'custom' ? 'custom' : accountRuleOf(next)
    setAccountRule(rule)
    setAccountBlock(
      rule === 'custom'
        ? blockFromDefault(accountRequestForRule('custom', presets))
        : blockFromDefault(accountRequestForPreset(next)),
    )
    setAccountError(null)
    form.setFieldsValue({
      name: next.defaultName,
      baseUrl: next.baseUrl,
      website: '',
    })
    // A template that names a mark selects it; the blank one names none, and
    // leaving the previous choice standing would claim a vendor it never named.
    setSelectedIcon(isIconChoice(next.icon) ? next.icon : '')
    setCustomIconPath(null)
  }

  /**
   * Switch the rule the account query is read with, and restate its request.
   *
   * Changing the rule replaces the block with that rule's own request: a URL
   * written for one service means nothing to another, and carrying it over
   * would send it to a place it was never meant for.
   */
  const changeAccountRule = (rule: AccountRule) => {
    setAccountRule(rule)
    setAccountBlock(blockFromDefault(accountRequestForRule(rule, presets)))
    setAccountError(null)
  }

  const handleSubmit = async () => {
    try {
      setLoading(true)
      const values = await form.validateFields()

      const account = parseRequestBlock(accountBlock)
      if (!account.ok) {
        setAccountError(account.error)
        return
      }
      // A custom rule is the user's own definition, so it has nothing to fall
      // back on: without an address there is no query at all.
      if (accountRule === 'custom' && !account.request.url) {
        setAccountError(t('providers.queryNeedsUrl') || '自定义规则必须填写请求地址')
        return
      }

      // The single choice is written back onto the two columns the daemon
      // dispatches on, and the request onto whichever pair its rule uses.
      const slot = requestSlotForRule(accountRule)
      const storage = accountStorageForRule(accountRule)
      const requestUrl = account.request.url || undefined
      const requestPath = account.request.path || undefined
      const requestHeaders = headersToStoredValue(account.request.headers) || undefined
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
        walletBalanceType: storage.walletBalanceType,
        walletBalanceUrl: slot === 'balance' ? requestUrl : undefined,
        walletBalancePath: slot === 'balance' ? requestPath : undefined,
        walletBalanceHeaders: slot === 'balance' ? requestHeaders : undefined,
        walletBalanceUserId: values.walletBalanceUserId?.trim(),
        usageType: storage.usageType,
        usageUrl: slot === 'usage' ? requestUrl : undefined,
        usagePath: slot === 'usage' ? requestPath : undefined,
        usageHeaders: slot === 'usage' ? requestHeaders : undefined,
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

  // Which credentials the request actually names. Asking for a token no request
  // mentions would collect a secret for nothing.
  const queriesToken = accountBlock.includes('{token}')
  const queriesUserId = accountBlock.includes('{userId}')
  // Which stored columns the request belongs in, so the unreadable-headers
  // warning looks at the pair this rule actually writes.
  const slot = requestSlotForRule(accountRule)

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
                        title={t('providers.accountQuery') || '账户余额与用量'}
                        rule={accountRule}
                        ruleOptions={ACCOUNT_RULES.map((rule) => ({
                          value: rule,
                          label: t(`providers.accountRules.${rule}`),
                        }))}
                        onRuleChange={(value) => changeAccountRule(value as AccountRule)}
                        onRestore={() => changeAccountRule(accountRule)}
                        block={accountBlock}
                        onBlockChange={(value) => {
                          setAccountBlock(value)
                          if (accountError) setAccountError(null)
                        }}
                        error={accountError}
                        unreadableHeaders={isStoredHeadersUnreadable(
                          slot === 'usage'
                            ? provider?.usageHeaders
                            : provider?.walletBalanceHeaders,
                        )}
                      />

                      {/* Only the credentials the request actually names. */}
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

/** The provider's stored request, read from whichever columns its rule uses. */
function blockForStoredRequest(provider: Provider, rule: AccountRule): string {
  return requestSlotForRule(rule) === 'usage'
    ? blockFromStored(provider.usageUrl, provider.usageHeaders, provider.usagePath)
    : blockFromStored(
        provider.walletBalanceUrl,
        provider.walletBalanceHeaders,
        provider.walletBalancePath,
      )
}

function blockFromDefault(fallback: QueryRequestDefault): string {
  return formatRequestBlock({
    url: fallback.url,
    headers: storedValueToHeaders(fallback.headers),
    path: fallback.path,
  })
}
