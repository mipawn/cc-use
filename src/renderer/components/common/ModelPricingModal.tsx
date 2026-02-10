/**
 * ModelPricingModal - 模型价格管理弹窗
 * 展示默认（官方）价格 + 用户自定义覆盖
 */
import { useEffect, useState, useMemo } from 'react'
import {
  Modal,
  Table,
  InputNumber,
  Button,
  Space,
  Tag,
  Input,
  Typography,
  Popconfirm,
  Tooltip,
} from 'antd'
import {
  PlusOutlined,
  DeleteOutlined,
  SaveOutlined,
  UndoOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAppMessage } from '../../hooks/useAppMessage'

const { Text } = Typography

interface ModelPricing {
  input: number
  output: number
  cacheRead?: number
  cacheCreation?: number
}

interface PricingRow {
  key: string
  model: string
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  isCustom: boolean
  isNew?: boolean
}

interface Props {
  open: boolean
  onClose: () => void
}

export default function ModelPricingModal({ open, onClose }: Props) {
  const { t } = useTranslation()
  const message = useAppMessage()

  const [defaultPricing, setDefaultPricing] = useState<Record<string, ModelPricing>>({})
  const [, setCustomPricing] = useState<Record<string, ModelPricing>>({})
  const [editedCustom, setEditedCustom] = useState<Record<string, ModelPricing>>({})
  const [newModelName, setNewModelName] = useState('')
  const [saving, setSaving] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [hasChanges, setHasChanges] = useState(false)

  // Load pricing data when modal opens
  useEffect(() => {
    if (!open) return
    const load = async () => {
      try {
        const [defaults, custom] = await Promise.all([
          window.api.modelPricing.getDefault(),
          window.api.modelPricing.getCustom(),
        ])
        setDefaultPricing(defaults)
        setCustomPricing(custom)
        setEditedCustom({ ...custom })
        setHasChanges(false)
      } catch (error) {
        console.error('Failed to load pricing:', error)
      }
    }
    load()
  }, [open])

  // Build table data: merge default + custom, custom wins
  const tableData = useMemo(() => {
    const allModels = new Set([
      ...Object.keys(defaultPricing),
      ...Object.keys(editedCustom),
    ])
    allModels.delete('default')

    const rows: PricingRow[] = []
    for (const model of allModels) {
      const def = defaultPricing[model]
      const cust = editedCustom[model]
      const effective = cust || def
      if (!effective) continue

      rows.push({
        key: model,
        model,
        input: effective.input,
        output: effective.output,
        cacheRead: effective.cacheRead ?? 0,
        cacheCreation: effective.cacheCreation ?? 0,
        isCustom: !!cust,
        isNew: !!cust && !defaultPricing[model],
      })
    }

    // Sort: custom first, then alphabetically
    rows.sort((a, b) => {
      if (a.isCustom !== b.isCustom) return a.isCustom ? -1 : 1
      return a.model.localeCompare(b.model)
    })

    return rows
  }, [defaultPricing, editedCustom])

  // Filtered data
  const filteredData = useMemo(() => {
    if (!searchText) return tableData
    const lower = searchText.toLowerCase()
    return tableData.filter((row) => row.model.toLowerCase().includes(lower))
  }, [tableData, searchText])

  // Update a custom pricing field
  const updateField = (model: string, field: keyof ModelPricing, value: number) => {
    setEditedCustom((prev) => {
      const existing = prev[model] || defaultPricing[model] || { input: 0, output: 0 }
      return {
        ...prev,
        [model]: {
          ...existing,
          [field]: value,
        },
      }
    })
    setHasChanges(true)
  }

  // Remove custom override (revert to default)
  const removeCustom = (model: string) => {
    setEditedCustom((prev) => {
      const next = { ...prev }
      delete next[model]
      return next
    })
    setHasChanges(true)
  }

  // Add new model
  const addNewModel = () => {
    const name = newModelName.trim()
    if (!name) return
    if (editedCustom[name] || defaultPricing[name]) {
      message.warning(t('modelPricing.modelExists'))
      return
    }
    setEditedCustom((prev) => ({
      ...prev,
      [name]: { input: 3, output: 15 },
    }))
    setNewModelName('')
    setHasChanges(true)
  }

  // Save
  const handleSave = async () => {
    setSaving(true)
    try {
      await window.api.modelPricing.updateCustom(editedCustom)
      setCustomPricing({ ...editedCustom })
      setHasChanges(false)
      message.success(t('messages.success'))
    } catch (error) {
      message.error(t('messages.error'))
    } finally {
      setSaving(false)
    }
  }

  // Reset all custom
  const handleResetAll = () => {
    setEditedCustom({})
    setHasChanges(true)
  }

  const columns = [
    {
      title: t('modelPricing.model'),
      dataIndex: 'model',
      key: 'model',
      width: 260,
      ellipsis: true,
      render: (model: string, row: PricingRow) => (
        <Space size={4}>
          <Text style={{ fontSize: 13 }}>{model}</Text>
          {row.isCustom && (
            <Tag color='blue' style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
              {row.isNew ? t('modelPricing.new') : t('modelPricing.custom')}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: `Input ($/M)`,
      dataIndex: 'input',
      key: 'input',
      width: 110,
      render: (val: number, row: PricingRow) => (
        <InputNumber
          size='small'
          value={val}
          min={0}
          step={0.1}
          style={{ width: 90 }}
          onChange={(v) => v !== null && updateField(row.model, 'input', v)}
        />
      ),
    },
    {
      title: `Output ($/M)`,
      dataIndex: 'output',
      key: 'output',
      width: 110,
      render: (val: number, row: PricingRow) => (
        <InputNumber
          size='small'
          value={val}
          min={0}
          step={0.1}
          style={{ width: 90 }}
          onChange={(v) => v !== null && updateField(row.model, 'output', v)}
        />
      ),
    },
    {
      title: `Cache Read`,
      dataIndex: 'cacheRead',
      key: 'cacheRead',
      width: 100,
      render: (val: number, row: PricingRow) => (
        <InputNumber
          size='small'
          value={val}
          min={0}
          step={0.01}
          style={{ width: 80 }}
          onChange={(v) => v !== null && updateField(row.model, 'cacheRead', v)}
        />
      ),
    },
    {
      title: `Cache Write`,
      dataIndex: 'cacheCreation',
      key: 'cacheCreation',
      width: 100,
      render: (val: number, row: PricingRow) => (
        <InputNumber
          size='small'
          value={val}
          min={0}
          step={0.01}
          style={{ width: 80 }}
          onChange={(v) => v !== null && updateField(row.model, 'cacheCreation', v)}
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 50,
      render: (_: unknown, row: PricingRow) =>
        row.isCustom ? (
          <Tooltip title={row.isNew ? t('common.delete') : t('modelPricing.revertDefault')}>
            <Button
              type='text'
              size='small'
              danger
              icon={<DeleteOutlined />}
              onClick={() => removeCustom(row.model)}
            />
          </Tooltip>
        ) : null,
    },
  ]

  return (
    <Modal
      title={t('modelPricing.title')}
      open={open}
      onCancel={onClose}
      width={800}
      styles={{ body: { padding: '12px 0' } }}
      footer={
        <Space>
          <Popconfirm
            title={t('modelPricing.resetConfirm')}
            onConfirm={handleResetAll}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Button icon={<UndoOutlined />} disabled={Object.keys(editedCustom).length === 0}>
              {t('modelPricing.resetAll')}
            </Button>
          </Popconfirm>
          <Button
            type='primary'
            icon={<SaveOutlined />}
            onClick={handleSave}
            loading={saving}
            disabled={!hasChanges}
          >
            {t('common.save')}
          </Button>
        </Space>
      }
    >
      {/* Search + Add */}
      <div style={{ display: 'flex', gap: 8, padding: '0 24px', marginBottom: 12 }}>
        <Input
          placeholder={t('common.search')}
          prefix={<SearchOutlined />}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear
          style={{ flex: 1 }}
        />
        <Input
          placeholder={t('modelPricing.newModelPlaceholder')}
          value={newModelName}
          onChange={(e) => setNewModelName(e.target.value)}
          onPressEnter={addNewModel}
          style={{ width: 200 }}
        />
        <Button icon={<PlusOutlined />} onClick={addNewModel} disabled={!newModelName.trim()}>
          {t('common.add')}
        </Button>
      </div>

      <Text type='secondary' style={{ display: 'block', padding: '0 24px', marginBottom: 8, fontSize: 12 }}>
        {t('modelPricing.hint')}
      </Text>

      {/* Table */}
      <Table
        dataSource={filteredData}
        columns={columns}
        size='small'
        pagination={false}
        scroll={{ y: 420 }}
        rowKey='key'
        style={{ padding: '0 12px' }}
      />
    </Modal>
  )
}
