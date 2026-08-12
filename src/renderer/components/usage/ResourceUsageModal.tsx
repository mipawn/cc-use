import { useEffect, useState } from 'react'
import { Card, Empty, Modal, Segmented, Spin, Statistic, Typography, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import type { ResourceUsageStatistics, ResourceUsageTrendItem, StatsTimeRange } from '@shared/types'
import { getApi } from '../../api'
import { formatTokenCount } from '../../utils/formatTokens'
import MultiMetricLineChart, { type LineSeries } from './MultiMetricLineChart'
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

export default function ResourceUsageModal({ open, scope, onClose }: ResourceUsageModalProps) {
  const { t, i18n } = useTranslation()
  const { token } = theme.useToken()
  const [timeRange, setTimeRange] = useState<StatsTimeRange>('week')
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
  const lineSeries: LineSeries<ResourceUsageTrendItem>[] = [
    {
      key: 'tokens',
      label: t('usageDetail.tokens'),
      color: token.colorPrimary,
      value: (item) => item.tokens,
      format: (value) => (value == null ? '-' : formatTokenCount(value, i18n.language)),
    },
    {
      key: 'requests',
      label: t('usageDetail.requests'),
      color: token.colorWarning,
      value: (item) => item.requests,
      format: (value) => (value == null ? '-' : Math.round(value).toLocaleString()),
    },
    {
      key: 'successRate',
      label: t('usageDetail.successRate'),
      color: token.colorSuccess,
      value: (item) => item.successRate,
      format: (value) => (value == null ? '-' : `${(value * 100).toFixed(1)}%`),
      domainMax: 1,
    },
    {
      key: 'cacheHitRate',
      label: t('usageDetail.cacheHitRate'),
      color: '#9254de',
      value: (item) => item.cacheHitRate,
      format: (value) => (value == null ? '-' : `${(value * 100).toFixed(1)}%`),
      domainMax: 1,
    },
    {
      key: 'latency',
      label: t('usageDetail.latency'),
      color: token.colorError,
      value: (item) => item.avgLatencyMs,
      format: (value) => (value == null ? '-' : `${Math.round(value)}ms`),
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
        <Segmented<StatsTimeRange>
          value={timeRange}
          onChange={setTimeRange}
          options={[
            { value: 'week', label: t('statistics.week') },
            { value: 'month', label: t('statistics.month') },
            { value: 'all', label: t('statistics.all') },
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
            <MultiMetricLineChart
              data={stats.dailyTrend}
              series={lineSeries}
              getDate={(item) => item.date}
              ariaLabel={t('usageDetail.trend')}
              relativeScaleLabel={t('statistics.relativeScale')}
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
