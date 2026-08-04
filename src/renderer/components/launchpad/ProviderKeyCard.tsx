/**
 * Provider+Key 组合卡片 — 用于启动台密钥选择
 */
import { Card, Space, Tag, Typography, Button, Tooltip } from 'antd'
import { CheckCircleOutlined, SwapOutlined } from '@ant-design/icons'
import type { Provider, ApiKey, ClientKind } from '@shared/types'

const { Text } = Typography

interface Props {
  provider: Provider
  apiKey: ApiKey
  isSelected: boolean
  onSelect: () => void
  targetClientKind?: ClientKind
  actionLabel?: string
}

export default function ProviderKeyCard({
  provider,
  apiKey,
  isSelected,
  onSelect,
  actionLabel = '接管',
}: Props) {
  const displayValue = apiKey.alias || `${apiKey.value.slice(0, 10)}...${apiKey.value.slice(-4)}`

  return (
    <Card
      variant='outlined'
      size='small'
      style={{
        borderColor: isSelected ? '#3b82f6' : undefined,
        background: isSelected ? 'rgba(59, 130, 246, 0.06)' : undefined,
        opacity: apiKey.isActive ? 1 : 0.6,
        borderRadius: 6,
        height: '100%',
      }}
      styles={{ body: { padding: '9px 10px', height: '100%' } }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
        <Space size={6} style={{ minWidth: 0 }}>
          <Tooltip title={displayValue}>
            <Text strong style={{ maxWidth: 150 }} ellipsis>
              {displayValue}
            </Text>
          </Tooltip>
          {isSelected && (
            <Tag color='blue' icon={<CheckCircleOutlined />} style={{ margin: 0 }}>
              当前
            </Tag>
          )}
        </Space>

        <Space size={6} style={{ minWidth: 0 }}>
          <Text type='secondary' style={{ fontSize: 12 }} ellipsis>
            {provider.name}
          </Text>
          <Text type='secondary' style={{ fontSize: 12 }}>
            P{apiKey.priority}
          </Text>
          {!apiKey.isActive && (
            <Tag color='default' style={{ margin: 0 }}>
              已禁用
            </Tag>
          )}
        </Space>

        <Space style={{ justifyContent: 'flex-end', width: '100%', marginTop: 'auto' }}>
          <Button
            type={isSelected ? 'default' : 'primary'}
            icon={<SwapOutlined />}
            size='small'
            block
            disabled={!apiKey.isActive}
            onClick={onSelect}
          >
            {isSelected ? '已接管' : actionLabel}
          </Button>
        </Space>
      </div>
    </Card>
  )
}
