import { getApi } from '../api'
/**
 * Statistics - 用量统计页面
 * v3.8.0: 聚焦 Token 构成、Key / 项目归因和可追溯的请求记录。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TablePaginationConfig } from 'antd'
import {
  Typography,
  Button,
  Card,
  Drawer,
  Table,
  Tag,
  Spin,
  theme,
  Space,
  Statistic,
  Tooltip,
} from 'antd'
import {
  BarChartOutlined,
  KeyOutlined,
  FolderOpenOutlined,
  RobotOutlined,
  SafetyOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import { usePageRefresh } from '../hooks/usePageRefresh'
import AutoModeAuditDrawer from '../components/usage/AutoModeAuditDrawer'
import RecentRequestDetailDrawer from '../components/usage/RecentRequestDetailDrawer'
import type {
  UsageStatistics,
  PaginatedRecentRequests,
  StatsTimeRange,
  UsageDimensionItem,
  RecentRequestLogDisplay,
} from '@shared/types'
import { formatExactTokenCount, formatTokenCount } from '../utils/formatTokens'
import UsageTimeRangePicker from '../components/usage/UsageTimeRangePicker'
import DailyModelUsageChart from '../components/usage/DailyModelUsageChart'
import styles from './Statistics.module.css'

const { Title, Text } = Typography

function displayName(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed || fallback
}

/** input + output + both cache buckets — the same four the database sums. */
function totalTokens(record: RecentRequestLogDisplay): number {
  return (
    record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheCreationTokens
  )
}

