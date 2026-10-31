import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Alert,
  Button,
  Card,
  Empty,
  Modal,
  Segmented,
  Spin,
  Statistic,
  Typography,
  theme,
} from 'antd'
import { useTranslation } from 'react-i18next'
import type { ResourceUsageStatistics, ResourceUsageTrendItem, StatsTimeRange } from '@shared/types'
import { getApi } from '../../api'
import { usePageRefresh } from '../../hooks/usePageRefresh'
import { formatExactTokenCount, formatTokenCount } from '../../utils/formatTokens'
import MultiMetricLineChart, {
  type LineAxisDefinition,
  type LineSeries,
  type TooltipMetric,
} from './MultiMetricLineChart'
import UsageTimeRangePicker from './UsageTimeRangePicker'
import usageChartColors from './usageChartColors'
import styles from './ResourceUsageModal.module.css'

const { Text } = Typography

type ResourceScope =
  | { type: 'provider'; providerId: string; name: string }
  | { type: 'key'; providerId: string; apiKeyId: string; name: string; providerName: string }

interface ResourceUsageModalProps {
  open: boolean
  scope: ResourceScope | null
  onClose: () => void
}

type ResourceTrendView = 'usage' | 'quality'

interface LoadedResourceUsage {
  identity: string
  stats: ResourceUsageStatistics
}

/**
 * One resource-statistics query identity. Changing the scope or the time range
 * makes any rows already on screen describe a different query.
 */
function resourceUsageIdentity(
  scope: ResourceScope | null,
  timeRange: StatsTimeRange,
): string | null {
  if (!scope) return null
  return [scope.type, scope.providerId, scope.type === 'key' ? scope.apiKeyId : '', timeRange].join(
    '|',
  )
}

/**
 * Registers the modal's own loader with the page-refresh registry only while
 * the dialog is open on a concrete provider/key scope. The dialog component
 * itself stays mounted between openings so its selected range/view survive.
 */
function PageRefreshBridge({ load }: { load: () => Promise<void> }) {
  usePageRefresh(load)
  return null
}

