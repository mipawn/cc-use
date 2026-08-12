import { getApi } from '../api'
/**
 * Statistics - 用量统计页面
 * v3.7.0: 只讲 Token 与真实行为 —— 构成、趋势、Key/项目、失败与请求。
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
  Tooltip,
  DatePicker,
} from 'antd'
import {
  ThunderboltOutlined,
  DatabaseOutlined,
  FieldTimeOutlined,
  BarChartOutlined,
  WarningOutlined,
  KeyOutlined,
  FolderOpenOutlined,
  LineChartOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import type {
  UsageStatistics,
  PaginatedRecentRequests,
  StatsTimeRange,
  RequestOutcome,
  UsageDimensionItem,
  DailyTrendItem,
} from '@shared/types'
import { formatExactTokenCount, formatTokenCount } from '../utils/formatTokens'
import styles from './Statistics.module.css'

const { Title, Text } = Typography
const { RangePicker } = DatePicker

type TimeRangeMode = 'today' | 'yesterday' | 'week' | 'month' | 'lastMonth' | 'all' | 'custom'
type TrendMetric = 'tokens' | 'requests' | 'cacheHitRate'

function dailyCacheHitRate(day: DailyTrendItem): number {
  const inputSide = day.inputTokens + day.cacheReadTokens + day.cacheCreationTokens
  return inputSide > 0 ? day.cacheReadTokens / inputSide : 0
}

function trendMetricValue(day: DailyTrendItem, metric: TrendMetric): number {
  if (metric === 'requests') return day.requests
  if (metric === 'cacheHitRate') return dailyCacheHitRate(day)
  return day.tokens
}

function displayName(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed || fallback
}

const OUTCOME_COLORS: Record<string, string> = {
  success: 'green',
  client_error: 'orange',
  upstream_error: 'red',
  transport_error: 'volcano',
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
  const [timeRangeMode, setTimeRangeMode] = useState<TimeRangeMode>('week')
  const [stats, setStats] = useState<UsageStatistics | null>(null)
  const [loading, setLoading] = useState(true)
  const [recentRequests, setRecentRequests] = useState<PaginatedRecentRequests | null>(null)
  const [recentLoading, setRecentLoading] = useState(true)
  const [recentPage, setRecentPage] = useState(1)
  const [recentPageSize, setRecentPageSize] = useState(10)
  const [trendMetric, setTrendMetric] = useState<TrendMetric>('tokens')
  useEffect(() => {
    let cancelled = false

    const fetchStats = async () => {
      setLoading(true)
      setStats(null)
      try {
        const data = await getApi().requestLog.getStatistics(timeRange)
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
  }, [timeRange])

  useEffect(() => {
    let cancelled = false

    const fetchRecentRequests = async () => {
      setRecentLoading(true)
      setRecentRequests(null)
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
    { value: 'lastMonth', label: t('statistics.lastMonth') },
    { value: 'all', label: t('statistics.all') },
    { value: 'custom', label: t('statistics.custom') },
  ]

  const trend = stats?.dailyTrend ?? []
  const trendValues = trend.map((day) => trendMetricValue(day, trendMetric))
  const maxTrendValue =
    trendMetric === 'cacheHitRate' ? 1 : Math.max(...trendValues.map((value) => value * 1.1), 1)
  const chartWidth = 920
  const chartHeight = 240
  const chartPadding = { top: 18, right: 18, bottom: 34, left: 56 }
  const plotWidth = chartWidth - chartPadding.left - chartPadding.right
  const plotHeight = chartHeight - chartPadding.top - chartPadding.bottom
  const trendPoints = trendValues.map((value, index) => ({
    x:
      trendValues.length === 1
        ? chartPadding.left + plotWidth / 2
        : chartPadding.left + (index / Math.max(trendValues.length - 1, 1)) * plotWidth,
    y: chartPadding.top + plotHeight - (value / maxTrendValue) * plotHeight,
    value,
    item: trend[index],
  }))
  const trendPointString = trendPoints.map((point) => `${point.x},${point.y}`).join(' ')
  const trendAreaPoints = trendPoints.length
    ? `${trendPoints[0].x},${chartPadding.top + plotHeight} ${trendPointString} ${trendPoints[trendPoints.length - 1].x},${chartPadding.top + plotHeight}`
    : ''
  const trendLabelStep = Math.max(1, Math.ceil(trendPoints.length / 7))
  const trendColor =
    trendMetric === 'cacheHitRate'
      ? token.colorSuccess
      : trendMetric === 'requests'
        ? token.colorInfo
        : token.colorPrimary

  const formatTrendMetric = (value: number) => {
    if (trendMetric === 'tokens') return formatTokenCount(value, language)
    if (trendMetric === 'requests') return Math.round(value).toLocaleString()
    return `${(value * 100).toFixed(1)}%`
  }

  const formatTrendDate = (date: string) => {
    const value = new Date(`${date}T00:00:00`)
    return `${value.getMonth() + 1}/${value.getDate()}`
  }

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
    {
      title: t('statistics.inputTokens'),
      dataIndex: 'inputTokens',
      key: 'inputTokens',
      width: 90,
      align: 'right' as const,
      render: (v: number) => renderTokens(v),
    },
    {
      title: t('statistics.outputTokens'),
      dataIndex: 'outputTokens',
      key: 'outputTokens',
      width: 90,
      align: 'right' as const,
      render: (v: number) => renderTokens(v),
    },
    {
      title: t('statistics.cacheReadTokens'),
      dataIndex: 'cacheReadTokens',
      key: 'cacheReadTokens',
      width: 100,
      align: 'right' as const,
      render: (v: number) => renderTokens(v),
    },
    {
      title: t('statistics.cacheCreationTokens'),
      dataIndex: 'cacheCreationTokens',
      key: 'cacheCreationTokens',
      width: 100,
      align: 'right' as const,
      render: (v: number) => renderTokens(v),
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
      width: 90,
      render: (
        v: number | null,
        record: { outcome: RequestOutcome | null; errorMessage: string | null },
      ) => {
        const outcome = record.outcome ?? 'success'
        const tag = <Tag color={OUTCOME_COLORS[outcome] || 'default'}>{v ?? outcome}</Tag>
        return record.errorMessage ? <Tooltip title={record.errorMessage}>{tag}</Tooltip> : tag
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

  const failureColumns = [
    {
      title: t('statistics.provider'),
      dataIndex: 'providerName',
      key: 'providerName',
      ellipsis: true,
      render: (v: string) => displayName(v, '-'),
    },
    {
      title: t('statistics.key'),
      dataIndex: 'keyAlias',
      key: 'keyAlias',
      ellipsis: true,
      render: (v: string) => displayName(v, '-'),
    },
    {
      title: t('statistics.status'),
      dataIndex: 'statusCode',
      key: 'statusCode',
      width: 100,
      render: (v: number | null, record: { outcome: string }) => (
        <Tag color={OUTCOME_COLORS[record.outcome] || 'default'}>{v ?? record.outcome}</Tag>
      ),
    },
    {
      title: t('statistics.failureCount'),
      dataIndex: 'count',
      key: 'count',
      width: 90,
      align: 'right' as const,
    },
    {
      title: t('statistics.lastSeenAt'),
      dataIndex: 'lastSeenAt',
      key: 'lastSeenAt',
      width: 170,
      render: (v: string) => new Date(v).toLocaleString(),
    },
  ]

  const dimensionColumns = [
    {
      title: t('statistics.name'),
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      render: (value: string, record: UsageDimensionItem) => (
        <div className={styles.dimensionName}>
          <Text strong ellipsis={{ tooltip: value }}>
            {displayName(value, t('statistics.other'))}
          </Text>
          {record.detail && (
            <Text type='secondary' ellipsis={{ tooltip: record.detail }}>
              {record.detail}
            </Text>
          )}
        </div>
      ),
    },
    {
      title: t('statistics.tokens'),
      dataIndex: 'tokens',
      key: 'tokens',
      width: 110,
      align: 'right' as const,
      render: (value: number) => renderTokens(value),
    },
    {
      title: t('statistics.requests'),
      dataIndex: 'requests',
      key: 'requests',
      width: 88,
      align: 'right' as const,
      render: (value: number) => value.toLocaleString(),
    },
  ]

  const hasData = stats
    ? stats.summary.totalRequests > 0 || stats.summary.failedRequests > 0
    : false
  const summary = stats?.summary

  // Token 构成条：input / output / cache_read / cache_creation
  const compositionParts = summary
    ? [
        {
          key: 'input',
          label: t('statistics.inputTokens'),
          value: summary.totalInputTokens,
          color: token.colorPrimary,
        },
        {
          key: 'output',
          label: t('statistics.outputTokens'),
          value: summary.totalOutputTokens,
          color: token.colorSuccess,
        },
        {
          key: 'cacheRead',
          label: t('statistics.cacheReadTokens'),
          value: summary.totalCacheReadTokens,
          color: token.colorInfo,
        },
        {
          key: 'cacheCreation',
          label: t('statistics.cacheCreationTokens'),
          value: summary.totalCacheCreationTokens,
          color: token.colorWarning,
        },
      ]
    : []
  const compositionTotal = compositionParts.reduce((sum, part) => sum + part.value, 0)

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
      </div>

      {/* Time Range Filter */}
      <div className={styles.filterSection}>
        <Segmented
          value={timeRangeMode}
          onChange={(value) => {
            const mode = value as TimeRangeMode
            setTimeRangeMode(mode)
            if (mode !== 'custom') setTimeRange(mode)
          }}
          options={timeRangeOptions}
          className={styles.filterSegmented}
        />
        {timeRangeMode === 'custom' && (
          <RangePicker
            className={styles.customRangePicker}
            allowClear={false}
            format='YYYY-MM-DD'
            disabledDate={(current) => current.valueOf() > Date.now()}
            onChange={(dates, dateStrings) => {
              if (dates?.[0] && dates[1] && dateStrings[0] && dateStrings[1]) {
                setTimeRange(`custom:${dateStrings[0]}:${dateStrings[1]}`)
              }
            }}
          />
        )}
      </div>

      {/* Content */}
      <div className={styles.content}>
        <SimpleBar className={styles.scrollContent} style={{ maxHeight: '100%' }}>
          {loading ? (
            <div className={styles.loadingState}>
              <Spin size='large' />
            </div>
          ) : hasData && summary ? (
            <div className={styles.statsContent}>
              {/* Summary Cards */}
              <div className={styles.summaryRow}>
                <Card className={styles.summaryCard} variant='outlined'>
                  <Statistic
                    title={t('statistics.totalTokens')}
                    value={summary.totalTokens}
                    prefix={<DatabaseOutlined style={{ color: token.colorPrimary }} />}
                    formatter={(v) => renderTokens(Number(v))}
                  />
                </Card>
                <Card className={styles.summaryCard} variant='outlined'>
                  <Statistic
                    title={t('statistics.totalRequests')}
                    value={summary.totalRequests}
                    prefix={<ThunderboltOutlined style={{ color: token.colorPrimary }} />}
                  />
                </Card>
                <Card className={styles.summaryCard} variant='outlined'>
                  <Statistic
                    title={
                      <Tooltip title={t('statistics.cacheHitRateHint')}>
                        <span>{t('statistics.cacheHitRate')}</span>
                      </Tooltip>
                    }
                    value={summary.cacheHitRate * 100}
                    precision={1}
                    suffix='%'
                    prefix={<ThunderboltOutlined style={{ color: token.colorSuccess }} />}
                  />
                </Card>
                <Card className={styles.summaryCard} variant='outlined'>
                  <Statistic
                    title={t('statistics.failedRequests')}
                    value={summary.failedRequests}
                    prefix={
                      <WarningOutlined
                        style={{
                          color:
                            summary.failedRequests > 0
                              ? token.colorError
                              : token.colorTextSecondary,
                        }}
                      />
                    }
                  />
                </Card>
                <Card className={styles.summaryCard} variant='outlined'>
                  <Statistic
                    title={t('statistics.avgLatency')}
                    value={summary.avgLatencyMs || 0}
                    suffix='ms'
                    precision={0}
                    prefix={<FieldTimeOutlined style={{ color: token.colorSuccess }} />}
                  />
                </Card>
              </div>

              {/* Token Composition */}
              <Card
                className={styles.trendCard}
                variant='outlined'
                title={
                  <Space>
                    <DatabaseOutlined style={{ color: token.colorPrimary }} />
                    <span>{t('statistics.tokenComposition')}</span>
                  </Space>
                }
              >
                {compositionTotal > 0 ? (
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        height: 12,
                        borderRadius: 6,
                        overflow: 'hidden',
                        marginBottom: 12,
                      }}
                    >
                      {compositionParts
                        .filter((part) => part.value > 0)
                        .map((part) => (
                          <Tooltip
                            key={part.key}
                            title={`${part.label} · ${formatExactTokenCount(part.value, language)} (${((part.value / compositionTotal) * 100).toFixed(1)}%)`}
                          >
                            <div
                              style={{
                                width: `${(part.value / compositionTotal) * 100}%`,
                                background: part.color,
                                minWidth: 3,
                              }}
                            />
                          </Tooltip>
                        ))}
                    </div>
                    <Space size='large' wrap>
                      {compositionParts.map((part) => (
                        <Space key={part.key} size={6}>
                          <span
                            style={{
                              display: 'inline-block',
                              width: 8,
                              height: 8,
                              borderRadius: 2,
                              background: part.color,
                            }}
                          />
                          <Text type='secondary' style={{ fontSize: 12 }}>
                            {part.label}
                          </Text>
                          <Text strong style={{ fontSize: 12 }}>
                            {formatTokenCount(part.value, language)}
                          </Text>
                          <Text type='secondary' style={{ fontSize: 12 }}>
                            {compositionTotal > 0
                              ? `${((part.value / compositionTotal) * 100).toFixed(1)}%`
                              : '0%'}
                          </Text>
                        </Space>
                      ))}
                    </Space>
                  </div>
                ) : (
                  <div className={styles.trendEmpty}>
                    <Text type='secondary'>{t('statistics.noData')}</Text>
                  </div>
                )}
              </Card>

              {/* Daily Trend Chart */}
              {stats!.dailyTrend.length > 0 && (
                <Card
                  className={styles.trendCard}
                  variant='outlined'
                  title={
                    <Space>
                      <LineChartOutlined style={{ color: trendColor }} />
                      <span>{t('statistics.dailyUsageTrend')}</span>
                    </Space>
                  }
                  extra={
                    <div className={styles.metricControl}>
                      <Text type='secondary' className={styles.metricLabel}>
                        {t('statistics.trendMetric')}
                      </Text>
                      <Segmented<TrendMetric>
                        size='small'
                        value={trendMetric}
                        onChange={setTrendMetric}
                        options={[
                          { value: 'tokens', label: t('statistics.tokens') },
                          { value: 'requests', label: t('statistics.requests') },
                          { value: 'cacheHitRate', label: t('statistics.cacheHitRate') },
                        ]}
                        className={styles.metricSegmented}
                      />
                    </div>
                  }
                >
                  <div className={styles.trendChartScroller}>
                    <svg
                      viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                      className={styles.trendChart}
                      role='img'
                      aria-label={t('statistics.dailyUsageTrend')}
                    >
                      <defs>
                        <linearGradient id='statistics-trend-area' x1='0' x2='0' y1='0' y2='1'>
                          <stop offset='0%' stopColor={trendColor} stopOpacity='0.2' />
                          <stop offset='100%' stopColor={trendColor} stopOpacity='0' />
                        </linearGradient>
                      </defs>
                      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                        const y = chartPadding.top + plotHeight - ratio * plotHeight
                        return (
                          <g key={ratio}>
                            <line
                              x1={chartPadding.left}
                              x2={chartWidth - chartPadding.right}
                              y1={y}
                              y2={y}
                              stroke={token.colorBorderSecondary}
                              strokeDasharray='3 4'
                            />
                            <text
                              x={chartPadding.left - 10}
                              y={y + 4}
                              textAnchor='end'
                              fill={token.colorTextSecondary}
                              fontSize='10'
                            >
                              {formatTrendMetric(maxTrendValue * ratio)}
                            </text>
                          </g>
                        )
                      })}
                      <polygon points={trendAreaPoints} fill='url(#statistics-trend-area)' />
                      <polyline
                        points={trendPointString}
                        fill='none'
                        stroke={trendColor}
                        strokeWidth='2.5'
                        strokeLinejoin='round'
                        strokeLinecap='round'
                      />
                      {trendPoints.map((point, index) => (
                        <g key={point.item.date}>
                          <circle
                            cx={point.x}
                            cy={point.y}
                            r='4'
                            fill={token.colorBgContainer}
                            stroke={trendColor}
                            strokeWidth='2'
                          >
                            <title>{`${point.item.date} · ${t('statistics.tokens')} ${formatTokenCount(point.item.tokens, language)} · ${t('statistics.requests')} ${point.item.requests.toLocaleString()} · ${t('statistics.cacheHitRate')} ${(dailyCacheHitRate(point.item) * 100).toFixed(1)}%`}</title>
                          </circle>
                          {(index % trendLabelStep === 0 || index === trendPoints.length - 1) && (
                            <text
                              x={point.x}
                              y={chartHeight - 10}
                              textAnchor='middle'
                              fill={token.colorTextSecondary}
                              fontSize='10'
                            >
                              {formatTrendDate(point.item.date)}
                            </text>
                          )}
                        </g>
                      ))}
                    </svg>
                  </div>
                  <Text type='secondary' className={styles.trendHint}>
                    {t('statistics.trendHint')}
                  </Text>
                </Card>
              )}

              {/* Key / project dimensions for the selected range */}
              <div className={styles.dimensionGrid}>
                <Card
                  className={styles.tableCard}
                  variant='outlined'
                  title={
                    <Space>
                      <KeyOutlined style={{ color: token.colorPrimary }} />
                      <span>{t('statistics.keyUsage')}</span>
                    </Space>
                  }
                  extra={<Text type='secondary'>{t('statistics.currentRange')}</Text>}
                >
                  <Table
                    dataSource={stats!.keyUsage}
                    columns={dimensionColumns}
                    rowKey={(record) => `${record.id}-${record.name}-${record.detail}`}
                    size='small'
                    pagination={
                      stats!.keyUsage.length > 8
                        ? { pageSize: 8, showSizeChanger: false, size: 'small' }
                        : false
                    }
                    locale={{ emptyText: t('statistics.noData') }}
                  />
                </Card>
                <Card
                  className={styles.tableCard}
                  variant='outlined'
                  title={
                    <Space>
                      <FolderOpenOutlined style={{ color: token.colorPrimary }} />
                      <span>{t('statistics.projectUsage')}</span>
                    </Space>
                  }
                  extra={<Text type='secondary'>{t('statistics.currentRange')}</Text>}
                >
                  <Table
                    dataSource={stats!.projectUsage}
                    columns={dimensionColumns}
                    rowKey={(record) => `${record.id}-${record.name}-${record.detail}`}
                    size='small'
                    pagination={
                      stats!.projectUsage.length > 8
                        ? { pageSize: 8, showSizeChanger: false, size: 'small' }
                        : false
                    }
                    locale={{ emptyText: t('statistics.noData') }}
                  />
                </Card>
              </div>

              {/* Failures */}
              {stats!.failures.length > 0 && (
                <Card
                  className={styles.recentCard}
                  variant='outlined'
                  title={
                    <Space>
                      <WarningOutlined style={{ color: token.colorError }} />
                      <span>{t('statistics.failures')}</span>
                    </Space>
                  }
                >
                  <Table
                    dataSource={stats!.failures}
                    columns={failureColumns}
                    rowKey={(record) =>
                      `${record.providerName}-${record.keyAlias}-${record.statusCode}-${record.outcome}`
                    }
                    size='small'
                    pagination={false}
                    scroll={{ y: 240 }}
                  />
                </Card>
              )}

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
                  scroll={{ x: 1250 }}
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
    </div>
  )
}