/** Rankings show this many rows before offering "view all". */
const RANKING_PREVIEW = 5

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
  const [stats, setStats] = useState<UsageStatistics | null>(null)
  const [loading, setLoading] = useState(true)
  const [recentRequests, setRecentRequests] = useState<PaginatedRecentRequests | null>(null)
  const [recentLoading, setRecentLoading] = useState(true)
  const [recentPage, setRecentPage] = useState(1)
  const [recentPageSize, setRecentPageSize] = useState(10)
  const refreshToken = useRef(0)
  const [auditOpen, setAuditOpen] = useState(false)
  const [detailRecord, setDetailRecord] = useState<RecentRequestLogDisplay | null>(null)
  const [rankingScope, setRankingScope] = useState<'key' | 'project' | null>(null)

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

  // A filter change makes any in-flight manual refresh outdated; drop it rather
  // than let its response overwrite the new filter's data.
  useEffect(() => {
    refreshToken.current += 1
  }, [timeRange, recentPage, recentPageSize])

  // Manual refresh keeps the rows and filters that are on screen. Only a filter
  // change clears the table, because then the old data no longer matches.
  const refresh = useCallback(async () => {
    const token = ++refreshToken.current
    setLoading(true)
    setRecentLoading(true)
    try {
      const [nextStats, nextRecent] = await Promise.all([
        getApi().requestLog.getStatistics(timeRange),
        getApi().requestLog.getRecentPaginated(timeRange, recentPage, recentPageSize),
      ])
      if (refreshToken.current !== token) return
      setStats(nextStats)
      setRecentRequests(nextRecent)
    } catch (error) {
      console.error('Failed to refresh usage statistics:', error)
    } finally {
      if (refreshToken.current === token) {
        setLoading(false)
        setRecentLoading(false)
      }
    }
  }, [timeRange, recentPage, recentPageSize])

  usePageRefresh(refresh)

  /**
   * Seven columns: the ones a user reads while scanning. Everything that is
   * only consulted when something looks wrong — the full model id, the token
   * breakdown, the error text — lives in the detail drawer.
   */
  const recentColumns = [
    {
      title: t('statistics.time'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 130,
      render: (value: string) => {
        const date = new Date(value)
        // Same-day rows read as a clock; cross-day rows need the date too.
        const today = new Date()
        const sameDay =
          date.getFullYear() === today.getFullYear() &&
          date.getMonth() === today.getMonth() &&
          date.getDate() === today.getDate()
        return (
          <Tooltip title={date.toLocaleString()}>
            <span style={{ fontSize: 12 }}>
              {sameDay ? date.toLocaleTimeString() : date.toLocaleString()}
            </span>
          </Tooltip>
        )
      },
    },
    {
      title: t('statistics.model'),
      dataIndex: 'model',
      key: 'model',
      render: (value: string | null, record: RecentRequestLogDisplay) => (
        <Space size={4} style={{ maxWidth: '100%' }}>
          {/* The model name yields space first; the label must stay visible. */}
          <Text ellipsis style={{ maxWidth: 160, fontSize: 12 }}>
            {value || '—'}
          </Text>
          {record.requestKind === 'auto_mode' && (
            <Tooltip title={t('statistics.autoModeRequestHint')}>
              <Tag color='gold' style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px' }}>
                Auto
              </Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: t('statistics.route'),
      key: 'route',
      render: (_: unknown, record: RecentRequestLogDisplay) => (
        <Text style={{ fontSize: 12 }}>
          {[displayName(record.providerName, '-'), record.keyAlias || '-'].join(' / ')}
        </Text>
      ),
    },
    {
      title: t('statistics.tokens'),
      dataIndex: 'inputTokens',
      key: 'tokens',
      width: 90,
      align: 'right' as const,
      render: (_: number, record: RecentRequestLogDisplay) => renderTokens(totalTokens(record)),
    },
    {
      title: t('statistics.latency'),
      dataIndex: 'latencyMs',
      key: 'latencyMs',
      width: 80,
      align: 'right' as const,
      render: (value: number | null) => (
        <span style={{ fontSize: 12 }}>{value != null ? `${value}ms` : '—'}</span>
      ),
    },
    {
      title: t('statistics.status'),
      key: 'status',
      width: 100,
      render: (_: unknown, record: RecentRequestLogDisplay) => (
        <Tag color={OUTCOME_COLORS[record.outcome ?? ''] || 'default'}>
          {record.statusCode ?? record.outcome ?? '-'}
        </Tag>
      ),
    },
    {
      title: t('statistics.detail'),
      key: 'detail',
      width: 80,
      render: (_: unknown, record: RecentRequestLogDisplay) => (
        <Button type='link' size='small' onClick={() => setDetailRecord(record)}>
          {t('statistics.detail')}
        </Button>
      ),
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
        <Button icon={<SafetyOutlined />} onClick={() => setAuditOpen(true)}>
          {t('statistics.autoAuditEntry') || 'Auto 记录'}
        </Button>
      </div>

      {/* Time Range Filter */}
      <div className={styles.filterSection}>
        <UsageTimeRangePicker value={timeRange} onChange={setTimeRange} />
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
              {/* The numbers a user checks first, cache rate and latency among
                  them. Equal cells in a grid rather than a divided row: five
                  figures wrap badly when the dividers wrap with them. */}
              <div className={styles.summaryBar}>
                <Statistic
                  title={t('statistics.totalTokens')}
                  value={summary.totalTokens}
                  formatter={(v) => renderTokens(Number(v))}
                />
                <Statistic
                  title={t('statistics.requestsWithUsage')}
                  value={summary.totalRequests}
                />
                <Statistic
                  title={t('statistics.failedRequests')}
                  value={summary.failedRequests}
                  valueStyle={summary.failedRequests > 0 ? { color: token.colorError } : undefined}
                />
                <Statistic
                  title={
                    <Tooltip title={t('statistics.cacheHitRateHint')}>
                      <span>{t('statistics.cacheHitRate')}</span>
                    </Tooltip>
                  }
                  value={summary.cacheHitRate * 100}
                  precision={1}
                  suffix='%'
                />
                <Statistic
                  title={t('statistics.avgLatency')}
                  // A missing measurement is not 0ms.
                  value={summary.avgLatencyMs ?? undefined}
                  suffix={summary.avgLatencyMs != null ? 'ms' : undefined}
                  precision={0}
                />
              </div>

              {/* Directly under the summary: how the traffic moved over time. */}
              <Card
                className={styles.tableCard}
                variant='outlined'
                title={
                  <Space>
                    <RobotOutlined style={{ color: token.colorPrimary }} />
                    <span>{t('statistics.dailyModelUsage')}</span>
                  </Space>
                }
                extra={<Text type='secondary'>{t('statistics.currentRange')}</Text>}
              >
                {stats.dailyModelUsage.length > 0 ? (
                  <DailyModelUsageChart
                    data={stats.dailyModelUsage}
                    granularity={stats.trendGranularity}
                    legendHint={t('statistics.legendToggleHint')}
                    ariaLabel={t('statistics.dailyModelUsage')}
                    unknownModelLabel={t('statistics.unknownModel')}
                  />
                ) : (
                  <div className={styles.trendEmpty}>
                    <Text type='secondary'>{t('statistics.noData')}</Text>
                  </div>
                )}
              </Card>

              {/* Recent Requests — the reason the page is opened. */}
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
                />
              </Card>

              {/* Rankings last: they answer "who spent it", after "how much". */}
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
                  extra={
                    stats.keyUsage.length > RANKING_PREVIEW ? (
                      <Button type='link' size='small' onClick={() => setRankingScope('key')}>
                        {t('statistics.viewAll', { count: stats.keyUsage.length })}
                      </Button>
                    ) : undefined
                  }
                >
                  <Table
                    dataSource={stats.keyUsage.slice(0, RANKING_PREVIEW)}
                    columns={dimensionColumns}
                    rowKey={(record) => `${record.id}-${record.name}-${record.detail}`}
                    size='small'
                    pagination={false}
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
                  extra={
                    stats.projectUsage.length > RANKING_PREVIEW ? (
                      <Button type='link' size='small' onClick={() => setRankingScope('project')}>
                        {t('statistics.viewAll', {
                          count: stats.projectUsage.length,
                        })}
                      </Button>
                    ) : undefined
                  }
                >
                  <Table
                    dataSource={stats.projectUsage.slice(0, RANKING_PREVIEW)}
                    columns={dimensionColumns}
                    rowKey={(record) => `${record.id}-${record.name}-${record.detail}`}
                    size='small'
                    pagination={false}
                    locale={{ emptyText: t('statistics.noData') }}
                  />
                </Card>
              </div>
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

      <AutoModeAuditDrawer
        open={auditOpen}
        timeRange={timeRange}
        onClose={() => setAuditOpen(false)}
      />

      <RecentRequestDetailDrawer record={detailRecord} onClose={() => setDetailRecord(null)} />

      {/* "View all" opens the full ranking; the page itself keeps the top few. */}
      <Drawer
        title={rankingScope === 'key' ? t('statistics.keyUsage') : t('statistics.projectUsage')}
        open={rankingScope !== null}
        onClose={() => setRankingScope(null)}
        size='large'
        destroyOnHidden
      >
        <Table
          dataSource={(rankingScope === 'key' ? stats?.keyUsage : stats?.projectUsage) ?? []}
          columns={dimensionColumns}
          rowKey={(record) => `${record.id}-${record.name}-${record.detail}`}
          size='small'
          pagination={{ pageSize: 20, size: 'small' }}
          locale={{ emptyText: t('statistics.noData') }}
        />
      </Drawer>
    </div>
  )
}
