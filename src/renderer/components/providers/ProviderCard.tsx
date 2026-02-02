import { Card, Typography, Tag, Button, Space, Tooltip, Popconfirm, theme } from 'antd'
import {
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LinkOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import type { Provider } from '@shared/types'
import styles from './ProviderCard.module.css'

import claudeIcon from '../../assets/provider-icons/claude.svg'
import openaiIcon from '../../assets/provider-icons/openai.svg'
import zhipuIcon from '../../assets/provider-icons/zhipu.svg'
import minimaxIcon from '../../assets/provider-icons/minimax.svg'
import deepseekIcon from '../../assets/provider-icons/deepseek.svg'
import siliconflowIcon from '../../assets/provider-icons/siliconflow.svg'
import newapiIcon from '../../assets/provider-icons/newapi.svg'

const { Text, Title } = Typography

const PRESET_ICON_MAP: Record<string, string> = {
  claude: claudeIcon,
  codex: openaiIcon,
  openai: openaiIcon,
  zhipu: zhipuIcon,
  minimax: minimaxIcon,
  deepseek: deepseekIcon,
  siliconflow: siliconflowIcon,
  newapi: newapiIcon,
}

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

  const getIconSrc = () => {
    if (!provider.icon) {
      return PRESET_ICON_MAP[provider.type] || PRESET_ICON_MAP.claude
    }
    if (PRESET_ICON_MAP[provider.icon]) {
      return PRESET_ICON_MAP[provider.icon]
    }
    return `file://${provider.icon}`
  }

  const renderIcon = () => {
    const iconSrc = getIconSrc()
    return (
      <img
        src={iconSrc}
        alt={provider.name}
        className="w-6 h-6 object-contain"
      />
    )
  }

  return (
    <Card
      className={styles.card}
      style={{
        border: `1px solid ${provider.isActive ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
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
      <Space direction="vertical" className="w-full" size="middle">
        <Space align="start" className="w-full justify-between">
          <Space>
            <div
              className={clsx(
                styles.iconBox,
                provider.isActive ? styles.iconBoxActive : styles.iconBoxInactive
              )}
            >
              {renderIcon()}
            </div>
            <div>
              <Title level={5} className="!m-0">
                {provider.name}
              </Title>
              <Text type="secondary" className="text-xs">
                {provider.baseUrl}
              </Text>
            </div>
          </Space>
          <Space direction="vertical" size={4} align="end">
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
            <Tag color={provider.type === 'codex' ? 'green' : 'blue'}>
              {provider.type === 'codex' ? t('providers.typeCodex') : t('providers.typeClaude')}
            </Tag>
          </Space>
        </Space>

        {provider.website && (
          <div className="flex items-center gap-1">
            <LinkOutlined className="text-gray-400" />
            <a
              href={provider.website}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-500 hover:text-blue-600 truncate"
              onClick={(e) => e.stopPropagation()}
            >
              {provider.website}
            </a>
          </div>
        )}

        {provider.remark && (
          <Text type="secondary" className="text-xs line-clamp-2">
            {provider.remark}
          </Text>
        )}

        {provider.walletBalanceType !== 'none' && (
          <div className={styles.balanceBox}>
            <Space direction="vertical" size={0} className="w-full">
              <Space className="justify-between w-full">
                <Text type="secondary">{t('providers.balance')}</Text>
                <Text strong className={styles.balanceAmount} style={{ color: token.colorPrimary }}>
                  {formatBalance(provider.cachedWalletBalance)}
                </Text>
              </Space>
              <Text type="secondary" className={styles.lastChecked}>
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
