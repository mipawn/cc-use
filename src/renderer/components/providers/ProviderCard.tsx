import { Card, Typography, Tag, Button, Space, Tooltip, Popconfirm, theme } from 'antd'
import { useAppMessage } from '../../hooks/useAppMessage'
import {
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LinkOutlined,
  CopyOutlined,
  DollarOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import type { Provider } from '@shared/types'
import { getProviderTypeConfig, generateTerminalCommand, TERMINAL_TYPE_LABELS } from '@shared/types'
import { useSettingsStore } from '../../stores/settingsStore'
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
  onEditPricing?: (provider: Provider) => void
  refreshing?: boolean
  firstApiKey?: string // First available API key value for copy command
}

export default function ProviderCard({
  provider,
  onEdit,
  onDelete,
  onRefreshBalance,
  onEditPricing,
  refreshing,
  firstApiKey,
}: ProviderCardProps) {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const message = useAppMessage()
  const { globalSettings } = useSettingsStore()
  const terminalType = globalSettings.defaultTerminalType

  const handleCopyCommand = async () => {
    const apiKey = firstApiKey || provider.token || 'YOUR_API_KEY'
    const command = generateTerminalCommand(
      { type: provider.type ?? 'claude', baseUrl: provider.baseUrl },
      apiKey,
      false,
      12345,
      terminalType,
    )
    try {
      await navigator.clipboard.writeText(command)
      const terminalLabel = TERMINAL_TYPE_LABELS[terminalType]
      message.success(`${t('providers.commandCopied')} (${terminalLabel})`)
    } catch {
      message.error(t('providers.copyFailed'))
    }
  }

  const getTypeLabel = () => {
    const config = getProviderTypeConfig(provider.type ?? 'claude')
    return config.label
  }

  const getTypeColor = () => {
    switch (provider.type) {
      case 'codex':
        return 'green'
      default:
        return 'blue'
    }
  }

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
      return PRESET_ICON_MAP[provider.type ?? 'claude'] || PRESET_ICON_MAP.claude
    }
    if (PRESET_ICON_MAP[provider.icon]) {
      return PRESET_ICON_MAP[provider.icon]
    }
    return `file://${provider.icon}`
  }

  const renderIcon = () => {
    const iconSrc = getIconSrc()
    return <img src={iconSrc} alt={provider.name} className='w-6 h-6 object-contain' />
  }

  return (
    <Card
      className={styles.card}
      style={{
        border: `1px solid ${provider.isActive ? token.colorPrimaryBorder : token.colorBorderSecondary}`,
      }}
      hoverable
      actions={[
        <Tooltip title={t('providers.copyCommand')} key='copy'>
          <Button type='text' icon={<CopyOutlined />} onClick={handleCopyCommand} />
        </Tooltip>,
        <Tooltip title={t('keys.pricingEdit') || '编辑模型价格'} key='pricing'>
          <Button
            type='text'
            icon={<DollarOutlined />}
            onClick={() => onEditPricing?.(provider)}
            disabled={!onEditPricing}
          />
        </Tooltip>,
        <Tooltip title={t('common.edit')} key='edit'>
          <Button type='text' icon={<EditOutlined />} onClick={() => onEdit(provider)} />
        </Tooltip>,
        <Tooltip title={t('providers.refreshBalance')} key='refresh'>
          <Button
            type='text'
            icon={<ReloadOutlined spin={refreshing} />}
            onClick={() => onRefreshBalance(provider.id)}
            disabled={provider.walletBalanceType === 'none' || refreshing}
          />
        </Tooltip>,
        <Popconfirm
          key='delete'
          title={t('providers.deleteProvider')}
          description={t('providers.deleteProviderConfirm')}
          onConfirm={() => onDelete(provider.id)}
          okText={t('common.delete')}
          cancelText={t('common.cancel')}
          okButtonProps={{ danger: true }}
        >
          <Tooltip title={t('common.delete')}>
            <Button type='text' danger icon={<DeleteOutlined />} />
          </Tooltip>
        </Popconfirm>,
      ]}
    >
      <Space direction='vertical' className='w-full' size='middle'>
        <Space align='start' className='w-full justify-between'>
          <Space>
            <div
              className={clsx(
                styles.iconBox,
                provider.isActive ? styles.iconBoxActive : styles.iconBoxInactive,
              )}
            >
              {renderIcon()}
            </div>
            <div>
              <Title level={5} className='m-0!'>
                {provider.name}
              </Title>
              <Text type='secondary' className='text-xs'>
                {provider.baseUrl}
              </Text>
            </div>
          </Space>
          <Space direction='vertical' size={4} align='end'>
            <Tag
              icon={provider.isActive ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
              color={provider.isActive ? 'processing' : 'default'}
            >
              {provider.isActive ? t('common.active') : t('common.inactive')}
            </Tag>
            <Tag color={getTypeColor()}>{getTypeLabel()}</Tag>
          </Space>
        </Space>

        {provider.website && (
          <div className='flex items-center gap-1'>
            <LinkOutlined style={{ color: token.colorTextQuaternary }} />
            <a
              href={provider.website}
              target='_blank'
              rel='noopener noreferrer'
              className='text-xs truncate'
              style={{ color: token.colorPrimary }}
              onClick={(e) => e.stopPropagation()}
            >
              {provider.website}
            </a>
          </div>
        )}

        {provider.remark && (
          <Text type='secondary' className='text-xs line-clamp-2'>
            {provider.remark}
          </Text>
        )}

        {provider.walletBalanceType !== 'none' && (
          <div className={styles.balanceBox}>
            <Space direction='vertical' size={0} className='w-full'>
              <Space className='justify-between w-full'>
                <Text type='secondary'>{t('providers.balance')}</Text>
                <Text strong className={styles.balanceAmount} style={{ color: token.colorPrimary }}>
                  {formatBalance(provider.cachedWalletBalance)}
                </Text>
              </Space>
              <Text type='secondary' className={styles.lastChecked}>
                {t('providers.lastChecked')}: {formatLastChecked(provider.lastBalanceCheckedAt)}
              </Text>
            </Space>
          </div>
        )}

        <Tag color='blue'>{provider.walletBalanceType.toUpperCase()}</Tag>
      </Space>
    </Card>
  )
}
