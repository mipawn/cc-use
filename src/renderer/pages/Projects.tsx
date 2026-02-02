import { useEffect } from 'react'
import { Typography, List, Button, Empty, Popconfirm, Tag, message, theme, Card } from 'antd'
import {
  FolderOutlined,
  PlayCircleOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '../stores/projectStore'
import { useProviderStore } from '../stores/providerStore'
import type { Project } from '@shared/types'

const { Title, Text } = Typography

export default function Projects() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { projects, fetchProjects, deleteProject } = useProjectStore()
  const { providers, fetchProviders } = useProviderStore()

  useEffect(() => {
    fetchProjects()
    fetchProviders()
  }, [fetchProjects, fetchProviders])

  const getProviderName = (providerId: string | null) => {
    if (!providerId) return t('projects.noProvider')
    const provider = providers.find((p) => p.id === providerId)
    return provider?.name || t('common.unknown')
  }

  const formatDate = (timestamp: string | null) => {
    if (!timestamp) return t('common.never')
    const date = new Date(timestamp)
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString()
  }

  const handleOpen = async (project: Project) => {
    try {
      await window.api.terminal.launch(project.id)
      message.success(`${t('projects.opened')} ${project.name}`)
      fetchProjects()
    } catch (error) {
      message.error(t('projects.openFailed'))
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteProject(id)
      message.success(t('projects.projectDeleted'))
    } catch (error) {
      message.error(t('projects.deleteProjectFailed'))
    }
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <Title level={3} style={{ margin: 0, marginBottom: 4 }}>
            {t('projects.title')}
          </Title>
          <Text type="secondary">
            {t('projects.subtitle')}
          </Text>
        </div>
      </div>

      {projects.length === 0 ? (
        <Card
          style={{
            textAlign: 'center',
            padding: 48,
          }}
          bordered={true}
        >
          <FolderOutlined style={{ fontSize: 48, color: token.colorTextSecondary, marginBottom: 16 }} />
          <Title level={4} style={{ marginBottom: 8 }}>{t('projects.noProjects')}</Title>
          <Text type="secondary">
            {t('projects.dropFolderHint')}
          </Text>
        </Card>
      ) : (
        <Card bordered={false}>
          <List
            dataSource={projects}
            renderItem={(project) => (
              <List.Item
                style={{
                  padding: '16px 0',
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                }}
                actions={[
                  <Button
                    key="open"
                    type="primary"
                    size="small"
                    icon={<PlayCircleOutlined />}
                    onClick={() => handleOpen(project)}
                    style={{ borderRadius: 6 }}
                  >
                    {t('common.open')}
                  </Button>,
                  <Popconfirm
                    key="delete"
                    title={t('projects.deleteProject')}
                    description={t('projects.deleteProjectHint')}
                    onConfirm={() => handleDelete(project.id)}
                    okText={t('common.delete')}
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
                  avatar={
                    <div
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 8,
                        background: token.colorPrimaryBg,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <FolderOutlined style={{ fontSize: 20, color: token.colorPrimary }} />
                    </div>
                  }
                  title={
                    <span>
                      {project.name}{' '}
                      <Tag color="green" style={{ marginLeft: 8 }}>{getProviderName(project.providerId)}</Tag>
                    </span>
                  }
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
        </Card>
      )}
    </div>
  )
}
