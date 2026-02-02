import { List, Typography, Button, Empty, Popconfirm, theme } from 'antd'
import {
  FolderOutlined,
  PlayCircleOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { Project } from '@shared/types'

const { Text } = Typography

interface RecentProjectsProps {
  projects: Project[]
  onOpen: (project: Project) => void
  onDelete: (id: string) => void
}

export default function RecentProjects({
  projects,
  onOpen,
  onDelete,
}: RecentProjectsProps) {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const formatDate = (timestamp: string | null) => {
    if (!timestamp) return t('common.never')
    const date = new Date(timestamp)
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString()
  }

  if (projects.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={t('dashboard.noRecentProjects')}
      />
    )
  }

  return (
    <List
      dataSource={projects}
      renderItem={(project) => (
        <List.Item
          actions={[
            <Button
              key="open"
              type="primary"
              size="small"
              icon={<PlayCircleOutlined />}
              onClick={() => onOpen(project)}
            >
              {t('common.open')}
            </Button>,
            <Popconfirm
              key="delete"
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
            </Popconfirm>,
          ]}
        >
          <List.Item.Meta
            avatar={<FolderOutlined style={{ fontSize: 24, color: token.colorTextSecondary }} />}
            title={project.name}
            description={
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {project.path}
                </Text>
                <br />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('projects.lastOpened')}: {formatDate(project.lastOpenedAt)}
                </Text>
              </div>
            }
          />
        </List.Item>
      )}
    />
  )
}
