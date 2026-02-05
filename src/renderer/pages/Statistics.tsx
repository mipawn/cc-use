/**
 * Statistics - 使用统计页面
 * 展示今日/昨日/一周/本月的使用量
 */
import { useEffect, useState } from 'react'
import {
  Typography,
  Card,
  Segmented,
  Table,
  Tag,
  Spin,
  theme,
  Space,
  Statistic,
  Row,
  Col,
} from 'antd'
import {
  ThunderboltOutlined,
  FolderOutlined,
  KeyOutlined,
  BarChartOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import type { UsageStats, StatsTimeRange, UsageLog } from '@shared/types'
import styles from './Statistics.module.css'

const { Title, Text } = Typography

export default function Statistics() {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const [timeRange, setTimeRange] = useState<StatsTimeRange>('today')
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [recentLogs, setRecentLogs] = useState<UsageLog[]>([])
  const [loading, setLoading] = useState(true)

  // Fetch stats when time range changes
  useEffect(() => {
    const fetchStats = async () => {
      setLoading(true)
      try {
        const [statsData, logsData] = await Promise.all([
          window.api.usageLog.getStats(timeRange),
          window.api.usageLog.getRecent(20),
        ])
        setStats(statsData)
        setRecentLogs(logsData)
      } catch (error) {
        console.error('Failed to fetch stats:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchStats()
  }, [timeRange])

  const timeRangeOptions = [
    { value: 'today', label: t('statistics.today') || '今日' },
    { value: 'yesterday', label: t('statistics.yesterday') || '昨日' },
    { value: 'week', label: t('statistics.week') || '近7天' },
    { value: 'month', label: t('statistics.month') || '本月' },
    { value: 'all', label: t('statistics.all') || '全部' },
  ]

  const projectColumns = [
    {
      title: t('statistics.projectName') || '项目名称',
      dataIndex: 'projectName',
      key: 'projectName',
      ellipsis: true,
    },
    {
      title: t('statistics.launchCount') || '启动次数',
      dataIndex: 'count',
      key: 'count',
      width: 100,
      align: 'right' as const,
      render: (count: number) => (
        <Tag color="blue">{count}</Tag>
      ),
    },
  ]

  const keyColumns = [
    {
      title: t('statistics.keyAlias') || '密钥别名',
      dataIndex: 'keyAlias',
      key: 'keyAlias',
      ellipsis: true,
    },
    {
      title: t('statistics.provider') || '供应商',
      dataIndex: 'providerName',
      key: 'providerName',
      ellipsis: true,
    },
    {
      title: t('statistics.type') || '类型',
      dataIndex: 'keyType',
      key: 'keyType',
      width: 80,
      render: (keyType: string) => (
        <Tag color={keyType === 'codex' ? 'green' : 'blue'}>
          {keyType === 'codex' ? 'Codex' : 'Claude'}
        </Tag>
      ),
    },
    {
      title: t('statistics.launchCount') || '启动次数',
      dataIndex: 'count',
      key: 'count',
      width: 100,
      align: 'right' as const,
      render: (count: number) => (
        <Tag color="blue">{count}</Tag>
      ),
    },
  ]

  const recentColumns = [
    {
      title: t('statistics.projectName') || '项目',
      dataIndex: 'projectName',
      key: 'projectName',
      ellipsis: true,
    },
    {
      title: t('statistics.keyUsed') || '使用密钥',
      dataIndex: 'apiKeyAlias',
      key: 'apiKeyAlias',
      ellipsis: true,
      render: (alias: string, record: UsageLog) => (
        <Space size={4}>
          <span>{alias || 'Unknown'}</span>
          {record.keyType && (
            <Tag color={record.keyType === 'codex' ? 'green' : 'blue'} style={{ fontSize: 10, padding: '0 4px', margin: 0 }}>
              {record.keyType === 'codex' ? 'Codex' : 'Claude'}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: t('statistics.launchedAt') || '时间',
      dataIndex: 'launchedAt',
      key: 'launchedAt',
      width: 160,
      render: (time: string) => {
        const date = new Date(time)
        return date.toLocaleString()
      },
    },
  ]

  return (
    <div className={styles.container}>
      {/* Header - Fixed */}
      <div className={styles.header}>
        <div>
          <Title level={3} className="!m-0 !mb-1">
            {t('statistics.title') || '使用统计'}
          </Title>
          <Text type="secondary">
            {t('statistics.subtitle') || '查看项目和密钥使用情况'}
          </Text>
        </div>
      </div>

      {/* Time Range Filter */}
      <div className={styles.filterSection}>
        <Segmented
          value={timeRange}
          onChange={(value) => setTimeRange(value as StatsTimeRange)}
          options={timeRangeOptions}
          className={styles.filterSegmented}
        />
      </div>

      {/* Content - Scrollable */}
      <div className={styles.content}>
        <SimpleBar className={styles.scrollContent} style={{ maxHeight: '100%' }}>
          {loading ? (
            <div className={styles.loadingState}>
              <Spin size="large" />
            </div>
          ) : stats && stats.totalLaunches > 0 ? (
            <div className={styles.statsContent}>
              {/* Summary Cards */}
              <Row gutter={[16, 16]} className={styles.summaryRow}>
                <Col xs={24} sm={8}>
                  <Card className={styles.summaryCard} variant="outlined">
                    <Statistic
                      title={t('statistics.totalLaunches') || '总启动次数'}
                      value={stats.totalLaunches}
                      prefix={<ThunderboltOutlined style={{ color: token.colorPrimary }} />}
                    />
                  </Card>
                </Col>
                <Col xs={24} sm={8}>
                  <Card className={styles.summaryCard} variant="outlined">
                    <Statistic
                      title={t('statistics.uniqueProjects') || '项目数'}
                      value={stats.uniqueProjects}
                      prefix={<FolderOutlined style={{ color: token.colorSuccess }} />}
                    />
                  </Card>
                </Col>
                <Col xs={24} sm={8}>
                  <Card className={styles.summaryCard} variant="outlined">
                    <Statistic
                      title={t('statistics.uniqueKeys') || '密钥数'}
                      value={stats.uniqueKeys}
                      prefix={<KeyOutlined style={{ color: token.colorWarning }} />}
                    />
                  </Card>
                </Col>
              </Row>

              {/* Tables Grid */}
              <div className={styles.tablesGrid}>
                {/* By Project */}
                <Card
                  className={styles.tableCard}
                  variant="outlined"
                  title={
                    <Space>
                      <FolderOutlined style={{ color: token.colorPrimary }} />
                      <span>{t('statistics.byProject') || '按项目统计'}</span>
                    </Space>
                  }
                >
                  <Table
                    dataSource={stats.byProject}
                    columns={projectColumns}
                    rowKey="projectId"
                    size="small"
                    pagination={false}
                    scroll={{ y: 200 }}
                  />
                </Card>

                {/* By Key */}
                <Card
                  className={styles.tableCard}
                  variant="outlined"
                  title={
                    <Space>
                      <KeyOutlined style={{ color: token.colorPrimary }} />
                      <span>{t('statistics.byKey') || '按密钥统计'}</span>
                    </Space>
                  }
                >
                  <Table
                    dataSource={stats.byKey}
                    columns={keyColumns}
                    rowKey="keyId"
                    size="small"
                    pagination={false}
                    scroll={{ y: 200 }}
                  />
                </Card>
              </div>

              {/* Recent Activity */}
              <Card
                className={styles.recentCard}
                variant="outlined"
                title={
                  <Space>
                    <BarChartOutlined style={{ color: token.colorPrimary }} />
                    <span>{t('statistics.recentActivity') || '最近活动'}</span>
                  </Space>
                }
              >
                <Table
                  dataSource={recentLogs}
                  columns={recentColumns}
                  rowKey="id"
                  size="small"
                  pagination={{ pageSize: 10 }}
                />
              </Card>
            </div>
          ) : (
            <Card className="empty-state" variant="outlined">
              <BarChartOutlined
                className="text-5xl mb-4"
                style={{ color: token.colorTextSecondary }}
              />
              <Title level={4} className="!mb-2">
                {t('statistics.noData') || '暂无数据'}
              </Title>
              <Text type="secondary" className="block">
                {t('statistics.noDataHint') || '启动项目后将在这里显示使用统计'}
              </Text>
            </Card>
          )}
        </SimpleBar>
      </div>
    </div>
  )
}
