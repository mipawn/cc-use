import { getApi } from '../api'
/**
 * Statistics - 用量统计页面
 * v3.8.0: 聚焦 Token 构成和可追溯的请求记录。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TablePaginationConfig } from 'antd'
import {
  Typography,
  Button,
  Card,
  Table,
  Tag,
  Spin,
  theme,
  Space,
  Statistic,
  Tooltip,
  Alert,
  Select,
} from 'antd'
import { ArrowLeftOutlined, BarChartOutlined, RobotOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  buildConsoleUrl,
  buildStatisticsUrl,
  isAntigravitySource,
  observationOutcomes,
  observationSources,
  parseObservationContext,
  requestLocalDate,
  withObservationOutcome,
} from '../utils/observationContext'
import SimpleBar from 'simplebar-react'
import { usePageRefresh } from '../hooks/usePageRefresh'
import RecentRequestDetailDrawer from '../components/usage/RecentRequestDetailDrawer'
import type {
  RequestLogSource,
  UsageStatistics,
  PaginatedRecentRequests,
  RecentRequestLogDisplay,
} from '@shared/types'
import { formatExactTokenCount, formatTokenCount } from '../utils/formatTokens'
import { formatOutputSpeed, formatRequestDuration } from '../utils/formatPerformance'
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

const OUTCOME_COLORS: Record<string, string> = {
  success: 'green',
  failed: 'red',
  client_error: 'orange',
  upstream_error: 'red',
  transport_error: 'volcano',
}

/** Secondary label line inside a table cell; the primary value stays the same size. */
const CELL_LABEL_STYLE = { display: 'block', fontSize: 11, lineHeight: '16px' } as const

