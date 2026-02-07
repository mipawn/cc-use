import { useEffect, useState } from 'react'
import {
  Table,
  Button,
  Input,
  Switch,
  Space,
  Popconfirm,
} from 'antd'
import { useAppMessage } from '../../hooks/useAppMessage'
import {
  PlusOutlined,
  DeleteOutlined,
  HolderOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { ApiKey } from '@shared/types'
import { useApiKeyStore } from '../../stores/apiKeyStore'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import styles from './ApiKeyList.module.css'

interface ApiKeyListProps {
  providerId: string
}

interface SortableRowProps {
  children: React.ReactNode
  'data-row-key': string
}

function SortableRow({ children, ...props }: SortableRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props['data-row-key'] })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    cursor: 'move',
  }

  return (
    <tr {...props} ref={setNodeRef} style={style} {...attributes} {...listeners} className={styles.sortableRow}>
      {children}
    </tr>
  )
}

export default function ApiKeyList({ providerId }: ApiKeyListProps) {
  const { t } = useTranslation()
  const message = useAppMessage()
  const { apiKeys, loading, fetchApiKeys, createApiKey, updateApiKey, deleteApiKey, reorderApiKeys } =
    useApiKeyStore()
  const [newKeyValue, setNewKeyValue] = useState('')
  const [newKeyAlias, setNewKeyAlias] = useState('')
  const [adding, setAdding] = useState(false)

  const keys = apiKeys[providerId] || []
  const isLoading = loading[providerId] || false

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  useEffect(() => {
    fetchApiKeys(providerId)
  }, [providerId, fetchApiKeys])

  const handleAddKey = async () => {
    if (!newKeyValue.trim()) {
      message.error(t('apiKeys.enterApiKey'))
      return
    }

    setAdding(true)
    try {
      await createApiKey({
        providerId,
        value: newKeyValue.trim(),
        alias: newKeyAlias.trim() || undefined,
      })
      setNewKeyValue('')
      setNewKeyAlias('')
      message.success(t('apiKeys.keyAdded'))
    } catch (error) {
      message.error(t('messages.error'))
    } finally {
      setAdding(false)
    }
  }

  const handleUpdateAlias = async (id: string, alias: string) => {
    try {
      await updateApiKey({ id, alias })
    } catch (error) {
      message.error(t('messages.error'))
    }
  }

  const handleToggleExhausted = async (id: string, isExhausted: boolean) => {
    try {
      await updateApiKey({ id, isExhausted })
    } catch (error) {
      message.error(t('messages.error'))
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteApiKey(providerId, id)
      message.success(t('apiKeys.keyDeleted'))
    } catch (error) {
      message.error(t('messages.error'))
    }
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = keys.findIndex((k) => k.id === active.id)
    const newIndex = keys.findIndex((k) => k.id === over.id)
    const newOrder = arrayMove(keys, oldIndex, newIndex)

    try {
      await reorderApiKeys(providerId, newOrder.map((k) => k.id))
    } catch (error) {
      message.error(t('messages.error'))
    }
  }

  const columns = [
    {
      title: '',
      dataIndex: 'sort',
      width: 40,
      render: () => <HolderOutlined className={styles.dragHandle} />,
    },
    {
      title: t('apiKeys.keyName'),
      dataIndex: 'alias',
      width: 150,
      render: (alias: string | null, record: ApiKey) => (
        <Input
          size="small"
          defaultValue={alias || ''}
          placeholder={t('apiKeys.keyNamePlaceholder')}
          onBlur={(e) => handleUpdateAlias(record.id, e.target.value)}
        />
      ),
    },
    {
      title: t('apiKeys.apiKey'),
      dataIndex: 'value',
      render: (value: string) => (
        <Input.Password
          size="small"
          value={value}
          readOnly
          className="w-full"
        />
      ),
    },
    {
      title: t('common.active'),
      dataIndex: 'isExhausted',
      width: 80,
      render: (isExhausted: boolean, record: ApiKey) => (
        <Switch
          size="small"
          checked={!isExhausted}
          onChange={(checked) => handleToggleExhausted(record.id, !checked)}
        />
      ),
    },
    {
      title: '',
      width: 50,
      render: (_: unknown, record: ApiKey) => (
        <Popconfirm
          title={t('apiKeys.deleteKeyConfirm')}
          onConfirm={() => handleDelete(record.id)}
          okText={t('common.delete')}
          cancelText={t('common.cancel')}
          okButtonProps={{ danger: true }}
        >
          <Button type="text" danger size="small" icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ]

  return (
    <div>
      <Space className={styles.addKeyForm}>
        <Input
          placeholder={t('apiKeys.keyNamePlaceholder')}
          value={newKeyAlias}
          onChange={(e) => setNewKeyAlias(e.target.value)}
          style={{ width: 120 }}
        />
        <Input.Password
          placeholder={t('apiKeys.apiKeyPlaceholder')}
          value={newKeyValue}
          onChange={(e) => setNewKeyValue(e.target.value)}
          style={{ width: 300 }}
        />
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleAddKey}
          loading={adding}
        >
          {t('common.add')}
        </Button>
      </Space>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={keys.map((k) => k.id)}
          strategy={verticalListSortingStrategy}
        >
          <Table
            components={{
              body: {
                row: SortableRow,
              },
            }}
            rowKey="id"
            columns={columns}
            dataSource={keys}
            loading={isLoading}
            pagination={false}
            size="small"
          />
        </SortableContext>
      </DndContext>
    </div>
  )
}
