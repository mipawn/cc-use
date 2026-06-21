import { useState } from 'react'
import { Modal, Form, Input, Select, Space, Tag, Tooltip, Typography } from 'antd'
import { useAppMessage } from '../../hooks/useAppMessage'
import { useTranslation } from 'react-i18next'
import type { ProviderType } from '@shared/types'
import { PROVIDER_PRESETS, type ProviderPreset } from '@shared/presets'
import { resolvePresetIcon } from './presetIcons'

const { Text } = Typography

interface QuickAddModalProps {
  open: boolean
  onClose: () => void
  onSave: (data: {
    providerName: string
    providerBaseUrl: string
    providerIcon: string
    keyAlias?: string
    keyValue: string
    keyType: ProviderType[]
    // v3.2.0: 格式转换
    apiFormat?: string
    transformEnabled?: boolean
  }) => Promise<void>
}

export default function QuickAddModal({ open, onClose, onSave }: QuickAddModalProps) {
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [selectedIcon, setSelectedIcon] = useState('claude')
  const [activePresetId, setActivePresetId] = useState<string | null>(null)
  const message = useAppMessage()

  // Apply a preset: fill name/baseUrl/icon and set the key type to the
  // preset's primary type. The user can still override anything below.
  const applyPreset = (preset: ProviderPreset) => {
    form.setFieldsValue({
      providerName: preset.name,
      providerBaseUrl: preset.baseUrl,
      keyType: [preset.providerType],
      apiFormat: preset.apiFormat,
      transformEnabled: preset.transformEnabled,
    })
    setSelectedIcon(preset.icon)
    setActivePresetId(preset.id)
    message.success(t('providers.presetApplied', { name: preset.name }))
  }

  const handleSubmit = async () => {
    try {
      setLoading(true)
      const values = await form.validateFields()
      await onSave({
        providerName: values.providerName.trim(),
        providerBaseUrl: values.providerBaseUrl.trim(),
        providerIcon: selectedIcon,
        keyAlias: values.keyAlias?.trim(),
        keyValue: values.keyValue.trim(),
        keyType: values.keyType,
        apiFormat: values.apiFormat || 'auto',
        transformEnabled: values.transformEnabled ?? false,
      })
      message.success(t('providers.quickAddSuccess') || '添加成功')
      form.resetFields()
      setSelectedIcon('claude')
      setActivePresetId(null)
      onClose()
    } catch (error) {
      if (error instanceof Error) {
        message.error(error.message)
      } else {
        message.error(t('messages.error') || '操作失败')
      }
    } finally {
      setLoading(false)
    }
  }

  const handleCancel = () => {
    form.resetFields()
    setSelectedIcon('claude')
    setActivePresetId(null)
    onClose()
  }

  const copyDiscountCode = (code: string, e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard
      .writeText(code)
      .then(() => message.success(t('providers.presetCodeCopied')))
      .catch(() => {
        // Fallback for environments without clipboard API (shouldn't happen
        // inside Tauri, but cheap to guard).
        message.error(t('common.copy'))
      })
  }

  return (
    <Modal
      open={open}
      title={t('providers.quickAdd') || '快速添加'}
      onCancel={handleCancel}
      onOk={handleSubmit}
      confirmLoading={loading}
      width={560}
      destroyOnClose
    >
      <Form form={form} layout='vertical' initialValues={{ keyType: ['claude'] }}>
        {/* ── 预设选择栏 ── */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 8 }}>
            <Text strong style={{ fontSize: 13 }}>
              {t('providers.presetSectionTitle')}
            </Text>
            <br />
            <Text type='secondary' style={{ fontSize: 12 }}>
              {t('providers.presetSectionHint')}
            </Text>
          </div>
          <div
            style={{
              display: 'flex',
              gap: 8,
              overflowX: 'auto',
              paddingBottom: 4,
              maxHeight: 96,
              flexWrap: 'wrap',
            }}
          >
            {PROVIDER_PRESETS.map((preset) => {
              const active = activePresetId === preset.id
              return (
                <Tooltip
                  key={preset.id}
                  title={
                    <div style={{ maxWidth: 240 }}>
                      <div>{preset.baseUrl}</div>
                      {preset.note && (
                        <div style={{ opacity: 0.8, marginTop: 4 }}>{preset.note}</div>
                      )}
                      {preset.discountCode && (
                        <div style={{ marginTop: 4 }}>
                          <Tag color='gold' style={{ margin: 0 }}>
                            {preset.discountCode}
                          </Tag>
                          {preset.discountNote && (
                            <span style={{ marginLeft: 6, opacity: 0.8 }}>
                              {preset.discountNote}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  }
                >
                  <div
                    onClick={() => applyPreset(preset)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 10px',
                      borderRadius: 8,
                      border: `2px solid ${active ? '#00d4aa' : '#e5e7eb'}`,
                      cursor: 'pointer',
                      background: active ? 'rgba(0, 212, 170, 0.1)' : 'transparent',
                      fontSize: 12,
                      whiteSpace: 'nowrap',
                      transition: 'border-color 0.15s, background 0.15s',
                    }}
                  >
                    <img
                      src={resolvePresetIcon(preset.icon)}
                      alt={preset.name}
                      style={{ width: 18, height: 18 }}
                    />
                    <span>{preset.name}</span>
                    {preset.discountCode && (
                      <Tag
                        color='gold'
                        style={{ margin: 0, padding: '0 4px', fontSize: 10, lineHeight: '16px' }}
                        onClick={(e) => copyDiscountCode(preset.discountCode!, e)}
                      >
                        {t('providers.presetDiscount')}
                      </Tag>
                    )}
                  </div>
                </Tooltip>
              )
            })}
          </div>
        </div>

        <Form.Item
          name='providerName'
          label={t('providers.providerName')}
          rules={[{ required: true, message: t('providers.enterName') }]}
        >
          <Input placeholder={t('providers.namePlaceholder')} />
        </Form.Item>

        <Form.Item
          name='providerBaseUrl'
          label={t('providers.baseUrl')}
          rules={[
            { required: true, message: t('providers.enterBaseUrl') },
            { type: 'url', message: t('providers.invalidUrl') },
          ]}
        >
          <Input placeholder={t('providers.baseUrlPlaceholder')} />
        </Form.Item>

        <Form.Item label={t('providers.icon') || '图标'}>
          <Space wrap>
            {Object.entries({
              claude: 'Claude',
              openai: 'OpenAI',
              deepseek: 'DeepSeek',
              newapi: 'NewAPI',
            }).map(([key, label]) => (
              <div
                key={key}
                onClick={() => {
                  setSelectedIcon(key)
                  setActivePresetId(null)
                }}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 8,
                  border: `2px solid ${selectedIcon === key ? '#00d4aa' : '#e5e7eb'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  background: selectedIcon === key ? 'rgba(0, 212, 170, 0.1)' : '#fff',
                }}
              >
                <img src={resolvePresetIcon(key)} alt={label} style={{ width: 24, height: 24 }} />
              </div>
            ))}
          </Space>
        </Form.Item>

        <Form.Item
          name='keyAlias'
          label={t('apiKeys.alias') || '密钥别名'}
          tooltip='为这个密钥起一个便于识别的名称'
        >
          <Input placeholder={t('apiKeys.aliasPlaceholder') || '例如：我的主密钥'} />
        </Form.Item>

        <Form.Item
          name='keyValue'
          label={t('apiKeys.key')}
          rules={[{ required: true, message: t('apiKeys.enterKey') }]}
        >
          <Input.Password placeholder={t('apiKeys.keyPlaceholder')} />
        </Form.Item>

        <Form.Item
          name='keyType'
          label={t('apiKeys.keyType')}
          rules={[{ required: true, message: t('apiKeys.selectAtLeastOne') }]}
        >
          <Select
            mode='multiple'
            options={[
              { value: 'claude', label: 'Claude Code' },
              { value: 'codex', label: 'Codex CLI' },
            ]}
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}
