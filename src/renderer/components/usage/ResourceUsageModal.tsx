import { useEffect, useMemo, useState } from 'react'
import { Card, Empty, Modal, Segmented, Spin, Statistic, Typography, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import type { ResourceUsageStatistics, ResourceUsageTrendItem, StatsTimeRange } from '@shared/types'
import { getApi } from '../../api'
import { formatTokenCount } from '../../utils/formatTokens'
import styles from './ResourceUsageModal.module.css'

const { Text } = Typography

type ResourceScope =
  | { type: 'provider'; providerId: string; name: string }
  | { type: 'key'; providerId: string; apiKeyId: string; name: string; providerName: string }

type TrendMetric = 'tokens' | 'requests' | 'successRate' | 'cacheHitRate' | 'latency'

interface ResourceUsageModalProps {
  open: boolean
  scope: ResourceScope | null
  onClose: () => void
}

function metricValue(item: ResourceUsageTrendItem, metric: TrendMetric): number {
  switch (metric) {
    case 'tokens':
      return item.tokens
    case 'requests':
      return item.requests
    case 'successRate':
      return item.successRate
    case 'cacheHitRate':
      return item.cacheHitRate
    case 'latency':
      return item.avgLatencyMs ?? 0
  }
}

export default function ResourceUsageModal({ open, scope, onClose }: ResourceUsageModalProps) {
  const { t, i18n } = useTranslation()
  const { token } = theme.useToken()
  const [timeRange, setTimeRange] = useState<StatsTimeRange>('week')
  const [metric, setMetric] = useState<TrendMetric>('tokens')
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

  const trend = useMemo(() => stats?.dailyTrend ?? [], [stats])
  const values = useMemo(() => trend.map((item) => metricValue(item, metric)), [trend, metric])
  const maxValue = Math.max(...values, 1)
  const chartWidth = 760
  const chartHeight = 230
  const padding = { top: 18, right: 18, bottom: 34, left: 46 }
  const plotWidth = chartWidth - padding.left - padding.right
  const plotHeight = chartHeight - padding.top - padding.bottom
  const points = values.map((value, index) => {
    const x =
      values.length === 1
        ? padding.left + plotWidth / 2
        : padding.left + (index / Math.max(values.length - 1, 1)) * plotWidth
    const y = padding.top + plotHeight - (value / maxValue) * plotHeight
    return { x, y, value, item: trend[index] }
  })
  const pointString = points.map((point) => `${point.x},${point.y}`).join(' ')

  const formatMetric = (value: number) => {
    if (metric === 'tokens') return formatTokenCount(value, i18n.language)
    if (metric === 'requests') return Math.round(value).toLocaleString()
    if (metric === 'successRate' || metric === 'cacheHitRate') return `${Math.round(value * 100)}%`
    return `${Math.round(value)}ms`
  }

  const formatDate = (date: string) =>
    new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })

  const labelStep = Math.max(1, Math.ceil(points.length / 7))
  const summary = stats?.summary
  const successColor = summary
    ? summary.successRate >= 0.99
      ? token.colorSuccess
      : summary.successRate >= 0.95
        ? token.colorWarning
        : token.colorError
    : token.colorText

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
        <Segmented<StatsTimeRange>
          value={timeRange}
          onChange={setTimeRange}
          options={[
            { value: 'week', label: t('statistics.week') },
            { value: 'month', label: t('statistics.month') },
            { value: 'all', label: t('statistics.all') },
          ]}
        />
        <Segmented<TrendMetric>
          value={metric}
          onChange={setMetric}
          options={[
            { value: 'tokens', label: t('usageDetail.tokens') },
            { value: 'requests', label: t('usageDetail.requests') },
            { value: 'successRate', label: t('usageDetail.successRate') },
            { value: 'cacheHitRate', label: t('usageDetail.cacheHitRate') },
            { value: 'latency', label: t('usageDetail.latency') },
          ]}
        />
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

          <Card size='small' title={t('usageDetail.trend')} className={styles.chartCard}>
            <div className={styles.chartScroller}>
              <svg
                viewBox={`0 0 ${chartWidth} ${chartHeight}`}
                className={styles.chart}
                role='img'
                aria-label={t('usageDetail.trend')}
              >
                {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                  const y = padding.top + plotHeight - ratio * plotHeight
                  return (
                    <g key={ratio}>
                      <line
                        x1={padding.left}
                        x2={chartWidth - padding.right}
                        y1={y}
                        y2={y}
                        stroke={token.colorBorderSecondary}
                        strokeDasharray='3 4'
                      />
                      <text
                        x={padding.left - 8}
                        y={y + 4}
                        textAnchor='end'
                        fill={token.colorTextSecondary}
                        fontSize='10'
                      >
                        {formatMetric(maxValue * ratio)}
                      </text>
                    </g>
                  )
                })}
                <polyline
                  points={pointString}
                  fill='none'
                  stroke={token.colorPrimary}
                  strokeWidth='2.5'
                  strokeLinejoin='round'
                  strokeLinecap='round'
                />
                {points.map((point, index) => (
                  <g key={point.item.date}>
                    <circle
                      cx={point.x}
                      cy={point.y}
                      r='3.5'
                      fill={token.colorBgContainer}
                      stroke={token.colorPrimary}
                      strokeWidth='2'
                    >
                      <title>{`${point.item.date}: ${formatMetric(point.value)}`}</title>
                    </circle>
                    {(index % labelStep === 0 || index === points.length - 1) && (
                      <text
                        x={point.x}
                        y={chartHeight - 10}
                        textAnchor='middle'
                        fill={token.colorTextSecondary}
                        fontSize='10'
                      >
                        {formatDate(point.item.date)}
                      </text>
                    )}
                  </g>
                ))}
              </svg>
            </div>
            <Text type='secondary' className={styles.chartHint}>
              {t('usageDetail.chartHint', { failed: summary.failedRequests })}
            </Text>
          </Card>
        </div>
      )}
    </Modal>
  )
}

export type { ResourceScope }
