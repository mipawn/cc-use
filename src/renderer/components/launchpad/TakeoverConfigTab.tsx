import { useState } from 'react'
import { Avatar, Button, Empty, Tag, Typography } from 'antd'
import {
  ApiOutlined,
  ArrowRightOutlined,
  CheckCircleOutlined,
  KeyOutlined,
  QuestionCircleOutlined,
  SwapOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import type { ApiKey, ClientKind, Provider } from '@shared/types'
import { getClientKindLabel } from '@shared/types'
import RoutePickerModal, { getRouteModelLabel } from '../common/RoutePickerModal'
import { isOfficialDeepSeekProvider } from '../../utils/officialProviders'
import claudeIcon from '../../assets/provider-icons/claude.svg'
import openaiIcon from '../../assets/provider-icons/openai.svg'
import deepseekIcon from '../../assets/provider-icons/deepseek.svg'
import newapiIcon from '../../assets/provider-icons/newapi.svg'
import styles from './TakeoverConfigTab.module.css'

const { Text, Title } = Typography

export type TakeoverStatus = 'taken_over' | 'official' | 'not_found' | 'unknown' | 'error'

const PRESET_ICON_MAP: Record<string, string> = {
  claude: claudeIcon,
  claude_code: claudeIcon,
  claude_desktop: claudeIcon,
  codex: openaiIcon,
  openai: openaiIcon,
  deepseek: deepseekIcon,
  newapi: newapiIcon,
}

export interface TakeoverConfigTabProps {
  status: TakeoverStatus
  providers: Provider[]
  allKeys: ApiKey[]
  activeKeyId: string
  compatibleProviderType?: string
  targetClientKind?: ClientKind
  onTakeover: (keyId: string) => Promise<void>
  onReorderProviders?: (providerIds: string[]) => Promise<void> | void
  onReorderApiKeys?: (providerId: string, keyIds: string[]) => Promise<void> | void
  onEdit?: (key: ApiKey) => void
  onDelete?: (key: ApiKey) => void
  onToggleEnabled?: (key: ApiKey, enabled: boolean) => void
}

function statusBadge(status: TakeoverStatus) {
  switch (status) {
    case 'taken_over':
      return (
        <Tag color='green' icon={<CheckCircleOutlined />}>
          已接管
        </Tag>
      )
    case 'official':
      return <Tag color='blue'>官方配置</Tag>
    case 'not_found':
      return <Tag icon={<QuestionCircleOutlined />}>配置不存在</Tag>
    case 'error':
      return (
        <Tag color='warning' icon={<WarningOutlined />}>
          检测失败
        </Tag>
      )
    default:
      return <Tag color='warning'>未知</Tag>
  }
}

function providerIcon(provider: Provider) {
  if (!provider.icon) return claudeIcon
  return PRESET_ICON_MAP[provider.icon] || `file://${provider.icon}`
}

export default function TakeoverConfigTab({
  status,
  providers,
  allKeys,
  activeKeyId,
  targetClientKind = 'codex',
  onTakeover,
  onReorderApiKeys,
}: TakeoverConfigTabProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const activeKey = allKeys.find((key) => key.id === activeKeyId)
  const activeProvider = activeKey
    ? providers.find((provider) => provider.id === activeKey.providerId)
    : undefined

  return (
    <div className={styles.root}>
      <div className={styles.sectionHeading}>
        <div>
          <Text type='secondary' className={styles.eyebrow}>
            当前线路
          </Text>
          <Title level={4} className={styles.title}>
            {getClientKindLabel(targetClientKind)}
          </Title>
        </div>
        {statusBadge(status)}
      </div>

      {status === 'taken_over' && activeProvider && activeKey ? (
        <section className={styles.routeCard}>
          <div className={styles.routeRail}>
            <div className={styles.routeNode}>
              <span className={styles.nodeIcon}>
                <ApiOutlined />
              </span>
              <span className={styles.nodeBody}>
                <Text type='secondary'>客户端</Text>
                <Text strong>{getClientKindLabel(targetClientKind)}</Text>
              </span>
            </div>
            <ArrowRightOutlined className={styles.routeArrow} />
            <div className={styles.routeNode}>
              <Avatar src={providerIcon(activeProvider)} size={34} />
              <span className={styles.nodeBody}>
                <span className={styles.nodeTitleLine}>
                  <Text type='secondary'>供应商</Text>
                  {isOfficialDeepSeekProvider(activeProvider) && (
                    <Tag color='blue' variant='filled'>
                      官方
                    </Tag>
                  )}
                </span>
                <Text strong>{activeProvider.name}</Text>
              </span>
            </div>
            <ArrowRightOutlined className={styles.routeArrow} />
            <div className={styles.routeNode}>
              <span className={styles.nodeIcon}>
                <KeyOutlined />
              </span>
              <span className={styles.nodeBody}>
                <Text type='secondary'>密钥</Text>
                <Text strong>{activeKey.alias || `Key ${activeKey.priority + 1}`}</Text>
              </span>
            </div>
            <ArrowRightOutlined className={styles.routeArrow} />
            <div className={styles.routeNode}>
              <span className={styles.modelBadge}>M</span>
              <span className={styles.nodeBody}>
                <Text type='secondary'>模型</Text>
                <Text
                  strong
                  ellipsis={{ tooltip: getRouteModelLabel(activeKey, targetClientKind) }}
                >
                  {getRouteModelLabel(activeKey, targetClientKind)}
                </Text>
              </span>
            </div>
          </div>

          <div className={styles.routeActions}>
            <div>
              <Text strong>线路已生效</Text>
              <Text type='secondary' className={styles.routeHint}>
                同一接管配置下切换密钥会在下一次请求生效
              </Text>
            </div>
            <Button type='primary' icon={<SwapOutlined />} onClick={() => setPickerOpen(true)}>
              更换线路
            </Button>
          </div>
        </section>
      ) : (
        <section className={styles.emptyCard}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span>
                <Text strong>尚未由 cc-use 接管</Text>
                <Text type='secondary' className={styles.emptyHint}>
                  选择供应商和密钥后，cc-use 会保留原配置并建立可恢复的接管线路
                </Text>
              </span>
            }
          >
            <Button type='primary' icon={<SwapOutlined />} onClick={() => setPickerOpen(true)}>
              选择线路并接管
            </Button>
          </Empty>
        </section>
      )}

      <RoutePickerModal
        open={pickerOpen}
        clientKind={targetClientKind}
        providers={providers}
        apiKeys={allKeys}
        currentKeyId={activeKeyId}
        actionText={status === 'taken_over' ? '切换线路' : '接管这条线路'}
        onCancel={() => setPickerOpen(false)}
        onSelect={({ apiKey }) => onTakeover(apiKey.id)}
        onReorderApiKeys={onReorderApiKeys}
      />
    </div>
  )
}
