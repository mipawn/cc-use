import { Card, Typography, Tag, Button, Space, Tooltip, Popconfirm, theme } from 'antd'
import {
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloudServerOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { Provider } from '@shared/types'

const { Text, Title } = Typography

interface ProviderCardProps {
  provider: Provider
  onEdit: (provider: Provider) => void
  onDelete: (id: string) => void
  onRefreshBalance: (id: string) => void
  refreshing?: boolean
}

export default function ProviderCard({
  provider,
  onEdit,
  onDelete,
  onRefreshBalance,
  refreshing,
}: ProviderCardProps) {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const formatBalance = (balance: number | null) => {
    if (balance === null) return '-'
    return `$${balance.toFixed(2)}`
  }

  const formatLastChecked = (timestamp: string | null) => {
    if (!timestamp) return t('common.never')
    const date = new Date(timestamp)
    return date.toLocaleString()
  }

  return (
    <Card
      style={{
        borderRadius: 12,
        border: `1px solid ${provider.isActive ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
        transition: 'all 0.3s',
      }}
      hoverable
      actions={[
        <Tooltip title={t('common.edit')} key="edit">
          <Button
            type="text"
            icon={<EditOutlined />}
            onClick={() => onEdit(provider)}
          />
        </Tooltip>,
        <Tooltip title={t('providers.refreshBalance')} key="refresh">
          <Button
            type="text"
            icon={<ReloadOutlined spin={refreshing} />}
            onClick={() => onRefreshBalance(provider.id)}
            disabled={provider.walletBalanceType === 'none' || refreshing}
          />
        </Tooltip>,
        <Popconfirm
          key="delete"
          title={t('providers.deleteProvider')}
          description={t('providers.deleteProviderConfirm')}
          onConfirm={() => onDelete(provider.id)}
          okText={t('common.delete')}
          cancelText={t('common.cancel')}
          okButtonProps={{ danger: true }}
        >
          <Tooltip title={t('common.delete')}>
            <Button type="text" danger icon={<DeleteOutlined />} />
          </Tooltip>
        </Popconfirm>,
      ]}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Space align="start" style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                background: provider.isActive ? token.colorPrimaryBg : token.colorBgTextHover,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <CloudServerOutlined
                style={{
                  fontSize: 20,
                  color: provider.isActive ? token.colorPrimary : token.colorTextSecondary,
                }}
              />
            </div>
            <div>
              <Title level={5} style={{ margin: 0 }}>
                {provider.name}
              </Title>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {provider.baseUrl}
              </Text>
            </div>
          </Space>
          <Tag
            icon={
              provider.isActive ? (
                <CheckCircleOutlined />
              ) : (
                <CloseCircleOutlined />
              )
            }
            color={provider.isActive ? 'processing' : 'default'}
          >
            {provider.isActive ? t('common.active') : t('common.inactive')}
          </Tag>
        </Space>

        {provider.walletBalanceType !== 'none' && (
          <div
            style={{
              padding: 12,
              borderRadius: 8,
              background: token.colorBgTextHover,
            }}
          >
            <Space direction="vertical" size={0} style={{ width: '100%' }}>
              <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                <Text type="secondary">{t('providers.balance')}</Text>
                <Text strong style={{ fontSize: 16, color: token.colorPrimary }}>
                  {formatBalance(provider.cachedWalletBalance)}
                </Text>
              </Space>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {t('providers.lastChecked')}: {formatLastChecked(provider.lastBalanceCheckedAt)}
              </Text>
            </Space>
          </div>
        )}

        <Tag color="blue">{provider.walletBalanceType.toUpperCase()}</Tag>
      </Space>
    </Card>
  )
}
