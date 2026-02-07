/**
 * Statistics - 费用统计页面
 * 展示 API 请求费用、Top 10 排行、费用趋势、最近请求
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
} from 'antd'
import {
  DollarOutlined,
  ThunderboltOutlined,
  DatabaseOutlined,
  FieldTimeOutlined,
  BarChartOutlined,
  KeyOutlined,
  CloudServerOutlined,
  FolderOutlined,
  RobotOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import type { CostStatistics, StatsTimeRange } from '@shared/types'
import styles from './Statistics.module.css'

const { Title, Text } = Typography

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatCost(n: number): string {
  return `$${n.toFixed(4)}`
}

export default function Statistics() {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const [timeRange, setTimeRange] = useState<StatsTimeRange>('week')
  const [stats, setStats] = useState<CostStatistics | null>(null)
  const [loading, setLoading] = useState(true)
  const [hoveredBar, setHoveredBar] = useState<number | null>(null)

  useEffect(() => {
    const fetchStats = async () => {
      setLoading(true)
      try {
        const data = await window.api.requestLog.getCostStatistics(timeRange)
        setStats(data)
      } catch (error) {
        console.error('Failed to fetch cost statistics:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchStats()
  }, [timeRange])

  const timeRangeOptions = [
    { value: 'today', label: t('statistics.today') },
    { value: 'yesterday', label: t('statistics.yesterday') },
    { value: 'week', label: t('statistics.week') },
    { value: 'month', label: t('statistics.month') },
    { value: 'all', label: t('statistics.all') },
  ]

  const maxTrendCost = stats ? Math.max(...stats.dailyTrend.map((d) => d.cost), 0.0001) : 1

  // Top table columns (shared pattern)
  const makeTopColumns = (nameLabel: string) => [
    {
      title: t('statistics.rank'),
      key: 'rank',
      width: 50,
      render: (_: unknown, __: unknown, index: number) => (
        <span style={{ fontWeight: index < 3 ? 600 : 400 }}>{index + 1}</span>
      ),
    },
    {
      title: nameLabel,
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
    },
    {
      title: t('statistics.cost'),
      dataIndex: 'totalCost',
      key: 'totalCost',
      width: 110,
      align: 'right' as const,
      render: (v: number) => <Text strong>{formatCost(v)}</Text>,
    },
    {
      title: t('statistics.requests'),
      dataIndex: 'totalRequests',
      key: 'totalRequests',
      width: 80,
      align: 'right' as const,
    },
    {
      title: t('statistics.tokens'),
      dataIndex: 'totalTokens',
      key: 'totalTokens',
      width: 90,
      align: 'right' as const,
      render: (v: number) => formatTokens(v),
    },
  ]

  const recentColumns = [
    {
      title: t('statistics.model'),
      dataIndex: 'model',
      key: 'model',
      width: 160,
      ellipsis: true,
      render: (v: string | null) => v || '-',
    },
    {
      title: t('statistics.key'),
      dataIndex: 'keyAlias',
      key: 'keyAlias',
      width: 120,
      ellipsis: true,
      render: (v: string | null) => v || '-',
    },
    {
      title: t('statistics.provider'),
      dataIndex: 'providerName',
      key: 'providerName',
      width: 120,
      ellipsis: true,
      render: (v: string | null) => v || '-',
    },
    {
      title: t('statistics.cost'),
      dataIndex: 'totalCostUsd',
      key: 'totalCostUsd',
      width: 100,
      align: 'right' as const,
      render: (v: number) => <Text strong>{formatCost(v)}</Text>,
    },
    {
      title: t('statistics.inputTokens'),
      dataIndex: 'inputTokens',
      key: 'inputTokens',
      width: 100,
      align: 'right' as const,
      render: (v: number) => formatTokens(v),
    },
    {
      title: t('statistics.outputTokens'),
      dataIndex: 'outputTokens',
      key: 'outputTokens',
      width: 100,
      align: 'right' as const,
      render: (v: number) => formatTokens(v),
    },
    {
      title: t('statistics.latency'),
      dataIndex: 'latencyMs',
      key: 'latencyMs',
      width: 80,
      align: 'right' as const,
      render: (v: number | null) => (v != null ? `${v}ms` : '-'),
    },
    {
      title: t('statistics.status'),
      dataIndex: 'statusCode',
      key: 'statusCode',
      width: 70,
      render: (v: number | null) => {
        if (v == null) return '-'
        return <Tag color={v >= 200 && v < 300 ? 'green' : 'red'}>{v}</Tag>
      },
    },
    {
      title: t('statistics.time'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 160,
      render: (v: string) => new Date(v).toLocaleString(),
    },
  ]

  const hasData = stats && stats.summary.totalRequests > 0

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <div>
          <Title level={3} className="!m-0 !mb-1">
            {t('statistics.title')}
          </Title>
          <Text type="secondary">
            {t('statistics.subtitle')}
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

      {/* Content */}
      <div className={styles.content}>
        <SimpleBar className={styles.scrollContent} style={{ maxHeight: '100%' }}>
          {loading ? (
            <div className={styles.loadingState}>
              <Spin size="large" />
            </div>
          ) : hasData ? (
            <div className={styles.statsContent}>
              {/* Summary Cards */}
              <div className={styles.summaryRow}>
                <Card className={styles.summaryCard} variant="outlined">
                  <Statistic
                    title={t('statistics.totalCost')}
                    value={stats!.summary.totalCostUsd}
                    precision={4}
                    prefix={<DollarOutlined style={{ color: token.colorWarning }} />}
                    formatter={(v) => `$${Number(v).toFixed(4)}`}
                  />
                </Card>
                <Card className={styles.summaryCard} variant="outlined">
                  <Statistic
                    title={t('statistics.totalRequests')}
                    value={stats!.summary.totalRequests}
                    prefix={<ThunderboltOutlined style={{ color: token.colorPrimary }} />}
                  />
                </Card>
                <Card className={styles.summaryCard} variant="outlined">
                  <Statistic
                    title={t('statistics.totalTokens')}
                    value={stats!.summary.totalInputTokens + stats!.summary.totalOutputTokens}
                    prefix={<DatabaseOutlined style={{ color: '#722ed1' }} />}
                    formatter={(v) => formatTokens(Number(v))}
                  />
                </Card>
                <Card className={styles.summaryCard} variant="outlined">
                  <Statistic
                    title={t('statistics.avgLatency')}
                    value={stats!.summary.avgLatencyMs || 0}
                    suffix="ms"
                    precision={0}
                    prefix={<FieldTimeOutlined style={{ color: token.colorSuccess }} />}
                  />
                </Card>
              </div>

              {/* Daily Trend Chart */}
              {stats!.dailyTrend.length > 0 && (
                <Card
                  className={styles.trendCard}
                  variant="outlined"
                  title={
                    <Space>
                      <BarChartOutlined style={{ color: token.colorPrimary }} />
                      <span>{t('statistics.dailyTrend')}</span>
                    </Space>
                  }
                >
                  {stats!.dailyTrend.some((d) => d.cost > 0) ? (
                    <div className={styles.trendChart}>
                      {stats!.dailyTrend.map((day, i) => (
                        <div
                          key={day.date}
                          className={styles.trendBarWrapper}
                          onMouseEnter={() => setHoveredBar(i)}
                          onMouseLeave={() => setHoveredBar(null)}
                        >
                          <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', width: '100%', justifyContent: 'center', position: 'relative' }}>
                            <div
                              className={styles.trendBar}
                              style={{
                                height: `${Math.max((day.cost / maxTrendCost) * 100, 2)}%`,
                                background: token.colorPrimary,
                              }}
                            >
                              {hoveredBar === i && (
                                <div className={styles.trendTooltip}>
                                  {day.date}: ${day.cost.toFixed(4)} / {day.requests} req
                                </div>
                              )}
                            </div>
                          </div>
                          <span className={styles.trendBarLabel}>
                            {(() => {
                              const d = new Date(day.date + 'T00:00:00')
                              return `${d.getMonth() + 1}/${d.getDate()}`
                            })()}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.trendEmpty}>
                      <Text type="secondary">{t('statistics.noData')}</Text>
                    </div>
                  )}
                </Card>
              )}

              {/* Top 10 Tables - Row 1 */}
              <div className={styles.tablesGrid}>
                <Card
                  className={styles.tableCard}
                  variant="outlined"
                  title={
                    <Space>
                      <KeyOutlined style={{ color: token.colorPrimary }} />
                      <span>{t('statistics.topKeysByCost')}</span>
                    </Space>
                  }
                >
                  <Table
                    dataSource={stats!.topKeys.map((k) => ({ ...k, name: k.keyAlias, key: k.keyId }))}
                    columns={makeTopColumns(t('statistics.key'))}
                    rowKey="keyId"
                    size="small"
                    pagination={false}
                    scroll={{ y: 240 }}
                  />
                </Card>

                <Card
                  className={styles.tableCard}
                  variant="outlined"
                  title={
                    <Space>
                      <CloudServerOutlined style={{ color: token.colorPrimary }} />
                      <span>{t('statistics.topProvidersByCost')}</span>
                    </Space>
                  }
                >
                  <Table
                    dataSource={stats!.topProviders.map((p) => ({ ...p, name: p.providerName, key: p.providerId }))}
                    columns={makeTopColumns(t('statistics.provider'))}
                    rowKey="providerId"
                    size="small"
                    pagination={false}
                    scroll={{ y: 240 }}
                  />
                </Card>
              </div>

              {/* Top 10 Tables - Row 2 */}
              <div className={styles.tablesGrid}>
                <Card
                  className={styles.tableCard}
                  variant="outlined"
                  title={
                    <Space>
                      <FolderOutlined style={{ color: token.colorPrimary }} />
                      <span>{t('statistics.topProjectsByCost')}</span>
                    </Space>
                  }
                >
                  <Table
                    dataSource={stats!.topProjects.map((p) => ({ ...p, name: p.projectName, key: p.projectId }))}
                    columns={makeTopColumns(t('statistics.project'))}
                    rowKey="projectId"
                    size="small"
                    pagination={false}
                    scroll={{ y: 240 }}
                  />
                </Card>

                <Card
                  className={styles.tableCard}
                  variant="outlined"
                  title={
                    <Space>
                      <RobotOutlined style={{ color: token.colorPrimary }} />
                      <span>{t('statistics.topModelsByCost')}</span>
                    </Space>
                  }
                >
                  <Table
                    dataSource={stats!.topModels.map((m) => ({ ...m, name: m.model, key: m.model }))}
                    columns={makeTopColumns(t('statistics.model'))}
                    rowKey="model"
                    size="small"
                    pagination={false}
                    scroll={{ y: 240 }}
                  />
                </Card>
              </div>

              {/* Recent Requests */}
              <Card
                className={styles.recentCard}
                variant="outlined"
                title={
                  <Space>
                    <BarChartOutlined style={{ color: token.colorPrimary }} />
                    <span>{t('statistics.recentRequests')}</span>
                  </Space>
                }
              >
                <Table
                  dataSource={stats!.recentRequests}
                  columns={recentColumns}
                  rowKey="id"
                  size="small"
                  pagination={{ pageSize: 10 }}
                  scroll={{ x: 1000 }}
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
                {t('statistics.noData')}
              </Title>
              <Text type="secondary" className="block">
                {t('statistics.noDataHint')}
              </Text>
            </Card>
          )}
        </SimpleBar>
      </div>
    </div>
  )
}
