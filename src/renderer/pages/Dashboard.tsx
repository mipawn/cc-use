import { useCallback, useEffect, useRef, useState } from 'react'
import { Typography, Card, theme, Popover, Tooltip } from 'antd'
import { Link, useNavigate } from 'react-router-dom'
import {
  ThunderboltOutlined,
  DatabaseOutlined,
  WarningOutlined,
  LeftOutlined,
  RightOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import { getApi } from '../api'
import UsageHeatmap from '../components/dashboard/UsageHeatmap'
import { usePageRefresh } from '../hooks/usePageRefresh'
import type { UsageOverview } from '@shared/types'
import { formatExactTokenCount, formatTokenCount } from '../utils/formatTokens'
import PageHeader from '../components/common/PageHeader'
import { buildStatisticsUrl } from '../utils/observationContext'
import styles from './Dashboard.module.css'

const { Text } = Typography

export default function Dashboard() {
  const { t, i18n } = useTranslation()
  const { token } = theme.useToken()

  const navigate = useNavigate()
  const revision = useRef(0)
  const today = new Date().toLocaleDateString('sv-SE')
  const todayUsage = buildStatisticsUrl({
    timeRange: `custom:${today}:${today}`,
    filter: { population: 'with_usage' },
    page: 1,
    pageSize: 10,
  })
  const todayFailures = buildStatisticsUrl({
    timeRange: `custom:${today}:${today}`,
    filter: { population: 'all', outcome: 'failed' },
    page: 1,
    pageSize: 10,
  })
  const currentYear = new Date().getFullYear()
  const [overview, setOverview] = useState<UsageOverview | null>(null)
  const [overviewFailed, setOverviewFailed] = useState(false)
  const [calYear, setCalYear] = useState(() => new Date().getFullYear())
  const [yearPickerOpen, setYearPickerOpen] = useState(false)
  const language = i18n.resolvedLanguage || i18n.language

  const fetchOverview = useCallback(async (isCancelled?: () => boolean) => {
    const request = ++revision.current
    try {
      const data = await getApi().requestLog.getOverview()
      if (!isCancelled?.() && request === revision.current) {
        setOverview(data)
        setOverviewFailed(false)
      }
    } catch (error) {
      if (!isCancelled?.() && request === revision.current) {
        console.error('Failed to fetch usage overview:', error)
        setOverviewFailed(true)
      }
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetchOverview(() => cancelled)
    return () => {
      cancelled = true
    }
  }, [fetchOverview])

  usePageRefresh(() => fetchOverview())

  const yearList = Array.from({ length: 6 }, (_, i) => currentYear - i)

  const renderTokenValue = (value: number) => (
    <Tooltip title={formatExactTokenCount(value, language)}>
      <span>{formatTokenCount(value, language)}</span>
    </Tooltip>
  )

  return (
    <div className={styles.container}>
      <PageHeader title={t('workspace.home')} description={t('workspace.overviewSubtitle')} />

      <div className={styles.content}>
        <SimpleBar className={styles.scrollContent} style={{ maxHeight: '100%' }}>
          <section aria-labelledby='today-overview-title'>
            <div className={styles.sectionHeading}>
              <h3 id='today-overview-title'>{t('workspace.todayOverview')}</h3>
              <Link to={todayUsage}>
                {t('workspace.viewStatistics')}
                <ArrowRightOutlined />
              </Link>
            </div>
            {overviewFailed && (
              <div className={styles.loadError}>
                {t('workspace.overviewUnavailable')}
                <button type='button' onClick={() => void fetchOverview()}>
                  {t('common.retry')}
                </button>
              </div>
            )}
            {/* 今日概况 */}
            <div className={styles.statsRow}>
              <Link to={todayUsage} className={styles.statLink}>
                <Card className={styles.statCard} variant='outlined'>
                  <div className={styles.statContent}>
                    <DatabaseOutlined
                      className={styles.statIcon}
                      style={{ color: token.colorPrimary }}
                    />
                    <div className={styles.statInfo}>
                      <Text type='secondary' className={styles.statLabel}>
                        {t('dashboard.todayTokens')}
                      </Text>
                      <Text strong className={styles.statValue}>
                        {overview && !overviewFailed ? renderTokenValue(overview.todayTokens) : '—'}
                      </Text>
                    </div>
                  </div>
                </Card>
              </Link>

              <Link to={todayUsage} className={styles.statLink}>
                <Card className={styles.statCard} variant='outlined'>
                  <div className={styles.statContent}>
                    <ThunderboltOutlined
                      className={styles.statIcon}
                      style={{ color: token.colorPrimary }}
                    />
                    <div className={styles.statInfo}>
                      <Text type='secondary' className={styles.statLabel}>
                        {t('dashboard.todayRequests')}
                      </Text>
                      <Text strong className={styles.statValue}>
                        {overviewFailed ? '—' : (overview?.todayRequests ?? '—')}
                      </Text>
                    </div>
                  </div>
                </Card>
              </Link>

              <Link to={todayFailures} className={styles.statLink}>
                <Card className={styles.statCard} variant='outlined'>
                  <div className={styles.statContent}>
                    <WarningOutlined
                      className={styles.statIcon}
                      style={{
                        color:
                          (overview?.todayFailedRequests || 0) > 0
                            ? token.colorError
                            : token.colorTextSecondary,
                      }}
                    />
                    <div className={styles.statInfo}>
                      <Text type='secondary' className={styles.statLabel}>
                        {t('dashboard.todayFailures')}
                      </Text>
                      <Text strong className={styles.statValue}>
                        {overviewFailed ? '—' : (overview?.todayFailedRequests ?? '—')}
                      </Text>
                    </div>
                  </div>
                </Card>
              </Link>
            </div>
          </section>

          {/* Token 活动热力图 */}
          <Card
            className={styles.calendarCard}
            variant='outlined'
            title={
              <div className={styles.trendTitleRow}>
                <div className={styles.trendTitleLeft}>
                  <Text strong>{t('dashboard.tokenActivity')}</Text>
                  <div className={styles.calendarNav}>
                    <button
                      type='button'
                      className={styles.calendarNavButton}
                      aria-label={t('workspace.previousYear')}
                      onClick={() => setCalYear((y) => y - 1)}
                    >
                      <LeftOutlined style={{ fontSize: 10 }} />
                    </button>
                    <Popover
                      trigger='click'
                      open={yearPickerOpen}
                      onOpenChange={setYearPickerOpen}
                      content={
                        <div className={styles.pickerContainer}>
                          <div className={styles.pickerGrid}>
                            {yearList.map((y) => (
                              <button
                                type='button'
                                key={y}
                                className={`${styles.pickerButton} ${calYear === y ? styles.pickerButtonActive : ''}`}
                                onClick={() => {
                                  setCalYear(y)
                                  setYearPickerOpen(false)
                                }}
                              >
                                {y}
                              </button>
                            ))}
                          </div>
                        </div>
                      }
                    >
                      <button type='button' className={styles.calendarLabelButton}>
                        {String(calYear)}
                      </button>
                    </Popover>
                    <button
                      type='button'
                      className={styles.calendarNavButton}
                      aria-label={t('workspace.nextYear')}
                      onClick={() => setCalYear((y) => y + 1)}
                      disabled={calYear >= currentYear}
                    >
                      <RightOutlined style={{ fontSize: 10 }} />
                    </button>
                  </div>
                </div>
              </div>
            }
          >
            <UsageHeatmap
              year={calYear}
              onDateSelect={(date) =>
                navigate(
                  buildStatisticsUrl({
                    timeRange: `custom:${date}:${date}`,
                    filter: { population: 'with_usage' },
                    page: 1,
                    pageSize: 10,
                  }),
                )
              }
            />
          </Card>
          <div className={styles.workspaceNote}>
            <span>{t('workspace.routingHint')}</span>
          </div>
        </SimpleBar>
      </div>
    </div>
  )
}
