/**
 * RecentProjects - 最近项目列表
 * 显示绑定的 Provider/Key 信息
 */
import { Typography, Button, Empty, Popconfirm, theme, Tag, Space } from 'antd'
import {
  FolderOutlined,
  PlayCircleOutlined,
  DeleteOutlined,
  CloudServerOutlined,
  KeyOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { Project, Provider, ApiKey } from '@shared/types'
import styles from './RecentProjects.module.css'

const { Text } = Typography

interface RecentProjectsProps {
  projects: Project[]
  providers: Provider[]
  apiKeys: ApiKey[]
  onOpen: (project: Project) => void
  onDelete: (id: string) => void
}

export default function RecentProjects({
  projects,
  providers,
  apiKeys,
  onOpen,
  onDelete,
}: RecentProjectsProps) {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const formatDate = (timestamp: string | null) => {
    if (!timestamp) return t('common.never')
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return t('common.justNow') || '刚刚'
    if (diffMins < 60) return `${diffMins} ${t('common.minutesAgo') || '分钟前'}`
    if (diffHours < 24) return `${diffHours} ${t('common.hoursAgo') || '小时前'}`
    if (diffDays < 7) return `${diffDays} ${t('common.daysAgo') || '天前'}`
    return date.toLocaleDateString()
  }

  const getProviderName = (providerId: string | null) => {
    if (!providerId) return null
    const provider = providers.find((p) => p.id === providerId)
    return provider?.name || null
  }

  const getKeyAlias = (apiKeyId: string | null) => {
    if (!apiKeyId) return null
    const key = apiKeys.find((k) => k.id === apiKeyId)
    return key?.alias || `Key ${(key?.priority || 0) + 1}`
  }

  // Check if project has valid configuration
  const hasValidConfig = (project: Project) => {
    return project.providerId && project.apiKeyId
  }

  if (projects.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={t('dashboard.noRecentProjects')}
        className={styles.empty}
      />
    )
  }

  return (
    <div className={styles.container}>
      {projects.map((project, index) => (
        <div
          key={project.id}
          className={styles.projectItem}
          style={{ animationDelay: `${index * 0.03}s` }}
        >
          <div className={styles.projectIcon}>
            <FolderOutlined style={{ color: token.colorPrimary, fontSize: 18 }} />
          </div>

          <div className={styles.projectInfo}>
            <div className={styles.projectHeader}>
              <Text strong className={styles.projectName}>
                {project.name}
              </Text>
              <Space size={4} className={styles.projectTags}>
                {project.providerId ? (
                  <>
                    <Tag
                      icon={<CloudServerOutlined />}
                      color="blue"
                      className={styles.smallTag}
                    >
                      {getProviderName(project.providerId)}
                    </Tag>
                    {project.apiKeyId && (
                      <Tag icon={<KeyOutlined />} className={styles.smallTag}>
                        {getKeyAlias(project.apiKeyId)}
                      </Tag>
                    )}
                  </>
                ) : (
                  <Tag
                    icon={<WarningOutlined />}
                    color="warning"
                    className={styles.smallTag}
                  >
                    {t('projects.noProvider') || '未配置'}
                  </Tag>
                )}
              </Space>
            </div>
            <div className={styles.projectMeta}>
              <Text type="secondary" className={styles.projectPath}>
                {project.path}
              </Text>
              <Text type="secondary" className={styles.projectTime}>
                {formatDate(project.lastOpenedAt)}
              </Text>
            </div>
          </div>

          <div className={styles.projectActions}>
            <Button
              type="primary"
              size="small"
              icon={<PlayCircleOutlined />}
              onClick={() => onOpen(project)}
              className={styles.openBtn}
              disabled={!hasValidConfig(project)}
            >
              {t('common.open')}
            </Button>
            <Popconfirm
              title={t('dashboard.removeFromRecent')}
              onConfirm={() => onDelete(project.id)}
              okText={t('common.remove')}
              cancelText={t('common.cancel')}
              okButtonProps={{ danger: true }}
            >
              <Button
                type="text"
                danger
                size="small"
                icon={<DeleteOutlined />}
              />
            </Popconfirm>
          </div>
        </div>
      ))}
    </div>
  )
}
