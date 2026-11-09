import { getApi } from '../../api'
import { useCallback, useEffect, useState, useRef } from 'react'
import { Modal, Form, Input, Typography, Tooltip, Space, Collapse, Button } from 'antd'
import { useAppMessage } from '../../hooks/useAppMessage'
import {
  UploadOutlined,
  LinkOutlined,
  SettingOutlined,
  WalletOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import type {
  Provider,
  CreateProviderInput,
  ProviderPreset,
  QuerySchemeInfo,
  QueryTestInput,
  QueryTestResult,
} from '@shared/types'
import styles from './ProviderModal.module.css'

import QuerySettingsSection, {
  type QueryScriptValue,
  type QuerySectionTestInput,
} from '../query/QuerySettingsSection'
import {
  PROVIDER_ICON_CHOICES,
  providerIconFilename,
  providerIconSrc,
} from '../../utils/providerIcon'
import { invalidateUploadedIcon, isUploadedIconDeleted } from '../../utils/providerIconCache'
import ProviderIcon from './ProviderIcon'
import { effectiveQuery } from '../../utils/accountQuery'

const { Text } = Typography
const { TextArea } = Input

const isIconChoice = (key: string) => PROVIDER_ICON_CHOICES.some((choice) => choice.key === key)

interface ProviderModalProps {
  open: boolean
  provider: Provider | null
  onClose: () => void
  onSave: (input: CreateProviderInput & { id?: string; isActive?: boolean }) => Promise<void>
}

/**
 * The draft's query state. The script text is the source of truth (it is what
 * gets saved), while the scheme marker is the display tier on top of it.
 */
type AccountQueryValue = QueryScriptValue

/** Byte-identical recognition; `custom` for other text, no scheme when empty. */
function recogniseScheme(script: string, schemes: QuerySchemeInfo[]): string {
  if (!script.trim()) return ''
  return schemes.find((scheme) => scheme.script === script)?.id ?? 'custom'
}

/**
 * The query state a stored row opens with. A stored config decides the switch
 * and the scheme; a pre-config row keeps its implicit enabled intent from the
 * script (the same rule the Rust runtime applies). Recognition is a display
 * tier: the text is never rewritten to fit it (D5).
 */
function providerQueryValue(provider: Provider, schemes: QuerySchemeInfo[]): AccountQueryValue {
  const script = provider.walletBalanceScript ?? ''
  const effective = effectiveQuery(provider.queryConfig, provider.walletBalanceScript)
  const schemeId = provider.queryConfig
    ? provider.queryConfig.schemeId
    : recogniseScheme(script, schemes)
  return { enabled: effective?.enabled ?? false, schemeId, script }
}

export default function ProviderModal({ open, provider, onClose, onSave }: ProviderModalProps) {
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [selectedIcon, setSelectedIcon] = useState<string>('claude')
  const [uploadedIcons, setUploadedIcons] = useState<string[]>([])
  const [customIconPath, setCustomIconPath] = useState<string | null>(null)
  const [deleteIcon, setDeleteIcon] = useState<string | null>(null)
  const [deletingIcon, setDeletingIcon] = useState(false)
  const [iconDeleteError, setIconDeleteError] = useState<string | null>(null)
  const [iconUsedBy, setIconUsedBy] = useState<string[]>([])
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [preset, setPreset] = useState<ProviderPreset | null>(null)

  // The account query: switch + scheme marker + script text. A new provider
  // starts with no scheme and an empty text — the user's choice enables the
  // query, never a prefill (D3).
  const [queryValue, setQueryValue] = useState<AccountQueryValue>({
    enabled: false,
    schemeId: '',
    script: '',
  })
  const [querySchemes, setQuerySchemes] = useState<QuerySchemeInfo[]>([])
  // The offline save-validation failure for the query script, shown in place.
  const [queryError, setQueryError] = useState<string | null>(null)
  // Headers added to this provider's inference traffic, as a JSON object.
  const [requestHeaders, setRequestHeaders] = useState('')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const iconListRevision = useRef(0)
  const schemesRevisionRef = useRef(0)
  // Latest catalogue snapshot for effects that must not depend on its identity.
  const querySchemesRef = useRef<QuerySchemeInfo[]>([])
  // Legacy-row recognition is a display refinement, applied once per open and
  // only while the draft has not been touched by the user.
  const queryTouchedRef = useRef(false)
  const message = useAppMessage()

  useEffect(() => {
    querySchemesRef.current = querySchemes
  }, [querySchemes])

  // The catalogue is code, not user data; it only seeds a new provider.
  useEffect(() => {
    if (!open) return
    const revision = ++iconListRevision.current
    getApi()
      .icon.list()
      .then((result) => {
        if (revision === iconListRevision.current) {
          setUploadedIcons(result.uploaded.filter((icon) => !isUploadedIconDeleted(icon)))
        }
      })
      .catch(() => {
        if (revision === iconListRevision.current) setUploadedIcons([])
      })
    getApi()
      .provider.presets()
      .then(setPresets)
      .catch(() => setPresets([]))
    return () => {
      iconListRevision.current += 1
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let active = true
    const revision = ++schemesRevisionRef.current
    getApi()
      .balance.schemes('account')
      .then((list) => {
        if (active && revision === schemesRevisionRef.current) setQuerySchemes(list)
      })
      .catch(() => {
        // Without the catalogue the stored script still edits and saves the
        // same way; only the named-scheme recognition is unavailable.
        if (active && revision === schemesRevisionRef.current) setQuerySchemes([])
      })
    return () => {
      active = false
    }
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
        setQueryValue(providerQueryValue(provider, querySchemesRef.current))
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
        // Editing opens the advanced section: the request headers and the
        // proxy live there, and having them must not look like not having them.
        setShowAdvanced(true)
      } else {
        form.resetFields()
        form.setFieldsValue({ walletBalanceUserId: undefined })
        setSelectedIcon('claude')
        setCustomIconPath(null)
        setShowAdvanced(false)
        setPreset(null)
        // A new provider starts with the query off, no scheme and no text:
        // the query is a choice the user makes, not a field to read (D3).
        setQueryValue({ enabled: false, schemeId: '', script: '' })
        setRequestHeaders('')
      }
      setQueryError(null)
      queryTouchedRef.current = false
    } else {
      setDeleteIcon(null)
    }
  }, [open, provider, form])

  /**
   * Legacy rows (no stored config) classify by byte-equal recognition once the
   * scheme catalogue is known. Display only: the script text is never touched,
   * and a user-touched draft keeps whatever the user chose.
   */
  useEffect(() => {
    if (!open || !provider || provider.queryConfig || queryTouchedRef.current) return
    const recognised = recogniseScheme(queryValue.script, querySchemes)
    if (recognised === queryValue.schemeId) return
    setQueryValue((previous) => ({ ...previous, schemeId: recognised }))
  }, [open, provider, queryValue, querySchemes])

  /**
   * Fill the form from a template, in full.
   *
   * The template decides every field it governs, including the ones it leaves
   * empty. Carrying the previous template's address forward would point a New
   * API provider at DeepSeek's endpoint and leave the user to notice — the
   * dialog would look like it had applied the template when it had not.
   *
   * The query is only prefilled, never enabled: the preset ships its script
   * text and the recognised scheme marker, and the switch stays where the user
   * set it (D3).
   */
  const applyPreset = (next: ProviderPreset) => {
    setPreset(next)
    const script = next.walletBalanceScript ?? ''
    setQueryValue((previous) => ({
      enabled: previous.enabled,
      schemeId: recogniseScheme(script, querySchemes),
      script,
    }))
    queryTouchedRef.current = false
    setQueryError(null)
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

  const handleQueryChange = (draft: AccountQueryValue) => {
    queryTouchedRef.current = true
    setQueryValue(draft)
  }

  // Draft-test assembly. This callback's identity is the section's
  // input-freshness signal (A6): rebuilding the provider draft (address,
  // proxy, account credentials) invalidates a pending test's result.
  const draftBaseUrl = Form.useWatch('baseUrl', form)
  const draftProxy = Form.useWatch('httpProxy', form)
  const draftToken = Form.useWatch('token', form)
  const draftUserId = Form.useWatch('walletBalanceUserId', form)

  const handleDraftTest = useCallback(
    async (input: QuerySectionTestInput): Promise<QueryTestResult> => {
      const baseUrl = String(draftBaseUrl ?? '').trim()
      const proxy = String(draftProxy ?? '').trim()
      const accessToken = String(draftToken ?? '').trim()
      const userId = String(draftUserId ?? '').trim()
      const draft: QueryTestInput = {
        scope: 'account',
        baseUrl,
        script: input.script,
        // The account scope borrows a saved credential server-side when no
        // draft key is supplied; nothing is persisted either way.
        ...(provider?.id ? { providerId: provider.id } : {}),
        ...(proxy ? { httpProxy: proxy } : {}),
        // The access token and the user id are the account credentials the
        // provider stores; a key value is never typed here.
        ...(accessToken ? { accessToken } : {}),
        ...(userId ? { userId } : {}),
      }
      return getApi().balance.testDraft(draft)
    },
    [provider?.id, draftBaseUrl, draftProxy, draftToken, draftUserId],
  )

  const handleSubmit = async () => {
    try {
      setLoading(true)
      const values = await form.validateFields()

      // A script is text until something evaluates it, so it is evaluated here
      // — without sending anything, and without a credential — rather than
      // left to fail the next time the balance is refreshed.
      const script = queryValue.script.trim()
      if (script) {
        try {
          await getApi().balance.checkScript(script, values.baseUrl?.trim() ?? '')
        } catch (error) {
          setQueryError(String(error))
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
        // The script outlives the switch: a parked (off) query keeps its text,
        // and enabling again runs exactly what was there (D4).
        walletBalanceScript: provider ? script : script || undefined,
        requestHeaders: requestHeaders.trim() || undefined,
        // The account query is the script now; there is no service kind left
        // to record, and these columns are what the migration reads.
        walletBalanceType: script ? 'custom' : 'none',
        queryConfig: {
          enabled: queryValue.enabled,
          schemeId: queryValue.schemeId || 'custom',
        },
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
      iconListRevision.current += 1
      setUploadedIcons((icons) => [...icons, path])
      setCustomIconPath(path)
      setSelectedIcon('custom')
    } catch {
      message.error(t('messages.error'))
    }
  }

  const handleIconDelete = async () => {
    if (!deleteIcon || deletingIcon) return
    const filename = deleteIcon
    setDeletingIcon(true)
    setIconDeleteError(null)
    try {
      const result = await getApi().icon.delete(filename)
      if (!result.deleted) {
        setIconUsedBy(result.usedBy.map((item) => item.name))
        return
      }
      iconListRevision.current += 1
      invalidateUploadedIcon(filename)
      setUploadedIcons((icons) => icons.filter((icon) => providerIconFilename(icon) !== filename))
      if (providerIconFilename(customIconPath) === filename) {
        setCustomIconPath(null)
        setSelectedIcon('')
      }
      setDeleteIcon(null)
      message.success(t('providers.iconDeleted'))
    } catch {
      setIconDeleteError(t('providers.iconDeleteFailed'))
    } finally {
      setDeletingIcon(false)
    }
  }

  // Which credentials the current query asks for: the chosen scheme's list,
  // plus any variable a hand-written script still names.
  const selectedQueryScheme = querySchemes.find((scheme) => scheme.id === queryValue.schemeId)
  const queriesToken =
    selectedQueryScheme?.credentialRequirements.includes('accessToken') ||
    queryValue.script.includes('{{accessToken}}')
  const queriesUserId =
    selectedQueryScheme?.credentialRequirements.includes('userId') ||
    queryValue.script.includes('{{userId}}')

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
                  <Text strong>{t('providers.preset')}</Text>
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
                        <button
                          type='button'
                          aria-label={item.label}
                          aria-pressed={selectedIcon === item.key}
                          className={`${styles.iconItem} ${selectedIcon === item.key ? styles.iconItemActive : ''}`}
                          onClick={() => {
                            setSelectedIcon(item.key)
                            setCustomIconPath(null)
                          }}
                        >
                          <img src={item.src} alt={item.label} className={styles.iconImg} />
                        </button>
                      </Tooltip>
                    ))}
                    {Array.from(
                      new Set(
                        [...uploadedIcons, ...(customIconPath ? [customIconPath] : [])]
                          .map(providerIconFilename)
                          .filter(
                            (icon): icon is string =>
                              Boolean(icon) && !isUploadedIconDeleted(icon!),
                          ),
                      ),
                    ).map((icon) => (
                      <div className={styles.uploadedIcon} key={icon}>
                        <button
                          type='button'
                          aria-label={icon}
                          aria-pressed={
                            selectedIcon === 'custom' &&
                            providerIconFilename(customIconPath) === icon
                          }
                          className={`${styles.iconItem} ${selectedIcon === 'custom' && providerIconFilename(customIconPath) === icon ? styles.iconItemActive : ''}`}
                          onClick={() => {
                            setSelectedIcon('custom')
                            setCustomIconPath(icon)
                          }}
                        >
                          <ProviderIcon icon={icon} name={icon} className={styles.iconImg} />
                        </button>
                        <Tooltip title={t('providers.deleteIcon')}>
                          <Button
                            type='text'
                            size='small'
                            danger
                            icon={<DeleteOutlined />}
                            className={styles.deleteIcon}
                            aria-label={`${t('providers.deleteIcon')}: ${icon}`}
                            onClick={() => {
                              setDeleteIcon(icon)
                              setIconDeleteError(null)
                              setIconUsedBy([])
                            }}
                          />
                        </Tooltip>
                      </div>
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
                  <Text strong>{t('providers.additionalInfo')}</Text>
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

            {/* The account query has its own dedicated section above the
                advanced settings: the switch, the scheme choice and the draft
                test are the everyday path, and the code stays behind an
                explicit custom entry. */}
            <div className={styles.queryBlock}>
              <div className={styles.sectionHeader}>
                <WalletOutlined className={styles.sectionIcon} />
                <Text strong>{t('providers.accountQuerySection')}</Text>
              </div>
              <QuerySettingsSection
                scope='account'
                value={queryValue}
                onChange={handleQueryChange}
                testVisible
                onDraftTest={handleDraftTest}
                accountCredentialHint={t('providers.accountCredentialHint')}
              />
              {/* Only the credentials the chosen query actually asks for;
                  these live beside the choice they answer. */}
              {queriesToken && (
                <Form.Item
                  name='token'
                  label={t('providers.token')}
                  extra={t('providers.accountCredentialHint')}
                  className={styles.queryCredential}
                >
                  <Input.Password
                    placeholder={t('providers.tokenPlaceholder')}
                    size='large'
                    className={styles.input}
                  />
                </Form.Item>
              )}
              {queriesUserId && (
                <Form.Item
                  name='walletBalanceUserId'
                  label={t('providers.userId')}
                  className={styles.queryCredential}
                >
                  <Input placeholder={t('providers.userIdPlaceholder')} />
                </Form.Item>
              )}
              {queryError && (
                <Text type='danger' role='alert' className={styles.queryNote}>
                  {queryError}
                </Text>
              )}
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
                      <span>{t('providers.advancedSettings')}</span>
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
                          <Text strong>{t('providers.requestHeaders')}</Text>
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
                          {t('providers.requestHeadersHint')}
                        </Text>
                      </div>
                    </div>
                  ),
                },
              ]}
            />
          </Form>
        </div>
      </SimpleBar>
      <Modal
        open={open && deleteIcon !== null}
        title={t('providers.deleteIconConfirm')}
        onOk={() => void handleIconDelete()}
        onCancel={() => {
          if (!deletingIcon) setDeleteIcon(null)
        }}
        okText={t('common.delete')}
        cancelText={t('common.cancel')}
        okButtonProps={{ danger: true, disabled: iconUsedBy.length > 0 }}
        cancelButtonProps={{ disabled: deletingIcon }}
        confirmLoading={deletingIcon}
        closable={!deletingIcon}
        keyboard={!deletingIcon}
        maskClosable={!deletingIcon}
        destroyOnHidden
      >
        <p>{deleteIcon}</p>
        <p>{t('providers.deleteIconIrreversible')}</p>
        {iconUsedBy.length > 0 && (
          <div role='alert'>
            <p>{t('providers.iconInUse', { names: iconUsedBy.join(', ') })}</p>
            <p>{t('providers.iconInUseHint')}</p>
          </div>
        )}
        {iconDeleteError && <p role='alert'>{iconDeleteError}</p>}
      </Modal>
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
