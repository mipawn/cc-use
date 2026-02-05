/**
 * Dashboard - 简化的仪表盘
 * 快捷入口 + 最近项目 + 今日 Key 使用统计
 */
import { useEffect, useState, useCallback } from 'react'
import { Typography, message, Card, theme, Empty } from 'antd'
import {
  ThunderboltOutlined,
  RocketOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import DropZone from '../components/dashboard/DropZone'
import RecentProjects from '../components/dashboard/RecentProjects'
import NewProjectModal from '../components/dashboard/NewProjectModal'
import { useProjectStore } from '../stores/projectStore'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'
import type { Project } from '@shared/types'
import styles from './Dashboard.module.css'

const { Title, Text } = Typography

export default function Dashboard() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const {
    projects,
    fetchProjects,
    createProject,
    deleteProject,
    getProjectByPath,
  } = useProjectStore()
  const { providers, fetchProviders } = useProviderStore()
  const { fetchAllApiKeys, getAllApiKeys } = useApiKeyStore()

  // Modal states
  const [modalOpen, setModalOpen] = useState(false)
  const [droppedPath, setDroppedPath] = useState('')

  // Today's stats from usage logs
  const [todayStats, setTodayStats] = useState({ launches: 0, uniqueProjects: 0, uniqueKeys: 0 })

  // Get all API keys across all providers
  const allApiKeys = getAllApiKeys()

  useEffect(() => {
    fetchProjects()
    fetchProviders()
    fetchTodayStats()
  }, [fetchProjects, fetchProviders])

  // Fetch today's quick stats
  const fetchTodayStats = async () => {
    try {
      const stats = await window.api.usageLog.getTodayQuickStats()
      setTodayStats(stats)
    } catch (error) {
      console.error('Failed to fetch today stats:', error)
    }
  }

  // Fetch API keys for all providers
  useEffect(() => {
    if (providers.length > 0) {
      fetchAllApiKeys(providers.map((p) => p.id))
    }
  }, [providers, fetchAllApiKeys])

  // Ensure proxy is running before launching terminal
  const ensureProxyRunning = useCallback(async (): Promise<boolean> => {
    try {
      const status = await window.api.proxy.status()
      if (status.isRunning) {
        return true
      }

      // Start proxy if not running
      await window.api.proxy.start()

      // Wait a bit for proxy to be ready
      await new Promise((resolve) => setTimeout(resolve, 500))

      const newStatus = await window.api.proxy.status()
      return newStatus.isRunning
    } catch (error) {
      console.error('Failed to start proxy:', error)
      return false
    }
  }, [])

  // Handle drop event
  const handleDrop = async (path: string) => {
    try {
      const existingProject = await getProjectByPath(path)

      if (existingProject) {
        // Project exists - launch it
        if (existingProject.providerId && existingProject.apiKeyId) {
          await launchProject(existingProject)
        } else {
          // No bound key - prompt to configure in Projects page
          message.info(t('dashboard.configureKeyFirst') || '请先在项目页面配置 API 密钥')
        }
      } else {
        // Project doesn't exist, show modal
        setDroppedPath(path)
        setModalOpen(true)
      }
    } catch (error) {
      message.error(t('messages.processFolderFailed'))
    }
  }

  // Launch project with its bound key
  const launchProject = async (project: Project) => {
    const proxyReady = await ensureProxyRunning()
    if (!proxyReady) {
      message.error(t('dashboard.proxyStartFailed') || '代理服务启动失败')
      return
    }

    try {
      await window.api.terminal.launch(project.id)
      message.success(`${t('projects.opened')} ${project.name}`)
      fetchProjects()
    } catch (error) {
      message.error(t('projects.openFailed'))
    }
  }

  // Handle create new project
  const handleCreateProject = async (
    name: string,
    providerId: string | undefined,
    apiKeyId: string | undefined
  ) => {
    try {
      const project = await createProject({
        name,
        path: droppedPath,
        providerId,
        apiKeyId,
      })

      if (providerId && apiKeyId) {
        // Ensure proxy and launch
        const proxyReady = await ensureProxyRunning()
        if (!proxyReady) {
          message.warning(t('dashboard.proxyStartFailed') || '代理服务启动失败，项目已创建')
          return
        }

        await window.api.terminal.launch(project.id)
        message.success(`${t('newProject.createdAndOpened')} ${name}`)
      } else {
        message.success(t('projects.projectCreated') || '项目创建成功')
      }
    } catch (error) {
      throw error
    }
  }

  // Handle open from recent projects
  const handleOpenProject = async (project: Project) => {
    if (project.providerId && project.apiKeyId) {
      await launchProject(project)
    } else {
      message.info(t('dashboard.configureKeyFirst') || '请先在项目页面配置 API 密钥')
    }
  }

  const handleDeleteProject = async (id: string) => {
    try {
      await deleteProject(id)
      message.success(t('messages.projectRemoved'))
    } catch (error) {
      message.error(t('messages.removeProjectFailed'))
    }
  }

  // Calculate today's key usage stats
  const getTodayStats = () => {
    const activeKeys = allApiKeys.filter(k => !k.isExhausted).length
    const totalKeys = allApiKeys.length
    return { activeKeys, totalKeys, todayLaunches: todayStats.launches }
  }

  const stats = getTodayStats()

  return (
    <div className={styles.container}>
      {/* Header - Fixed */}
      <div className={styles.header}>
        <div className={styles.headerContent}>
          <Title level={2} className={styles.title}>
            {t('dashboard.title')}
          </Title>
          <Text type="secondary" className={styles.subtitle}>
            {t('dashboard.subtitle')}
          </Text>
        </div>
      </div>

      {/* Content - Scrollable */}
      <div className={styles.content}>
        <SimpleBar className={styles.scrollContent} style={{ maxHeight: '100%' }}>
        {/* Stats Cards */}
        <div className={styles.statsRow}>
          <Card className={styles.statCard} variant="outlined">
            <div className={styles.statContent}>
              <RocketOutlined className={styles.statIcon} style={{ color: token.colorWarning }} />
              <div className={styles.statInfo}>
                <Text type="secondary" className={styles.statLabel}>
                  {t('dashboard.todayLaunches') || '今日启动'}
                </Text>
                <Text strong className={styles.statValue}>
                  {stats.todayLaunches}
                </Text>
              </div>
            </div>
          </Card>
          <Card className={styles.statCard} variant="outlined">
            <div className={styles.statContent}>
              <ThunderboltOutlined className={styles.statIcon} style={{ color: token.colorPrimary }} />
              <div className={styles.statInfo}>
                <Text type="secondary" className={styles.statLabel}>
                  {t('dashboard.activeKeys') || '可用密钥'}
                </Text>
                <Text strong className={styles.statValue}>
                  {stats.activeKeys} / {stats.totalKeys}
                </Text>
              </div>
            </div>
          </Card>
        </div>

        {/* Drop Zone - Quick Launch */}
        <Card
          className={styles.dropZoneCard}
          variant="outlined"
          title={
            <Text strong>{t('dashboard.quickLaunch') || '快速启动'}</Text>
          }
        >
          <DropZone
            onDrop={handleDrop}
            hint={t('dashboard.dropZone')}
          />
        </Card>

        {/* Recent Projects Section */}
        <Card
          className={styles.recentCard}
          variant="outlined"
          title={
            <Text strong>{t('dashboard.recentProjects')}</Text>
          }
        >
          {projects.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t('dashboard.noRecentProjects')}
            />
          ) : (
            <RecentProjects
              projects={projects.slice(0, 8)}
              providers={providers}
              apiKeys={allApiKeys}
              onOpen={handleOpenProject}
              onDelete={handleDeleteProject}
            />
          )}
        </Card>
        </SimpleBar>
      </div>

      <NewProjectModal
        open={modalOpen}
        path={droppedPath}
        providers={providers}
        apiKeys={allApiKeys}
        onClose={() => {
          setModalOpen(false)
          setDroppedPath('')
        }}
        onSave={handleCreateProject}
      />
    </div>
  )
}
