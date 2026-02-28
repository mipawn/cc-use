import { getApi } from '../api'
/**
 * Dashboard - 简化的仪表盘
 * 费用统计卡片 + 趋势图 + Top 3 + 最近项目
 */
import { useEffect, useState, useCallback } from 'react'
import { Typography, Card, theme, Empty } from 'antd'
import { useAppMessage } from '../hooks/useAppMessage'
import {
  ThunderboltOutlined,
  DollarOutlined,
  WalletOutlined,
  DatabaseOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import RecentProjects from '../components/dashboard/RecentProjects'
import NewProjectModal from '../components/dashboard/NewProjectModal'
import { useProjectStore } from '../stores/projectStore'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'
import type { Project, DashboardCostStats } from '@shared/types'
import styles from './Dashboard.module.css'

const { Title, Text } = Typography

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function toLocalDateKey(d: Date): string {
  // YYYY-MM-DD in local time (stable across locales)
  const offsetMs = d.getTimezoneOffset() * 60_000
  return new Date(d.getTime() - offsetMs).toISOString().slice(0, 10)
}

export default function Dashboard() {
  const message = useAppMessage()
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const { projects, fetchProjects, createProject, deleteProject, getProjectByPath } =
    useProjectStore()
  const { providers, fetchProviders } = useProviderStore()
  const { fetchAllApiKeys, getAllApiKeys } = useApiKeyStore()

  // Modal states
  const [modalOpen, setModalOpen] = useState(false)
  const [droppedPath, setDroppedPath] = useState('')

  // Dashboard cost stats
  const [dashStats, setDashStats] = useState<DashboardCostStats | null>(null)

  // Hover state for trend bars
  const [hoveredBar, setHoveredBar] = useState<number | null>(null)

  // Get all API keys across all providers
  const allApiKeys = getAllApiKeys()

  useEffect(() => {
    fetchProjects()
    fetchProviders()
    fetchDashboardStats()
  }, [fetchProjects, fetchProviders])

  // Fetch dashboard cost statistics
  const fetchDashboardStats = async () => {
    try {
      const stats = await getApi().requestLog.getDashboardStats()
      setDashStats(stats)
    } catch (error) {
      console.error('Failed to fetch dashboard stats:', error)
    }
  }

  // Fetch API keys for all providers
  useEffect(() => {
    if (providers.length > 0) {
      fetchAllApiKeys(providers.map((p) => p.id))
    }
  }, [providers, fetchAllApiKeys])

  // Check if proxy is running
  const isProxyRunning = useCallback(async (): Promise<boolean> => {
    try {
      const status = await getApi().proxy.status()
      return status.isRunning
    } catch {
      return false
    }
  }, [])

  // Handle drop event (kept for potential future use)
  // @ts-expect-error - kept for future use when DropZone is added back
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
    const running = await isProxyRunning()
    if (!running) {
      message.warning(t('projects.proxyNotRunning'))
      return
    }

    try {
      await getApi().terminal.launch(project.id)
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
    apiKeyId: string | undefined,
  ) => {
    try {
      const project = await createProject({
        name,
        path: droppedPath,
        providerId,
        apiKeyId,
      })

      if (providerId && apiKeyId) {
        // Check proxy before launching
        const running = await isProxyRunning()
        if (!running) {
          message.warning(t('projects.proxyNotRunning'))
          return
        }

        await getApi().terminal.launch(project.id)
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

  // Build 7-day trend data (fill missing days)
  const buildWeeklyTrend = () => {
    if (!dashStats) return []
    const trendMap = new Map(dashStats.weeklyTrend.map((d) => [d.date, d]))
    const days: { date: string; cost: number; requests: number; label: string }[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const dateStr = toLocalDateKey(d)
      const item = trendMap.get(dateStr)
      days.push({
        date: dateStr,
        cost: item?.cost || 0,
        requests: item?.requests || 0,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
      })
    }
    return days
  }

  const weeklyTrend = buildWeeklyTrend()
  const maxCost = Math.max(...weeklyTrend.map((d) => d.cost), 0.0001)

  const rankClasses = [styles.topRank1, styles.topRank2, styles.topRank3]

  return (
    <div className={styles.container}>
      {/* Header - Fixed */}
      <div className={styles.header}>
        <div className={styles.headerContent}>
          <Title level={2} className={styles.title}>
            {t('dashboard.title')}
          </Title>
          <Text type='secondary' className={styles.subtitle}>
            {t('dashboard.subtitle')}
          </Text>
        </div>
      </div>

      {/* Content - Scrollable */}
      <div className={styles.content}>
        <SimpleBar className={styles.scrollContent} style={{ maxHeight: '100%' }}>
          {/* Stats Cards - 4 columns */}
          <div className={styles.statsRow}>
            <Card className={styles.statCard} variant='outlined'>
              <div className={styles.statContent}>
                <DollarOutlined className={styles.statIcon} style={{ color: token.colorWarning }} />
                <div className={styles.statInfo}>
                  <Text type='secondary' className={styles.statLabel}>
                    {t('dashboard.todayCost')}
                  </Text>
                  <Text strong className={styles.statValue}>
                    ${dashStats?.todayCost.toFixed(4) || '0.0000'}
                  </Text>
                </div>
              </div>
            </Card>
            <Card className={styles.statCard} variant='outlined'>
              <div className={styles.statContent}>
                <WalletOutlined className={styles.statIcon} style={{ color: token.colorSuccess }} />
                <div className={styles.statInfo}>
                  <Text type='secondary' className={styles.statLabel}>
                    {t('dashboard.totalCost')}
                  </Text>
                  <Text strong className={styles.statValue}>
                    ${dashStats?.totalCost.toFixed(2) || '0.00'}
                  </Text>
                </div>
              </div>
            </Card>
            <Card className={styles.statCard} variant='outlined'>
              <div className={styles.statContent}>
                <ThunderboltOutlined
                  className={styles.statIcon}
                  style={{ color: token.colorPrimary }}
                />
                <div className={styles.statInfo}>
                  <Text type='secondary' className={styles.statLabel}>
                    {t('dashboard.todayRequests')}
                  </Text>
                  <Text strong className={styles.statValue}>
                    {dashStats?.todayRequests || 0}
                  </Text>
                </div>
              </div>
            </Card>
            <Card className={styles.statCard} variant='outlined'>
              <div className={styles.statContent}>
                <DatabaseOutlined className={styles.statIcon} style={{ color: '#722ed1' }} />
                <div className={styles.statInfo}>
                  <Text type='secondary' className={styles.statLabel}>
                    {t('dashboard.todayTokens')}
                  </Text>
                  <Text strong className={styles.statValue}>
                    {formatTokens(dashStats?.todayTokens || 0)}
                  </Text>
                </div>
              </div>
            </Card>
          </div>

          {/* Weekly Trend Chart */}
          <Card
            className={styles.trendCard}
            variant='outlined'
            title={<Text strong>{t('dashboard.weeklyTrend')}</Text>}
          >
            {weeklyTrend.some((d) => d.cost > 0) ? (
              <div className={styles.trendChart}>
                {weeklyTrend.map((day, i) => (
                  <div
                    key={day.date}
                    className={styles.trendBarWrapper}
                    onMouseEnter={() => setHoveredBar(i)}
                    onMouseLeave={() => setHoveredBar(null)}
                  >
                    <div
                      style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'flex-end',
                        width: '100%',
                        justifyContent: 'center',
                        position: 'relative',
                      }}
                    >
                      <div
                        className={styles.trendBar}
                        style={{
                          height: `${Math.max((day.cost / maxCost) * 100, 2)}%`,
                          background: token.colorPrimary,
                        }}
                      >
                        {hoveredBar === i && (
                          <div className={styles.trendTooltip}>
                            ${day.cost.toFixed(4)} / {day.requests} req
                          </div>
                        )}
                      </div>
                    </div>
                    <span className={styles.trendBarLabel}>{day.label}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.trendEmpty}>
                <Text type='secondary'>{t('dashboard.noTrendData')}</Text>
              </div>
            )}
          </Card>

          {/* Top 3 Grid */}
          {dashStats?.topKeys.length || dashStats?.topProjects.length ? (
            <div className={styles.topGrid}>
              <Card
                className={styles.topCard}
                variant='outlined'
                title={<Text strong>{t('dashboard.topKeysByCost')}</Text>}
              >
                {dashStats!.topKeys.length > 0 ? (
                  <div className={styles.topList}>
                    {dashStats!.topKeys.map((item, i) => (
                      <div key={item.keyId} className={styles.topItem}>
                        <span className={`${styles.topRank} ${rankClasses[i] || ''}`}>{i + 1}</span>
                        <span className={styles.topName}>{item.keyAlias}</span>
                        <span className={styles.topCost}>${item.totalCost.toFixed(4)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className={styles.topEmpty}>{t('common.noData')}</div>
                )}
              </Card>
              <Card
                className={styles.topCard}
                variant='outlined'
                title={<Text strong>{t('dashboard.topProjectsByCost')}</Text>}
              >
                {dashStats!.topProjects.length > 0 ? (
                  <div className={styles.topList}>
                    {dashStats!.topProjects.map((item, i) => (
                      <div key={item.projectId} className={styles.topItem}>
                        <span className={`${styles.topRank} ${rankClasses[i] || ''}`}>{i + 1}</span>
                        <span className={styles.topName}>{item.projectName}</span>
                        <span className={styles.topCost}>${item.totalCost.toFixed(4)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className={styles.topEmpty}>{t('common.noData')}</div>
                )}
              </Card>
            </div>
          ) : null}

          {/* Recent Projects Section */}
          <Card
            className={styles.recentCard}
            variant='outlined'
            title={<Text strong>{t('dashboard.recentProjects')}</Text>}
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
