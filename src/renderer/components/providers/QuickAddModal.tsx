import { useState } from 'react'
import { Modal, Form, Input, Select, Space } from 'antd'
import { useAppMessage } from '../../hooks/useAppMessage'
import { useTranslation } from 'react-i18next'
import type { ProviderType } from '@shared/types'

import claudeIcon from '../../assets/provider-icons/claude.svg'
import openaiIcon from '../../assets/provider-icons/openai.svg'
import zhipuIcon from '../../assets/provider-icons/zhipu.svg'
import minimaxIcon from '../../assets/provider-icons/minimax.svg'
import deepseekIcon from '../../assets/provider-icons/deepseek.svg'
import siliconflowIcon from '../../assets/provider-icons/siliconflow.svg'
import newapiIcon from '../../assets/provider-icons/newapi.svg'

const PRESET_ICONS = [
  { key: 'claude', icon: claudeIcon, label: 'Claude' },
  { key: 'openai', icon: openaiIcon, label: 'OpenAI' },
  { key: 'deepseek', icon: deepseekIcon, label: 'DeepSeek' },
  { key: 'zhipu', icon: zhipuIcon, label: '智谱' },
  { key: 'minimax', icon: minimaxIcon, label: 'MiniMax' },
  { key: 'siliconflow', icon: siliconflowIcon, label: '硅基流动' },
  { key: 'newapi', icon: newapiIcon, label: 'NewAPI' },
]

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
  }) => Promise<void>
}

export default function QuickAddModal({ open, onClose, onSave }: QuickAddModalProps) {
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [selectedIcon, setSelectedIcon] = useState('claude')
  const message = useAppMessage()

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
      })
      message.success(t('providers.quickAddSuccess') || '添加成功')
      form.resetFields()
      setSelectedIcon('claude')
      onClose()
    } catch (error) {
      if (error instanceof Error) {
        message.error(error.message)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open={open}
      title={t('providers.quickAdd') || '快速添加'}
      onCancel={onClose}
      onOk={handleSubmit}
      confirmLoading={loading}
      width={500}
      destroyOnClose
    >
      <Form form={form} layout='vertical' initialValues={{ keyType: ['claude'] }}>
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
            {PRESET_ICONS.map((item) => (
              <div
                key={item.key}
                onClick={() => setSelectedIcon(item.key)}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 8,
                  border: `2px solid ${selectedIcon === item.key ? '#00d4aa' : '#e5e7eb'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  background: selectedIcon === item.key ? 'rgba(0, 212, 170, 0.1)' : '#fff',
                }}
              >
                <img src={item.icon} alt={item.label} style={{ width: 24, height: 24 }} />
              </div>
            ))}
          </Space>
        </Form.Item>

        <Form.Item name='keyAlias' label={t('apiKeys.alias') || '密钥别名'} tooltip='为这个密钥起一个便于识别的名称'>
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
