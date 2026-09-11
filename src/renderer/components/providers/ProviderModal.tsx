import { getApi } from '../../api'
import { useEffect, useState, useRef } from 'react'
import { Modal, Form, Input, Typography, Tooltip, Space, Collapse } from 'antd'
import { useAppMessage } from '../../hooks/useAppMessage'
import { UploadOutlined, LinkOutlined, SettingOutlined, WalletOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import type { Provider, CreateProviderInput, ProviderPreset } from '@shared/types'
import styles from './ProviderModal.module.css'

import { PROVIDER_ICON_CHOICES, providerIconSrc } from '../../utils/providerIcon'
import { STARTER_ACCOUNT_SCRIPT } from '../../utils/providerQueryDefaults'

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
  const [uploadedIcons, setUploadedIcons] = useState<string[]>([])
  const [customIconPath, setCustomIconPath] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [preset, setPreset] = useState<ProviderPreset | null>(null)

  // The account query, exactly as the user wrote it. Presets fill it in; the
  // editor only ever changes the text.
  const [accountScript, setAccountScript] = useState(STARTER_ACCOUNT_SCRIPT)
  const [accountError, setAccountError] = useState<string | null>(null)
  // Headers added to this provider's inference traffic, as a JSON object.
  const [requestHeaders, setRequestHeaders] = useState('')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const message = useAppMessage()

  // The catalogue is code, not user data; it only seeds a new provider.
  useEffect(() => {
    if (!open) return
    getApi()
      .icon.list()
      .then((result) => setUploadedIcons(result.uploaded))
      .catch(() => setUploadedIcons([]))
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
        setAccountScript(provider.walletBalanceScript ?? '')
        setRequestHeaders(formatHeaders(provider.requestHeaders))
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
        setShowAdvanced(Boolean(provider.walletBalanceScript?.trim()))
      } else {
        form.resetFields()
        form.setFieldsValue({ walletBalanceUserId: undefined })
        setSelectedIcon('claude')
        setCustomIconPath(null)
        setShowAdvanced(false)
        setPreset(null)
        // A new provider starts on a script that shows the shape: the query is
        // a field to complete, not a switch to find. Picking a template writes
        // that service's script in its place.
        setAccountScript(STARTER_ACCOUNT_SCRIPT)
        setRequestHeaders('')
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
    // A template that ships no script is the blank one, which leaves the
    // hand-written starter in place rather than switching the query off.
    setAccountScript(next.walletBalanceScript ?? STARTER_ACCOUNT_SCRIPT)
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

  const handleSubmit = async () => {
    try {
      setLoading(true)
      const values = await form.validateFields()

      // A script is text until something evaluates it, so it is evaluated here
      // — without sending anything, and without a credential — rather than
      // left to fail the next time the balance is refreshed.
      const script = accountScript.trim()
      if (script) {
        try {
          await getApi().balance.checkScript(script, values.baseUrl?.trim() ?? '')
        } catch (error) {
          setAccountError(String(error))
          return
        }
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
        walletBalanceScript: provider ? script : script || undefined,
        requestHeaders: requestHeaders.trim() || undefined,
        walletBalanceUserId: values.walletBalanceUserId?.trim(),
        // The account query is the script now; there is no service kind left
        // to record, and these columns are what the migration reads.
        walletBalanceType: script ? 'custom' : 'none',
        usageType: 'none',
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
      setUploadedIcons((icons) => [...icons, path])
      setCustomIconPath(path)
      setSelectedIcon('custom')
    } catch {
      message.error(t('messages.error'))
    }
  }

  // Which credentials the script actually names. Asking for a token nothing
  // references would collect a secret for nothing.
  const queriesToken = accountScript.includes('{{accessToken}}')
  const queriesUserId = accountScript.includes('{{userId}}')

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
                    {Array.from(
                      new Set([...uploadedIcons, ...(customIconPath ? [customIconPath] : [])]),
                    ).map((icon) => (
                      <button
                        type='button'
                        key={icon}
                        aria-label={icon}
                        aria-pressed={selectedIcon === 'custom' && customIconPath === icon}
                        className={`${styles.iconItem} ${selectedIcon === 'custom' && customIconPath === icon ? styles.iconItemActive : ''}`}
                        onClick={() => {
                          setSelectedIcon('custom')
                          setCustomIconPath(icon)
                        }}
                      >
                        <img
                          src={providerIconSrc(icon) ?? undefined}
                          alt={icon}
                          className={styles.iconImg}
                        />
                      </button>
                    ))}
                    <Tooltip title={t('providers.uploadIcon')}>
                      <button
                        type='button'
                        className={styles.iconItem}
                        aria-label={t('providers.uploadIcon')}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <UploadOutlined className={styles.uploadIcon} />
                      </button>
                    </Tooltip>
                    <input
                      ref={fileInputRef}
                      type='file'
                      accept='.png,.jpg,.jpeg,.webp,.gif,.svg,.ico'
                      className={styles.hiddenInput}
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) void handleIconUpload(file)
                        e.target.value = ''
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

                      <div className={styles.queryBlock}>
                        <div className={styles.queryHeader}>
                          <Text strong>{t('providers.accountQuery') || '账户余额与用量'}</Text>
                        </div>
                        <TextArea
                          value={accountScript}
                          onChange={(event) => {
                            setAccountScript(event.target.value)
                            if (accountError) setAccountError(null)
                          }}
                          autoSize={{ minRows: 8, maxRows: 20 }}
                          spellCheck={false}
                          className={`${styles.queryEditor} ${accountError ? styles.queryEditorError : ''}`}
                          placeholder={
                            t('providers.scriptPlaceholder') || '{ request: ..., extractor: ... }'
                          }
                        />
                        <Text type='secondary' className={styles.queryNote}>
                          {t('providers.scriptVars') ||
                            '发送时替换：{{baseUrl}} 供应商地址，{{apiKey}} 推理密钥，{{accessToken}} 访问令牌，{{userId}} 用户 ID'}
                        </Text>
                        <Text type='secondary' className={styles.queryNote}>
                          {t('providers.scriptFields') ||
                            'extractor 返回标准字段：remaining / total / used / unit / isUnlimited / windows / isValid / invalidMessage'}
                        </Text>
                        {accountError && (
                          <Text type='danger' className={styles.queryNote}>
                            {accountError}
                          </Text>
                        )}
                      </div>

                      <div className={styles.queryBlock}>
                        <div className={styles.queryHeader}>
                          <Text strong>{t('providers.requestHeaders') || '请求头'}</Text>
                        </div>
                        <TextArea
                          value={requestHeaders}
                          onChange={(event) => setRequestHeaders(event.target.value)}
                          autoSize={{ minRows: 2, maxRows: 8 }}
                          spellCheck={false}
                          className={styles.queryEditor}
                          placeholder={'{\n  "X-Relay": "cc-use"\n}'}
                        />
                        <Text type='secondary' className={styles.queryNote}>
                          {t('providers.requestHeadersHint') ||
                            '加在这家供应商的推理请求上；客户端已发的同名请求头不会被覆盖。支持 {{baseUrl}}'}
                        </Text>
                      </div>

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

/** Pretty-print the stored header object for editing. */
function formatHeaders(raw: string | null | undefined): string {
  const text = raw?.trim()
  if (!text) return ''
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    // A value that is not JSON came from somewhere else; show it as-is rather
    // than emptying the field and losing it on the next save.
    return text
  }
}

/** `opencode-go` and the like are service types this build may not name yet. */
function presetLabel(id: string, t: (key: string) => string): string {
  const key = `providers.presetNames.${id}`
  const translated = t(key)
  return translated === key ? id : translated
}