export default function ResourceUsageModal({ open, scope, onClose }: ResourceUsageModalProps) {
  const { t, i18n } = useTranslation()
  const { token } = theme.useToken()
  const language = i18n.resolvedLanguage || i18n.language
  const [timeRange, setTimeRange] = useState<StatsTimeRange>('week')
  const [trendView, setTrendView] = useState<ResourceTrendView>('usage')
  const [loaded, setLoaded] = useState<LoadedResourceUsage | null>(null)
  const [failedIdentity, setFailedIdentity] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const identity = resourceUsageIdentity(scope, timeRange)
  const revisionRef = useRef(0)
  const aliveRef = useRef(true)
  const openRef = useRef(open)
  const scopeRef = useRef(scope)
  const timeRangeRef = useRef(timeRange)
  const identityRef = useRef(identity)
  openRef.current = open
  scopeRef.current = scope
  timeRangeRef.current = timeRange
  identityRef.current = identity

  /**
   * The single loader used by open/scope/range changes and by ⌘R. A response
   * (or its `finally`) commits only while it still matches the current
   * identity, revision and open state, so a slow reply for scope A can never
   * overwrite scope B or revive a closed dialog.
   */
  const load = useCallback(async () => {
    const currentScope = scopeRef.current
    const currentIdentity = identityRef.current
    const currentTimeRange = timeRangeRef.current
    if (!openRef.current || !currentScope || !currentIdentity) return

    const revision = ++revisionRef.current
    const isCurrent = () =>
      aliveRef.current &&
      revisionRef.current === revision &&
      identityRef.current === currentIdentity &&
      openRef.current

    setLoading(true)
    setFailedIdentity(null)
    try {
      const value = await getApi().requestLog.getResourceStatistics(
        currentTimeRange,
        currentScope.providerId,
        currentScope.type === 'key' ? currentScope.apiKeyId : undefined,
      )
      if (!isCurrent()) return
      setLoaded({ identity: currentIdentity, stats: value })
    } catch (error) {
      if (!isCurrent()) return
      console.error('Failed to fetch resource usage statistics:', error)
      setFailedIdentity(currentIdentity)
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      revisionRef.current += 1
    }
  }, [])

  useEffect(() => {
    if (!open || !scope) {
      // A closed dialog (or a cleared scope) invalidates anything in flight.
      revisionRef.current += 1
      setLoading(false)
      return
    }
    void load()
  }, [open, scope, timeRange, load])

  const stats = loaded && loaded.identity === identity ? loaded.stats : null
  const loadFailed = failedIdentity !== null && failedIdentity === identity
  const summary = stats?.summary
  // The first read of an identity is the only time the dialog shows the large
  // spinner. A same-identity refresh keeps the current rows visible instead.
  const waitingForData = open && scope !== null && stats === null && !loadFailed

  const successColor = summary
    ? summary.successRate >= 0.99
      ? token.colorSuccess
      : summary.successRate >= 0.95
        ? token.colorWarning
        : token.colorError
    : token.colorText
  const tokenAxis: LineAxisDefinition = {
    key: 'tokens',
    label: t('statistics.axisTokens'),
    orientation: 'left',
    formatTick: (value) => formatTokenCount(value, language),
  }
  const percentAxis: LineAxisDefinition = {
    key: 'percent',
    label: t('statistics.axisPercent'),
    orientation: 'left',
    formatTick: (value) => `${Math.round(value * 100)}%`,
    domain: [0, 1],
    allowDecimals: true,
  }
  const latencyAxis: LineAxisDefinition = {
    key: 'latency',
    label: t('statistics.axisLatency'),
    orientation: 'right',
    formatTick: (value) => `${Math.round(value)}ms`,
  }
  const lineSeries: LineSeries<ResourceUsageTrendItem>[] =
    trendView === 'usage'
      ? [
          {
            key: 'inputTokens',
            label: t('statistics.inputTokens'),
            color: usageChartColors.input,
            axisKey: 'tokens',
            value: (item) => item.inputTokens,
            format: (value) => (value == null ? '-' : formatExactTokenCount(value, language)),
          },
          {
            key: 'outputTokens',
            label: t('statistics.outputTokens'),
            color: usageChartColors.output,
            axisKey: 'tokens',
            value: (item) => item.outputTokens,
            format: (value) => (value == null ? '-' : formatExactTokenCount(value, language)),
          },
          {
            key: 'cacheReadTokens',
            label: t('statistics.cacheReadTokens'),
            color: usageChartColors.cacheRead,
            axisKey: 'tokens',
            value: (item) => item.cacheReadTokens,
            format: (value) => (value == null ? '-' : formatExactTokenCount(value, language)),
          },
          {
            key: 'cacheCreationTokens',
            label: t('statistics.cacheCreationTokens'),
            color: usageChartColors.cacheCreation,
            axisKey: 'tokens',
            value: (item) => item.cacheCreationTokens,
            format: (value) => (value == null ? '-' : formatExactTokenCount(value, language)),
          },
        ]
      : [
          {
            key: 'successRate',
            label: t('usageDetail.successRate'),
            color: usageChartColors.success,
            axisKey: 'percent',
            value: (item) => item.successRate,
            format: (value) => (value == null ? '-' : `${(value * 100).toFixed(1)}%`),
          },
          {
            key: 'cacheHitRate',
            label: t('usageDetail.cacheHitRate'),
            color: usageChartColors.cacheRate,
            axisKey: 'percent',
            value: (item) => item.cacheHitRate,
            format: (value) => (value == null ? '-' : `${(value * 100).toFixed(1)}%`),
          },
          {
            key: 'latency',
            label: t('usageDetail.latency'),
            color: usageChartColors.latency,
            axisKey: 'latency',
            value: (item) => item.avgLatencyMs,
            format: (value) => (value == null ? '-' : `${Math.round(value)}ms`),
          },
          {
            key: 'firstTokenLatency',
            label: t('usageDetail.firstTokenLatency'),
            color: usageChartColors.firstToken,
            axisKey: 'latency',
            value: (item) => item.avgFirstTokenMs,
            format: (value) => (value == null ? '-' : `${Math.round(value)}ms`),
          },
        ]
  const lineAxes = trendView === 'usage' ? [tokenAxis] : [percentAxis, latencyAxis]
  const tooltipMetrics: TooltipMetric<ResourceUsageTrendItem>[] = [
    {
      key: 'requests',
      label: t('statistics.requests'),
      color: token.colorTextTertiary,
      value: (item) => item.requests,
      format: (value) => (value == null ? '-' : Math.round(value).toLocaleString()),
    },
  ]

  const retryButton = (
    <Button size='small' onClick={() => void load()}>
      {t('common.retry')}
    </Button>
  )

  let body: ReactNode = null
  if (open && scope) {
    if (waitingForData) {
      body = (
        <div className={styles.loading}>
          <Spin size='large' />
        </div>
      )
    } else if (loadFailed && !summary) {
      // A failed IPC/DB read is not the same thing as "no data in this range".
      body = (
        <div className={styles.errorState}>
          <Alert
            type='error'
            showIcon
            title={t('usageDetail.loadFailed')}
            description={t('usageDetail.loadFailedHint')}
            action={retryButton}
          />
        </div>
      )
    } else {
      body = (
        <>
          {loadFailed && summary ? (
            <Alert
              type='warning'
              showIcon
              className={styles.notice}
              title={t('usageDetail.refreshFailed')}
              description={t('usageDetail.staleData')}
              action={retryButton}
            />
          ) : null}
          {loading ? (
            <div className={styles.refreshRow}>
              <Spin size='small' />
              <Text type='secondary'>{t('usageDetail.refreshing')}</Text>
            </div>
          ) : null}
          {summary && summary.totalRequests === 0 ? (
            // Only a successful read with zero requests may render the empty state.
            <Empty description={t('usageDetail.noData')} className={styles.empty}>
              <Text type='secondary' className={styles.emptyHint}>
                {t('usageDetail.noDataHint')}
              </Text>
            </Empty>
          ) : summary && stats ? (
            <div className={styles.content}>
              <div className={styles.summaryGrid}>
                <Card size='small'>
                  <Statistic
                    title={t('usageDetail.totalTokens')}
                    value={summary.totalTokens}
                    formatter={(value) => formatTokenCount(Number(value), language)}
                  />
                </Card>
                <Card size='small'>
                  <Statistic title={t('usageDetail.totalRequests')} value={summary.totalRequests} />
                </Card>
                <Card size='small'>
                  <Statistic
                    title={t('usageDetail.successRate')}
                    value={summary.successRate * 100}
                    precision={1}
                    suffix='%'
                    styles={{ content: { color: successColor } }}
                  />
                </Card>
                <Card size='small'>
                  <Statistic
                    title={t('usageDetail.cacheHitRate')}
                    value={summary.cacheHitRate * 100}
                    precision={1}
                    suffix='%'
                  />
                </Card>
                <Card size='small'>
                  <Statistic
                    title={t('usageDetail.avgLatency')}
                    value={summary.avgLatencyMs == null ? '-' : Math.round(summary.avgLatencyMs)}
                    suffix={summary.avgLatencyMs == null ? undefined : 'ms'}
                  />
                </Card>
                <Card size='small'>
                  <Statistic
                    title={t('usageDetail.avgFirstToken')}
                    value={
                      summary.avgFirstTokenMs == null ? '-' : Math.round(summary.avgFirstTokenMs)
                    }
                    suffix={summary.avgFirstTokenMs == null ? undefined : 'ms'}
                  />
                </Card>
              </div>

              <Card
                size='small'
                title={t('usageDetail.trend')}
                className={styles.chartCard}
                extra={
                  <Segmented<ResourceTrendView>
                    size='small'
                    value={trendView}
                    onChange={setTrendView}
                    options={[
                      { value: 'usage', label: t('usageDetail.usageTrend') },
                      { value: 'quality', label: t('usageDetail.qualityTrend') },
                    ]}
                  />
                }
              >
                <MultiMetricLineChart
                  data={stats.dailyTrend}
                  series={lineSeries}
                  tooltipMetrics={tooltipMetrics}
                  axes={lineAxes}
                  getDate={(item) => item.date}
                  ariaLabel={t('usageDetail.trend')}
                  legendHint={t('statistics.legendToggleHint')}
                  granularity={stats.trendGranularity}
                />
                <Text type='secondary' className={styles.chartHint}>
                  {t('usageDetail.granularityHint', {
                    granularity: t(`statistics.granularity.${stats.trendGranularity}`),
                  })}{' '}
                  {t('usageDetail.chartHint', { failed: summary.failedRequests })}{' '}
                  {t('statistics.multiLineHint')}
                </Text>
              </Card>
            </div>
          ) : null}
        </>
      )
    }
  }

  return (
    <>
      <Modal
        open={open}
        onCancel={onClose}
        footer={null}
        width={900}
        title={
          scope ? (
            <div className={styles.titleBlock}>
              <span>{t('usageDetail.title', { name: scope.name })}</span>
              <Text type='secondary' className={styles.titleMeta}>
                {scope.type === 'provider'
                  ? t('usageDetail.providerScope')
                  : t('usageDetail.keyScope', { provider: scope.providerName })}
              </Text>
            </div>
          ) : null
        }
        styles={{ body: { minHeight: 440 } }}
        destroyOnHidden
      >
        <div className={styles.toolbar}>
          <UsageTimeRangePicker value={timeRange} onChange={setTimeRange} />
          <Text type='secondary' className={styles.refreshHint}>
            {t('usageDetail.refreshHint')}
          </Text>
        </div>
        {body}
      </Modal>
      {/* Kept outside the modal body so closing the dialog unregisters the
          handler immediately instead of waiting for the close animation. */}
      {open && scope ? <PageRefreshBridge load={load} /> : null}
    </>
  )
}

export type { ResourceScope }
