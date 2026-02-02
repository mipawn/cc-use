import { useState } from 'react'
import { Modal, Form, Input, Select, message } from 'antd'
import { useTranslation } from 'react-i18next'
import type { Provider } from '@shared/types'

interface NewProjectModalProps {
  open: boolean
  path: string
  providers: Provider[]
  onClose: () => void
  onSave: (name: string, providerId: string) => Promise<void>
}

export default function NewProjectModal({
  open,
  path,
  providers,
  onClose,
  onSave,
}: NewProjectModalProps) {
  const { t } = useTranslation()
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const defaultName = path.split('/').pop() || t('newProject.myProject')

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      setLoading(true)
      await onSave(values.name, values.providerId)
      form.resetFields()
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
      title={t('newProject.title')}
      open={open}
      onCancel={onClose}
      onOk={handleSubmit}
      confirmLoading={loading}
      okText={t('common.confirm')}
      cancelText={t('common.cancel')}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          name: defaultName,
        }}
      >
        <Form.Item label={t('common.path')}>
          <Input value={path} disabled />
        </Form.Item>

        <Form.Item
          name="name"
          label={t('projects.projectName')}
          rules={[{ required: true, message: t('newProject.enterName') }]}
        >
          <Input placeholder={t('newProject.myProject')} />
        </Form.Item>

        <Form.Item
          name="providerId"
          label={t('common.providers')}
          rules={[{ required: true, message: t('newProject.selectProvider') }]}
        >
          <Select
            placeholder={t('newProject.selectProviderPlaceholder')}
            options={providers
              .filter((p) => p.isActive)
              .map((p) => ({
                value: p.id,
                label: p.name,
              }))}
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}
