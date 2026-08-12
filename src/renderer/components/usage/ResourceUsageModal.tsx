import { useEffect, useState } from 'react'
import { Card, Empty, Modal, Segmented, Spin, Statistic, Typography, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import type { ResourceUsageStatistics, ResourceUsageTrendItem, StatsTimeRange } from '@shared/types'
import { getApi } from '../../api'
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

export default function ResourceUsageModal({ open, scope, onClose }: ResourceUsageModalProps) {
  const { t, i18n } = useTranslation()
  const { token } = theme.useToken()
  const language = i18n.resolvedLanguage || i18n.language
  const [timeRange, setTimeRange] = useState<StatsTimeRange>('week')
  const [trendView, setTrendView] = useState<ResourceTrendView>('usage')
  const [stats, setStats] = useState<ResourceUsageStatistics | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !scope) return
    let cancelled = false
    setLoading(true)
    setStats(null)
    getApi()
      .requestLog.getResourceStatistics(
        timeRange,
        scope.providerId,
        scope.type === 'key' ? scope.apiKeyId : undefined,
      )
      .then((value) => {
        if (!cancelled) setStats(value)
      })
      .catch((error) => {
        if (!cancelled) console.error('Failed to fetch resource usage statistics:', error)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, scope, timeRange])

  const summary = stats?.summary
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

  return (
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
        <UsageTimeRangePicker value={timeRange} onChange={setTimeRange} compact />
      </div>

      {loading ? (
        <div className={styles.loading}>
          <Spin size='large' />
        </div>
      ) : !summary || summary.totalRequests === 0 ? (
        <Empty description={t('usageDetail.noData')} className={styles.empty} />
      ) : (
        <div className={styles.content}>
          <div className={styles.summaryGrid}>
            <Card size='small'>
              <Statistic
                title={t('usageDetail.totalTokens')}
                value={summary.totalTokens}
                formatter={(value) => formatTokenCount(Number(value), i18n.language)}
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
                valueStyle={{ color: successColor }}
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
                value={summary.avgFirstTokenMs == null ? '-' : Math.round(summary.avgFirstTokenMs)}
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
              sampledHint={(shown, total) => t('statistics.chartSampledHint', { shown, total })}
            />
            <Text type='secondary' className={styles.chartHint}>
              {t('usageDetail.chartHint', { failed: summary.failedRequests })}{' '}
              {t('statistics.multiLineHint')}
            </Text>
          </Card>
        </div>
      )}
    </Modal>
  )
}

export type { ResourceScope }
