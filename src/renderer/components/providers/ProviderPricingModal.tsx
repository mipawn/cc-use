import { useEffect, useMemo, useState } from 'react'
import { Modal, Table, Input, InputNumber, Button, Space } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useTranslation } from 'react-i18next'
import type { Provider } from '@shared/types'

type PricingValue = {
  input: number
  output: number
  cacheRead?: number
  cacheCreation?: number
}

type Row = {
  id: string
  model: string
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheCreation: number | null
}

function toRow(model: string, value: PricingValue): Row {
  return {
    id: model,
    model,
    input: value.input ?? null,
    output: value.output ?? null,
    cacheRead: value.cacheRead ?? null,
    cacheCreation: value.cacheCreation ?? null,
  }
}

function buildPricing(rows: Row[]): Record<string, PricingValue> {
  const result: Record<string, PricingValue> = {}
  for (const row of rows) {
    const model = row.model.trim()
    if (!model) continue
    if (row.input === null || row.output === null) continue

    const value: PricingValue = {
      input: row.input,
      output: row.output,
    }
    if (row.cacheRead !== null) value.cacheRead = row.cacheRead
    if (row.cacheCreation !== null) value.cacheCreation = row.cacheCreation
    result[model] = value
  }
  return result
}

export default function ProviderPricingModal(props: {
  open: boolean
  provider: Provider | null
  saving?: boolean
  onClose: () => void
  onSave: (pricing: Record<string, PricingValue>) => Promise<void>
}) {
  const { t } = useTranslation()
  const { open, provider, saving, onClose, onSave } = props

  const initialRows = useMemo<Row[]>(() => {
    const pricing = provider?.cachedModelPricing ?? null
    if (!pricing) return []
    return Object.entries(pricing)
      .map(([model, value]) => toRow(model, value))
      .sort((a, b) => a.model.localeCompare(b.model))
  }, [provider])

  const [rows, setRows] = useState<Row[]>([])

  useEffect(() => {
    if (!open) return
    setRows(initialRows)
  }, [open, initialRows])

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      {
        id: `new-${Date.now()}`,
        model: '',
        input: null,
        output: null,
        cacheRead: null,
        cacheCreation: null,
      },
    ])
  }

  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id))
  }

  const updateRow = (id: string, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  const handleOk = async () => {
    const models = rows.map((r) => r.model.trim()).filter(Boolean)
    const dup = models.find((m, idx) => models.indexOf(m) !== idx)
    if (dup) {
      Modal.error({ title: t('keys.pricingDuplicateModel') || '模型名重复', content: dup })
      return
    }

    const pricing = buildPricing(rows)
    await onSave(pricing)
  }

  const columns: ColumnsType<Row> = [
    {
      title: t('keys.pricingModel') || '模型',
      dataIndex: 'model',
      key: 'model',
      width: 260,
      render: (_, record) => (
        <Input
          value={record.model}
          placeholder={t('keys.pricingModelPlaceholder') || '例如：gpt-4o'}
          onChange={(e) => updateRow(record.id, { model: e.target.value })}
        />
      ),
    },
    {
      title: t('keys.pricingInput') || '输入($/1M)',
      dataIndex: 'input',
      key: 'input',
      width: 150,
      render: (_, record) => (
        <InputNumber
          value={record.input}
          min={0}
          step={0.000001}
          style={{ width: '100%' }}
          onChange={(v) => updateRow(record.id, { input: typeof v === 'number' ? v : null })}
        />
      ),
    },
    {
      title: t('keys.pricingOutput') || '输出($/1M)',
      dataIndex: 'output',
      key: 'output',
      width: 150,
      render: (_, record) => (
        <InputNumber
          value={record.output}
          min={0}
          step={0.000001}
          style={{ width: '100%' }}
          onChange={(v) => updateRow(record.id, { output: typeof v === 'number' ? v : null })}
        />
      ),
    },
    {
      title: t('keys.pricingCacheRead') || '缓存读($/1M)',
      dataIndex: 'cacheRead',
      key: 'cacheRead',
      width: 160,
      render: (_, record) => (
        <InputNumber
          value={record.cacheRead}
          min={0}
          step={0.000001}
          style={{ width: '100%' }}
          onChange={(v) => updateRow(record.id, { cacheRead: typeof v === 'number' ? v : null })}
        />
      ),
    },
    {
      title: t('keys.pricingCacheCreation') || '缓存写($/1M)',
      dataIndex: 'cacheCreation',
      key: 'cacheCreation',
      width: 160,
      render: (_, record) => (
        <InputNumber
          value={record.cacheCreation}
          min={0}
          step={0.000001}
          style={{ width: '100%' }}
          onChange={(v) =>
            updateRow(record.id, { cacheCreation: typeof v === 'number' ? v : null })
          }
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 90,
      render: (_, record) => (
        <Button danger type='link' onClick={() => removeRow(record.id)}>
          {t('common.delete') || '删除'}
        </Button>
      ),
    },
  ]

  return (
    <Modal
      open={open}
      title={
        provider
          ? `${t('keys.pricingEditorTitle') || '模型价格'} - ${provider.name}`
          : t('keys.pricingEditorTitle') || '模型价格'
      }
      width={980}
      onCancel={onClose}
      onOk={handleOk}
      okText={t('common.save') || '保存'}
      cancelText={t('common.cancel') || '取消'}
      confirmLoading={saving}
      destroyOnClose
    >
      <Space style={{ marginBottom: 12 }}>
        <Button onClick={addRow}>{t('keys.pricingAddModel') || '添加模型'}</Button>
        <span style={{ color: 'rgba(0,0,0,0.45)' }}>
          {t('keys.pricingHint') || '单位：美元/百万 tokens（$/1M）'}
        </span>
      </Space>

      <Table<Row>
        rowKey='id'
        size='small'
        pagination={{ pageSize: 10 }}
        columns={columns}
        dataSource={rows}
        scroll={{ x: 900 }}
      />
    </Modal>
  )
}
