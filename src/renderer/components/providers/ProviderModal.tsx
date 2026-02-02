import { useEffect, useState } from 'react'
import {
  Modal,
  Form,
  Input,
  Select,
  Switch,
  Divider,
  Typography,
  message,
} from 'antd'
import { useTranslation } from 'react-i18next'
import type { Provider, CreateProviderInput } from '@shared/types'
import ApiKeyList from '../apiKeys/ApiKeyList'

const { Title } = Typography
const { TextArea } = Input

interface ProviderModalProps {
  open: boolean
  provider: Provider | null
  onClose: () => void
  onSave: (input: CreateProviderInput & { id?: string; isActive?: boolean }) => Promise<void>
}

export default function ProviderModal({
  open,
  provider,
  onClose,
  onSave,
}: ProviderModalProps) {
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [balanceType, setBalanceType] = useState<'none' | 'newapi' | 'custom'>('none')

  useEffect(() => {
    if (open) {
      if (provider) {
        form.setFieldsValue({
          name: provider.name,
          baseUrl: provider.baseUrl,
          walletBalanceType: provider.walletBalanceType,
          walletBalanceUrl: provider.walletBalanceUrl,
          walletBalancePath: provider.walletBalancePath,
          walletBalanceHeaders: provider.walletBalanceHeaders,
          isActive: provider.isActive,
        })
        setBalanceType(provider.walletBalanceType)
      } else {
        form.resetFields()
        setBalanceType('none')
      }
    }
  }, [open, provider, form])

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      setLoading(true)

      await onSave({
        id: provider?.id,
        name: values.name,
        baseUrl: values.baseUrl,
        walletBalanceType: values.walletBalanceType,
        walletBalanceUrl: values.walletBalanceUrl,
        walletBalancePath: values.walletBalancePath,
        walletBalanceHeaders: values.walletBalanceHeaders,
        isActive: values.isActive,
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

  return (
    <Modal
      title={provider ? t('providers.editProvider') : t('providers.newProvider')}
      open={open}
      onCancel={onClose}
      onOk={handleSubmit}
      okText={t('common.confirm')}
      cancelText={t('common.cancel')}
      confirmLoading={loading}
      width={700}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          walletBalanceType: 'none',
          isActive: true,
        }}
      >
        <Form.Item
          name="name"
          label={t('common.name')}
          rules={[{ required: true, message: t('providers.enterName') }]}
        >
          <Input placeholder={t('providers.namePlaceholder')} />
        </Form.Item>

        <Form.Item
          name="baseUrl"
          label={t('providers.baseUrl')}
          rules={[
            { required: true, message: t('providers.enterBaseUrl') },
            { type: 'url', message: t('providers.invalidUrl') },
          ]}
        >
          <Input placeholder={t('providers.baseUrlPlaceholder')} />
        </Form.Item>

        <Form.Item name="isActive" label={t('common.active')} valuePropName="checked">
          <Switch />
        </Form.Item>

        <Divider />

        <Title level={5}>{t('providers.balanceConfig')}</Title>

        <Form.Item name="walletBalanceType" label={t('providers.balanceType')}>
          <Select
            onChange={(value) => setBalanceType(value)}
            options={[
              { value: 'none', label: t('providers.balanceTypeNone') },
              { value: 'newapi', label: t('providers.balanceTypeNewapi') },
              { value: 'custom', label: t('providers.balanceTypeCustom') },
            ]}
          />
        </Form.Item>

        {balanceType === 'custom' && (
          <>
            <Form.Item
              name="walletBalanceUrl"
              label={t('providers.balanceUrl')}
              rules={[
                {
                  required: balanceType === 'custom',
                  message: t('providers.enterBalanceUrl'),
                },
              ]}
            >
              <Input placeholder="https://api.example.com/balance" />
            </Form.Item>

            <Form.Item
              name="walletBalancePath"
              label={t('providers.balancePath')}
              rules={[
                {
                  required: balanceType === 'custom',
                  message: t('providers.enterBalancePath'),
                },
              ]}
              extra={t('providers.balancePathHint')}
            >
              <Input placeholder="data.balance" />
            </Form.Item>

            <Form.Item
              name="walletBalanceHeaders"
              label={t('providers.customHeaders')}
              extra={t('providers.customHeadersHint')}
            >
              <TextArea
                rows={3}
                placeholder='{"Authorization": "Bearer xxx"}'
              />
            </Form.Item>
          </>
        )}
      </Form>

      {provider && (
        <>
          <Divider />
          <Title level={5}>{t('providers.apiKeys')}</Title>
          <ApiKeyList providerId={provider.id} />
        </>
      )}
    </Modal>
  )
}
