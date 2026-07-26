import { getApi } from '../api'
/**
 * Statistics - 用量统计页面
 * 展示 API 请求 Token / 费用、Top 10 排行、每日趋势、最近请求
 */
import { useEffect, useState } from 'react'
import type { TablePaginationConfig } from 'antd'
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
  Button,
  Tooltip,
} from 'antd'
import {
  DollarOutlined,
  ThunderboltOutlined,
  DatabaseOutlined,
  FieldTimeOutlined,
  BarChartOutlined,
  KeyOutlined,
  CloudServerOutlined,
  RobotOutlined,
  SettingOutlined,
  FolderOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import type { CostStatistics, PaginatedRecentRequests, StatsTimeRange } from '@shared/types'
import ModelPricingModal from '../components/common/ModelPricingModal'
import {
  formatExactTokenCount,
  formatTokenCount,
  formatTokenCountWithUnit,
} from '../utils/formatTokens'
import { getInitialUsageMetric, saveUsageMetric, type UsageMetric } from '../utils/usageMetric'
import styles from './Statistics.module.css'

const { Title, Text } = Typography

function formatCost(n: number): string {
  return `$${n.toFixed(4)}`
}

function displayName(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed || fallback
}

export default function Statistics() {
  const { t, i18n } = useTranslation()
  const { token } = theme.useToken()
  const language = i18n.resolvedLanguage || i18n.language

  const renderTokens = (value: number) => (
    <Tooltip title={formatExactTokenCount(value, language)}>
      <span>{formatTokenCount(value, language)}</span>
    </Tooltip>
  )

  const [timeRange, setTimeRange] = useState<StatsTimeRange>('week')
  const [usageMetric, setUsageMetric] = useState<UsageMetric>(getInitialUsageMetric)
  const [stats, setStats] = useState<CostStatistics | null>(null)
  const [loading, setLoading] = useState(true)
  const [recentRequests, setRecentRequests] = useState<PaginatedRecentRequests | null>(null)
  const [recentLoading, setRecentLoading] = useState(true)
  const [recentPage, setRecentPage] = useState(1)
  const [recentPageSize, setRecentPageSize] = useState(10)
  const [hoveredBar, setHoveredBar] = useState<number | null>(null)
  const [pricingModalOpen, setPricingModalOpen] = useState(false)
  useEffect(() => {
    let cancelled = false

    const fetchStats = async () => {
      setLoading(true)
      try {
        const data = await getApi().requestLog.getCostStatistics(timeRange, usageMetric)
        if (!cancelled) {
          setStats(data)
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to fetch usage statistics:', error)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void fetchStats()
    return () => {
      cancelled = true
    }
  }, [timeRange, usageMetric])

  useEffect(() => {
    let cancelled = false

    const fetchRecentRequests = async () => {
      setRecentLoading(true)
      try {
        const data = await getApi().requestLog.getRecentPaginated(
          timeRange,
          recentPage,
          recentPageSize,
        )
        if (!cancelled) {
          setRecentRequests(data)
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to fetch recent requests:', error)
        }
      } finally {
        if (!cancelled) {
          setRecentLoading(false)
        }
      }
    }

    void fetchRecentRequests()
    return () => {
      cancelled = true
    }
  }, [timeRange, recentPage, recentPageSize])

  useEffect(() => {
    setRecentPage(1)
  }, [timeRange])

  const timeRangeOptions = [
    { value: 'today', label: t('statistics.today') },
    { value: 'yesterday', label: t('statistics.yesterday') },
    { value: 'week', label: t('statistics.week') },
    { value: 'month', label: t('statistics.month') },
    { value: 'all', label: t('statistics.all') },
  ]

  const handleUsageMetricChange = (value: string | number) => {
    const nextMetric: UsageMetric = value === 'cost' ? 'cost' : 'tokens'
    setUsageMetric(nextMetric)
    saveUsageMetric(nextMetric)
  }

  const metricOptions = [
    {
      value: 'tokens',
      label: t('statistics.tokenMetric'),
      icon: <DatabaseOutlined />,
    },
    {
      value: 'cost',
      label: t('statistics.costMetric'),
      icon: <DollarOutlined />,
    },
  ]

  const getTrendValue = (day: CostStatistics['dailyTrend'][number]) =>
    usageMetric === 'tokens' ? day.tokens : day.cost
  const maxTrendValue = stats
    ? Math.max(...stats.dailyTrend.map((day) => getTrendValue(day)), 0.0001)
    : 1
  const metricColor = usageMetric === 'tokens' ? token.colorPrimary : token.colorWarning

  const costColumn = {
    title: t('statistics.cost'),
    dataIndex: 'totalCost',
    key: 'totalCost',
    width: 110,
    align: 'right' as const,
    render: (v: number) => <Text strong={usageMetric === 'cost'}>{formatCost(v)}</Text>,
  }

  const tokenColumn = {
    title: t('statistics.tokens'),
    dataIndex: 'totalTokens',
    key: 'totalTokens',
    width: 100,
    align: 'right' as const,
    render: (v: number) => <Text strong={usageMetric === 'tokens'}>{renderTokens(v)}</Text>,
  }

  // Top table columns (shared pattern)
  const makeTopColumns = (nameLabel: string, showNameTooltip = false) => [
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
      render: (v: string | null) => {
        const name = displayName(v, t('statistics.other'))
        return showNameTooltip ? (
          <Tooltip title={name}>
            <span className={styles.tooltipCellText}>{name}</span>
          </Tooltip>
        ) : (
          name
        )
      },
    },
    ...(usageMetric === 'tokens' ? [tokenColumn, costColumn] : [costColumn, tokenColumn]),
    {
      title: t('statistics.requests'),
      dataIndex: 'totalRequests',
      key: 'totalRequests',
      width: 80,
      align: 'right' as const,
    },
  ]

  const recentIdentityColumns = [
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
      render: (v: string | null) => displayName(v, '-'),
    },
    {
      title: t('statistics.project'),
      dataIndex: 'projectName',
      key: 'projectName',
      width: 140,
      ellipsis: true,
      render: (v: string | null) => displayName(v, t('statistics.other')),
    },
  ]

  const recentCostColumn = {
    title: t('statistics.cost'),
    dataIndex: 'totalCostUsd',
    key: 'totalCostUsd',
    width: 100,
    align: 'right' as const,
    render: (v: number) => <Text strong={usageMetric === 'cost'}>{formatCost(v)}</Text>,
  }

  const recentTokenColumns = [
    {
      title: t('statistics.inputTokens'),
      dataIndex: 'inputTokens',
      key: 'inputTokens',
      width: 100,
      align: 'right' as const,
      render: (v: number) => <Text strong={usageMetric === 'tokens'}>{renderTokens(v)}</Text>,
    },
    {
      title: t('statistics.outputTokens'),
      dataIndex: 'outputTokens',
      key: 'outputTokens',
      width: 100,
      align: 'right' as const,
      render: (v: number) => <Text strong={usageMetric === 'tokens'}>{renderTokens(v)}</Text>,
    },
    {
      title: t('statistics.cacheReadTokens'),
      dataIndex: 'cacheReadTokens',
      key: 'cacheReadTokens',
      width: 110,
      align: 'right' as const,
      render: (v: number) => renderTokens(v),
    },
    {
      title: t('statistics.cacheCreationTokens'),
      dataIndex: 'cacheCreationTokens',
      key: 'cacheCreationTokens',
      width: 110,
      align: 'right' as const,
      render: (v: number) => renderTokens(v),
    },
  ]

  const recentMetaColumns = [
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

  const recentColumns = [
    ...recentIdentityColumns,
    ...(usageMetric === 'tokens'
      ? [...recentTokenColumns, recentCostColumn]
      : [recentCostColumn, ...recentTokenColumns]),
    ...recentMetaColumns,
  ]

  const hasData = stats && stats.summary.totalRequests > 0
  const cacheInputTokens = stats
    ? stats.summary.totalInputTokens +
      stats.summary.totalCacheReadTokens +
      stats.summary.totalCacheCreationTokens
    : 0
  const cacheHitRate =
    stats && cacheInputTokens > 0
      ? (stats.summary.totalCacheReadTokens / cacheInputTokens) * 100
      : 0

  const handleRecentTableChange = (pagination: TablePaginationConfig) => {
    setRecentPage(pagination.current || 1)
    setRecentPageSize(pagination.pageSize || 10)
  }

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <div>
          <Title level={3} className='!m-0 !mb-1'>
            {t('statistics.title')}
          </Title>
          <Text type='secondary'>{t('statistics.subtitle')}</Text>
        </div>
        <Button icon={<SettingOutlined />} onClick={() => setPricingModalOpen(true)} size='large'>
          {t('modelPricing.editPricing')}
        </Button>
      </div>

      {/* Time Range Filter */}
      <div className={styles.filterSection}>
        <Segmented
          value={timeRange}
          onChange={(value) => setTimeRange(value as StatsTimeRange)}
          options={timeRangeOptions}
          className={styles.filterSegmented}
        />
        <div className={styles.metricControl}>
          <Text type='secondary' className={styles.metricLabel}>
            {t('statistics.metricLabel')}
          </Text>
          <Segmented
            value={usageMetric}
            onChange={handleUsageMetricChange}
            options={metricOptions}
            className={styles.metricSegmented}
          />
        </div>
      </div>

      {/* Content */}
      <div className={styles.content}>
        <SimpleBar className={styles.scrollContent} style={{ maxHeight: '100%' }}>
          {loading ? (
            <div className={styles.loadingState}>
              <Spin size='large' />
            </div>
          ) : hasData ? (
            <div className={styles.statsContent}>
              {/* Summary Cards */}
              <div className={styles.summaryRow}>
                <Card className={styles.summaryCard} variant='outlined'>
                  {usageMetric === 'tokens' ? (
                    <Statistic
                      title={t('statistics.totalTokens')}
                      value={stats!.summary.totalInputTokens + stats!.summary.totalOutputTokens}
                      prefix={<DatabaseOutlined style={{ color: token.colorPrimary }} />}
                      formatter={(v) => renderTokens(Number(v))}
                    />
                  ) : (
                    <Statistic
                      title={t('statistics.totalCost')}
                      value={stats!.summary.totalCostUsd}
                      precision={4}
                      prefix={<DollarOutlined style={{ color: token.colorWarning }} />}
                      formatter={(v) => `$${Number(v).toFixed(4)}`}
                    />
                  )}
                </Card>
                <Card className={styles.summaryCard} variant='outlined'>
                  <Statistic
                    title={t('statistics.totalRequests')}
                    value={stats!.summary.totalRequests}
                    prefix={<ThunderboltOutlined style={{ color: token.colorPrimary }} />}
                  />
                </Card>
                <Card className={styles.summaryCard} variant='outlined'>
                  {usageMetric === 'tokens' ? (
                    <Statistic
                      title={t('statistics.totalCost')}
                      value={stats!.summary.totalCostUsd}
                      precision={4}
                      prefix={<DollarOutlined style={{ color: token.colorWarning }} />}
                      formatter={(v) => `$${Number(v).toFixed(4)}`}
                    />
                  ) : (
                    <Statistic
                      title={t('statistics.totalTokens')}
                      value={stats!.summary.totalInputTokens + stats!.summary.totalOutputTokens}
                      prefix={<DatabaseOutlined style={{ color: token.colorPrimary }} />}
                      formatter={(v) => renderTokens(Number(v))}
                    />
                  )}
                </Card>
                <Card className={styles.summaryCard} variant='outlined'>
                  <Statistic
                    title={t('statistics.avgLatency')}
                    value={stats!.summary.avgLatencyMs || 0}
                    suffix='ms'
                    precision={0}
                    prefix={<FieldTimeOutlined style={{ color: token.colorSuccess }} />}
                  />
                </Card>
              </div>

              <div className={styles.summaryRow}>
                <Card className={styles.summaryCard} variant='outlined'>
                  <Statistic
                    title={
                      <Tooltip title={t('statistics.cacheHitRateHint')}>
                        <span>{t('statistics.cacheHitRate')}</span>
                      </Tooltip>
                    }
                    value={cacheHitRate}
                    precision={1}
                    suffix='%'
                    prefix={<ThunderboltOutlined style={{ color: token.colorSuccess }} />}
                  />
                </Card>
                <Card className={styles.summaryCard} variant='outlined'>
                  <Statistic
                    title={t('statistics.cacheReadTokens')}
                    value={stats!.summary.totalCacheReadTokens}
                    prefix={<DatabaseOutlined style={{ color: token.colorPrimary }} />}
                    formatter={(v) => renderTokens(Number(v))}
                  />
                </Card>
                <Card className={styles.summaryCard} variant='outlined'>
                  <Statistic
                    title={t('statistics.cacheCreationTokens')}
                    value={stats!.summary.totalCacheCreationTokens}
                    prefix={<DatabaseOutlined style={{ color: token.colorWarning }} />}
                    formatter={(v) => renderTokens(Number(v))}
                  />
                </Card>
                <Card className={styles.summaryCard} variant='outlined'>
                  <Statistic
                    title={t('statistics.cacheCost')}
                    value={stats!.summary.totalCacheCostUsd}
                    precision={4}
                    prefix={<DollarOutlined style={{ color: token.colorWarning }} />}
                    formatter={(v) => `$${Number(v).toFixed(4)}`}
                  />
                </Card>
              </div>

              {/* Daily Trend Chart */}
              {stats!.dailyTrend.length > 0 && (
                <Card
                  className={styles.trendCard}
                  variant='outlined'
                  title={
                    <Space>
                      <BarChartOutlined style={{ color: metricColor }} />
                      <span>
                        {usageMetric === 'tokens'
                          ? t('statistics.dailyTokenTrend')
                          : t('statistics.dailyCostTrend')}
                      </span>
                    </Space>
                  }
                >
                  {stats!.dailyTrend.some((day) => getTrendValue(day) > 0) ? (
                    <div className={styles.trendChart}>
                      {stats!.dailyTrend.map((day, i) => (
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
                                height: `${Math.max((getTrendValue(day) / maxTrendValue) * 100, 2)}%`,
                                background: metricColor,
                              }}
                            >
                              {hoveredBar === i && (
                                <div
                                  className={`${styles.trendTooltip} ${
                                    stats!.dailyTrend.length <= 1
                                      ? ''
                                      : i < 3 && i < Math.ceil(stats!.dailyTrend.length / 2)
                                        ? styles.trendTooltipStart
                                        : i >= stats!.dailyTrend.length - 3 &&
                                            i >= Math.ceil(stats!.dailyTrend.length / 2)
                                          ? styles.trendTooltipEnd
                                          : ''
                                  }`}
                                >
                                  {day.date} ·{' '}
                                  {usageMetric === 'tokens'
                                    ? formatTokenCountWithUnit(
                                        day.tokens,
                                        language,
                                        t('statistics.tokenUnit'),
                                      )
                                    : formatCost(day.cost)}{' '}
                                  · {day.requests} {t('statistics.requestUnit')}
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
                      <Text type='secondary'>{t('statistics.noData')}</Text>
                    </div>
                  )}
                </Card>
              )}

              {/* Top 10 Tables - Row 1 */}
              <div className={styles.tablesGrid}>
                <Card
                  className={styles.tableCard}
                  variant='outlined'
                  title={
                    <Space>
                      <KeyOutlined style={{ color: token.colorPrimary }} />
                      <span>
                        {usageMetric === 'tokens'
                          ? t('statistics.topKeysByTokens')
                          : t('statistics.topKeysByCost')}
                      </span>
                    </Space>
                  }
                >
                  <Table
                    dataSource={stats!.topKeys.map((k) => ({
                      ...k,
                      name: k.keyAlias,
                      key: k.keyId,
                    }))}
                    columns={makeTopColumns(t('statistics.key'), true)}
                    rowKey='keyId'
                    size='small'
                    pagination={false}
                    scroll={{ y: 240 }}
                  />
                </Card>

                <Card
                  className={styles.tableCard}
                  variant='outlined'
                  title={
                    <Space>
                      <CloudServerOutlined style={{ color: token.colorPrimary }} />
                      <span>
                        {usageMetric === 'tokens'
                          ? t('statistics.topProvidersByTokens')
                          : t('statistics.topProvidersByCost')}
                      </span>
                    </Space>
                  }
                >
                  <Table
                    dataSource={stats!.topProviders.map((p) => ({
                      ...p,
                      name: p.providerName,
                      key: p.providerId,
                    }))}
                    columns={makeTopColumns(t('statistics.provider'), true)}
                    rowKey='providerId'
                    size='small'
                    pagination={false}
                    scroll={{ y: 240 }}
                  />
                </Card>
              </div>

              {/* Top 10 Tables - Row 2 */}
              <div className={styles.tablesGrid}>
                <Card
                  className={styles.tableCard}
                  variant='outlined'
                  title={
                    <Space>
                      <FolderOutlined style={{ color: token.colorPrimary }} />
                      <span>
                        {usageMetric === 'tokens'
                          ? t('statistics.topProjectsByTokens')
                          : t('statistics.topProjectsByCost')}
                      </span>
                    </Space>
                  }
                >
                  <Table
                    dataSource={stats!.topProjects.map((p) => ({
                      ...p,
                      name: p.projectName,
                      key: p.projectId,
                    }))}
                    columns={makeTopColumns(t('statistics.project'), true)}
                    rowKey='projectId'
                    size='small'
                    pagination={false}
                    scroll={{ y: 240 }}
                  />
                </Card>

                <Card
                  className={styles.tableCard}
                  variant='outlined'
                  title={
                    <Space>
                      <RobotOutlined style={{ color: token.colorPrimary }} />
                      <span>
                        {usageMetric === 'tokens'
                          ? t('statistics.topModelsByTokens')
                          : t('statistics.topModelsByCost')}
                      </span>
                    </Space>
                  }
                >
                  <Table
                    dataSource={stats!.topModels.map((m) => ({
                      ...m,
                      name: m.model,
                      key: m.model,
                    }))}
                    columns={makeTopColumns(t('statistics.model'), true)}
                    rowKey={(record) =>
                      `${record.model || 'unknown'}-${record.totalRequests}-${record.totalTokens}`
                    }
                    size='small'
                    pagination={false}
                    scroll={{ y: 240 }}
                  />
                </Card>
              </div>

              {/* Recent Requests */}
              <Card
                className={styles.recentCard}
                variant='outlined'
                title={
                  <Space>
                    <BarChartOutlined style={{ color: token.colorPrimary }} />
                    <span>{t('statistics.recentRequests')}</span>
                  </Space>
                }
              >
                <Table
                  dataSource={recentRequests?.items || []}
                  columns={recentColumns}
                  rowKey='id'
                  size='small'
                  loading={recentLoading}
                  onChange={handleRecentTableChange}
                  pagination={{
                    current: recentRequests?.page || recentPage,
                    pageSize: recentRequests?.pageSize || recentPageSize,
                    total: recentRequests?.total || 0,
                    showSizeChanger: true,
                    pageSizeOptions: ['10', '20', '50', '100'],
                    showTotal: (total) => t('statistics.totalItems', { total }),
                  }}
                  scroll={{ x: 1340 }}
                />
              </Card>
            </div>
          ) : (
            <Card className='empty-state' variant='outlined'>
              <BarChartOutlined
                className='text-5xl mb-4'
                style={{ color: token.colorTextSecondary }}
              />
              <Title level={4} className='!mb-2'>
                {t('statistics.noData')}
              </Title>
              <Text type='secondary' className='block'>
                {t('statistics.noDataHint')}
              </Text>
            </Card>
          )}
        </SimpleBar>
      </div>

      {/* Model Pricing Modal */}
      <ModelPricingModal open={pricingModalOpen} onClose={() => setPricingModalOpen(false)} />
    </div>
  )
}