export default function Statistics({ embedded = false }: { embedded?: boolean }) {
  const { t, i18n } = useTranslation()
  const { token } = theme.useToken()
  const language = i18n.resolvedLanguage || i18n.language

  const renderTokens = (value: number) => (
    <Tooltip title={formatExactTokenCount(value, language)}>
      <span>{formatTokenCount(value, language)}</span>
    </Tooltip>
  )

  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const queryKey = searchParams.toString()
  const parsed = useMemo(() => parseObservationContext(queryKey), [queryKey])
  const { context, invalid } = parsed
  const { timeRange, filter, page: recentPage, pageSize: recentPageSize } = context
  const [stats, setStats] = useState<UsageStatistics | null>(null)
  const [loading, setLoading] = useState(true)
  const [recentRequests, setRecentRequests] = useState<PaginatedRecentRequests | null>(null)
  const [readError, setReadError] = useState<'scopeUnavailable' | 'readFailed' | null>(null)
  const refreshToken = useRef(0)
  const identity = useRef(queryKey)
  identity.current = queryKey
  const [detailRecord, setDetailRecord] = useState<RecentRequestLogDisplay | null>(null)

  // One query identity governs both aggregates and pages. Neither path may fall
  // back to the global ledger when a scope is invalid, deleted or unreadable.
  const load = useCallback(
    async (keepData = true) => {
      const revision = ++refreshToken.current
      if (!keepData || invalid) {
        setStats(null)
        setRecentRequests(null)
        setDetailRecord(null)
      }
      setReadError(null)
      if (invalid) {
        setLoading(false)
        return
      }
      setLoading(true)
      const [nextStats, nextRecent] = await Promise.allSettled([
        getApi().requestLog.getStatistics(timeRange, filter),
        getApi().requestLog.getRecentPaginated(timeRange, recentPage, recentPageSize, filter),
      ])
      if (revision !== refreshToken.current || identity.current !== queryKey) return
      if (nextStats.status === 'fulfilled' && nextRecent.status === 'fulfilled') {
        setStats(nextStats.value)
        setRecentRequests(nextRecent.value)
      } else {
        const reason =
          nextStats.status === 'rejected'
            ? nextStats.reason
            : nextRecent.status === 'rejected'
              ? nextRecent.reason
              : ''
        setReadError(
          /scope|association|provider/i.test(String(reason)) ? 'scopeUnavailable' : 'readFailed',
        )
        setStats(null)
        setRecentRequests(null)
      }
      setLoading(false)
    },
    [timeRange, filter, recentPage, recentPageSize, invalid, queryKey],
  )

  useEffect(() => {
    void load(false)
    return () => {
      refreshToken.current += 1
    }
  }, [load])
  // Reconciliation is best-effort catch-up, never a gate on rendering: opening
  // the page asks the backend to scan now, and a missed FSEvent that commits
  // later re-reads the same scope through the `usage:antigravityUpdated` event.
  const syncAntigravity = useCallback(async () => {
    try {
      await getApi().requestLog.syncAntigravity()
    } catch {
      // The visible reads stay authoritative when catch-up fails.
    }
  }, [])
  const reloadRef = useRef(load)
  reloadRef.current = load
  useEffect(() => {
    if (invalid) return
    // Subscribe before asking for the catch-up scan: a scan that commits while
    // the request is in flight emits `usage:antigravityUpdated`, and an early
    // emit must not be missed. The scan itself stays strictly non-blocking.
    const dispose = getApi().requestLog.onAntigravityUpdated(() => {
      void reloadRef.current()
    })
    void syncAntigravity()
    return dispose
  }, [invalid, syncAntigravity])
  const refresh = useCallback(async () => {
    if (!invalid) await syncAntigravity()
    await load()
  }, [invalid, load, syncAntigravity])
  usePageRefresh(refresh)

  const ledgerRows = recentRequests?.items ?? []
  // Proxy latency and Antigravity generation duration are different measurements:
  // the header may only claim the definitions the selected source (or, without a
  // source filter, the current page) actually shows, and each row labels its own.
  const showsProxyDuration = filter.source
    ? !isAntigravitySource(filter.source)
    : ledgerRows.some((row) => !isAntigravitySource(row.source))
  const showsGenerationDuration = filter.source
    ? isAntigravitySource(filter.source)
    : ledgerRows.some((row) => isAntigravitySource(row.source))
  const durationHeader =
    showsGenerationDuration && showsProxyDuration
      ? `${t('observation.generationDuration')} / ${t('statistics.latency')}`
      : showsGenerationDuration
        ? t('observation.generationDuration')
        : t('statistics.latency')

  /**
   * Request performance stays visible while scanning. Everything that is
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
      render: (_: unknown, record: RecentRequestLogDisplay) => {
        // Antigravity has no proxy route or key: its source and the conversation
        // title are the closest equivalent attribution.
        if (!isAntigravitySource(record.source)) {
          return (
            <Text style={{ fontSize: 12 }}>
              {[displayName(record.providerName, '-'), record.keyAlias || '-'].join(' / ')}
            </Text>
          )
        }
        return (
          <Space size={4} style={{ maxWidth: '100%' }}>
            <Tag style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px' }}>
              {t(`observation.sources.${record.source}`)}
            </Tag>
            <Text ellipsis style={{ maxWidth: 180, fontSize: 12 }}>
              {record.keyAlias || '—'}
            </Text>
          </Space>
        )
      },
    },
    {
      title: t('statistics.tokens'),
      dataIndex: 'inputTokens',
      key: 'tokens',
      width: 120,
      align: 'right' as const,
      render: (_: number, record: RecentRequestLogDisplay) => {
        const total = totalTokens(record)
        const hasSplit = record.thinkingTokens != null || record.responseTokens != null
        return (
          <div>
            {renderTokens(total)}
            {/* Antigravity splits output into thinking + response tokens; show it
                under the total so the exact-token tooltip and column stay intact. */}
            {hasSplit && (
              <>
                <Text type='secondary' style={CELL_LABEL_STYLE}>
                  {t('observation.thinkingTokens')} {record.thinkingTokens ?? '—'}
                </Text>
                <Text type='secondary' style={CELL_LABEL_STYLE}>
                  {t('observation.responseTokens')} {record.responseTokens ?? '—'}
                </Text>
              </>
            )}
          </div>
        )
      },
    },
    {
      title: (
        <Tooltip title={t('statistics.outputSpeedHint')}>
          <span>{t('statistics.outputSpeed')}</span>
        </Tooltip>
      ),
      dataIndex: 'outputTokensPerSecond',
      key: 'outputTokensPerSecond',
      width: 105,
      align: 'right' as const,
      render: (value: number | null) => <span>{formatOutputSpeed(value)}</span>,
    },
    {
      title: (
        <Tooltip title={t('statistics.firstTokenHint')}>
          <span>{t('statistics.firstTokenLatency')}</span>
        </Tooltip>
      ),
      dataIndex: 'firstTokenMs',
      key: 'firstTokenMs',
      width: 110,
      align: 'right' as const,
      render: (value: number | null) => <span>{formatRequestDuration(value)}</span>,
    },
    {
      title: durationHeader,
      key: 'duration',
      width: 130,
      align: 'right' as const,
      render: (_: number | null, record: RecentRequestLogDisplay) => {
        const antigravity = isAntigravitySource(record.source)
        return (
          <div>
            <span style={{ fontSize: 12 }}>
              {formatRequestDuration(antigravity ? record.generationMs : record.latencyMs)}
            </span>
            <Text type='secondary' style={CELL_LABEL_STYLE}>
              {antigravity ? t('observation.generationDuration') : t('statistics.latency')}
            </Text>
          </div>
        )
      },
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

  const summary = stats?.summary
  // A mixed proxy/Antigravity scope hides the three performance averages: the
  // two duration definitions are not comparable, so the backend already nulls them.
  const mixedSources = summary?.performanceMixedSources === true

  const handleRecentTableChange = (pagination: TablePaginationConfig) => {
    void navigate(
      buildStatisticsUrl({
        ...context,
        page: pagination.pageSize !== recentPageSize ? 1 : pagination.current || 1,
        pageSize: pagination.pageSize || 10,
      }),
    )
  }

  return (
    <div className={styles.container}>
      {/* Header */}
      {!embedded && (
        <div className={styles.header}>
          <div>
            <Title level={3} className='!m-0 !mb-1'>
              {t('statistics.title')}
            </Title>
            <Text type='secondary'>{t('statistics.subtitle')}</Text>
          </div>
        </div>
      )}

      {/* Time Range Filter */}
      <div className={styles.filterSection}>
        <UsageTimeRangePicker
          value={timeRange}
          onChange={(value) =>
            void navigate(buildStatisticsUrl({ ...context, timeRange: value, page: 1 }))
          }
        />
        <Space wrap>
          <Select
            aria-label={t('observation.outcome')}
            placeholder={t('observation.allOutcomes')}
            allowClear
            value={filter.outcome}
            style={{ minWidth: 145 }}
            options={observationOutcomes.map((value) => ({
              value,
              label: t(`observation.outcomes.${value}`),
            }))}
            onChange={(value) =>
              void navigate(buildStatisticsUrl(withObservationOutcome(context, value)))
            }
          />
          <Select
            aria-label={t('observation.population')}
            value={filter.population ?? 'all'}
            style={{ minWidth: 170 }}
            options={['all', 'with_usage'].map((value) => ({
              value,
              label: t(`observation.populations.${value}`),
            }))}
            onChange={(population) =>
              void navigate(
                buildStatisticsUrl({ ...context, page: 1, filter: { ...filter, population } }),
              )
            }
          />
          <Select
            aria-label={t('observation.source')}
            value={filter.source ?? 'all'}
            style={{ minWidth: 170 }}
            options={[
              { value: 'all', label: t('observation.allSources') },
              ...observationSources.map((value) => ({
                value,
                label: t(`observation.sources.${value}`),
              })),
            ]}
            onChange={(source: string) =>
              void navigate(
                buildStatisticsUrl({
                  ...context,
                  page: 1,
                  filter: {
                    ...filter,
                    source: source === 'all' ? undefined : (source as RequestLogSource),
                  },
                }),
              )
            }
          />
        </Space>
        <div className={styles.scopeBar}>
          {queryKey && (
            <Button size='small' icon={<ArrowLeftOutlined />} onClick={() => void navigate(-1)}>
              {t('common.back')}
            </Button>
          )}
          {(['providerId', 'apiKeyId', 'instanceId'] as const).map(
            (key) =>
              filter[key] && (
                <Tag
                  key={key}
                  closable
                  onClose={() =>
                    void navigate(
                      buildStatisticsUrl({
                        ...context,
                        page: 1,
                        filter: { ...filter, [key]: undefined },
                      }),
                    )
                  }
                >
                  {t(`observation.${key}`)}: {filter[key]}
                </Tag>
              ),
          )}
          <Text type='secondary'>{t('observation.denominatorHint')}</Text>
          <Button type='link' size='small' onClick={() => void navigate(buildStatisticsUrl())}>
            {t('observation.clearScope')}
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className={styles.content}>
        <SimpleBar className={styles.scrollContent} style={{ maxHeight: '100%' }}>
          {invalid || readError ? (
            <Alert
              type='error'
              showIcon
              title={t(`observation.${invalid ? 'invalidQuery' : readError}`)}
              description={t('observation.noScopeFallback')}
              action={
                <Space>
                  <Button onClick={() => void refresh()} disabled={invalid}>
                    {t('common.retry')}
                  </Button>
                  <Button onClick={() => void navigate(buildStatisticsUrl())}>
                    {t('observation.clearScope')}
                  </Button>
                </Space>
              }
            />
          ) : loading ? (
            <div className={styles.loadingState}>
              <Spin size='large' />
            </div>
          ) : stats && summary ? (
            <div className={styles.statsContent}>
              {/* Usage and observed request performance in the selected range. */}
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
                  title={
                    <Button
                      type='link'
                      size='small'
                      onClick={() =>
                        void navigate(buildStatisticsUrl(withObservationOutcome(context, 'failed')))
                      }
                    >
                      {t('statistics.failedRequests')}
                    </Button>
                  }
                  value={summary.failedRequests}
                  styles={{
                    content: summary.failedRequests > 0 ? { color: token.colorError } : undefined,
                  }}
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
                  value={mixedSources ? '—' : (summary.avgLatencyMs ?? '—')}
                  suffix={!mixedSources && summary.avgLatencyMs != null ? 'ms' : undefined}
                  precision={0}
                />
                <Statistic
                  title={
                    <Tooltip title={t('statistics.firstTokenHint')}>
                      <span>{t('usageDetail.avgFirstToken')}</span>
                    </Tooltip>
                  }
                  value={formatRequestDuration(mixedSources ? null : summary.avgFirstTokenMs)}
                />
                <Statistic
                  title={
                    <Tooltip title={t('statistics.avgOutputSpeedHint')}>
                      <span>{t('statistics.avgOutputSpeed')}</span>
                    </Tooltip>
                  }
                  value={formatOutputSpeed(mixedSources ? null : summary.avgOutputTokensPerSecond)}
                />
              </div>
              {mixedSources && (
                <Text type='secondary' style={{ display: 'block', marginTop: -8, fontSize: 12 }}>
                  {t('observation.performanceMixedHint')}
                </Text>
              )}

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
                    <Tag>{t('observation.ledgerCount', { count: recentRequests?.total ?? 0 })}</Tag>
                  </Space>
                }
              >
                <Table
                  dataSource={recentRequests?.items || []}
                  columns={recentColumns}
                  rowKey='id'
                  size='small'
                  loading={loading}
                  scroll={{ x: 1180 }}
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

      <RecentRequestDetailDrawer
        record={detailRecord}
        onClose={() => setDetailRecord(null)}
        onOpenConsole={(record) => {
          if (record.requestId)
            void navigate(
              buildConsoleUrl(context, record.requestId, requestLocalDate(record.createdAt)),
            )
        }}
      />
    </div>
  )
}
