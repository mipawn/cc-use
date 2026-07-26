import { useEffect, useMemo, useState } from 'react'
import { Typography, Card, theme, Segmented, Popover, Tooltip } from 'antd'
import {
  ThunderboltOutlined,
  DollarOutlined,
  WalletOutlined,
  DatabaseOutlined,
  CalendarOutlined,
  BgColorsOutlined,
  LeftOutlined,
  RightOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import { getApi } from '../api'
import MonthCalendar from '../components/dashboard/MonthCalendar'
import type { DashboardCostStats } from '@shared/types'
import { formatExactTokenCount, formatTokenCount } from '../utils/formatTokens'
import { getInitialUsageMetric, saveUsageMetric, type UsageMetric } from '../utils/usageMetric'
import styles from './Dashboard.module.css'

const { Title, Text } = Typography

type CalendarView = 'calendar' | 'heatmap'

function getInitialCalendarView(): CalendarView {
  const savedView = localStorage.getItem('dashboardTrendView')
  if (savedView === 'heatmap' || savedView === 'bar') return 'heatmap'
  return 'calendar'
}

function getMonthLabel(year: number, month: number, language: string): string {
  return new Intl.DateTimeFormat(language.startsWith('zh') ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'long',
  }).format(new Date(year, month - 1, 1))
}

export default function Dashboard() {
  const { t, i18n } = useTranslation()
  const { token } = theme.useToken()

  const currentYear = new Date().getFullYear()
  const [dashStats, setDashStats] = useState<DashboardCostStats | null>(null)
  const [dashStatsMetric, setDashStatsMetric] = useState<UsageMetric | null>(null)
  const [dashStatsLoading, setDashStatsLoading] = useState(true)
  const [usageMetric, setUsageMetric] = useState<UsageMetric>(getInitialUsageMetric)
  const [calendarView, setCalendarView] = useState<CalendarView>(getInitialCalendarView)
  const [calYear, setCalYear] = useState(() => new Date().getFullYear())
  const [calMonth, setCalMonth] = useState(() => new Date().getMonth() + 1)

  useEffect(() => {
    let cancelled = false

    const fetchDashboardStats = async () => {
      setDashStatsLoading(true)
      try {
        const stats = await getApi().requestLog.getDashboardStats(usageMetric)
        if (!cancelled) {
          setDashStats(stats)
          setDashStatsMetric(usageMetric)
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to fetch dashboard stats:', error)
        }
      } finally {
        if (!cancelled) {
          setDashStatsLoading(false)
        }
      }
    }

    void fetchDashboardStats()
    return () => {
      cancelled = true
    }
  }, [usageMetric])

  const handleCalendarViewChange = (value: string | number) => {
    const nextView = value === 'heatmap' ? 'heatmap' : 'calendar'
    setCalendarView(nextView)
    localStorage.setItem('dashboardTrendView', nextView)
  }

  const handleUsageMetricChange = (value: string | number) => {
    const nextMetric: UsageMetric = value === 'cost' ? 'cost' : 'tokens'
    setUsageMetric(nextMetric)
    saveUsageMetric(nextMetric)
  }

  const calPrev = () => {
    if (calMonth === 1) {
      setCalYear((year) => year - 1)
      setCalMonth(12)
      return
    }
    setCalMonth((month) => month - 1)
  }

  const calNext = () => {
    if (calMonth === 12) {
      setCalYear((year) => year + 1)
      setCalMonth(1)
      return
    }
    setCalMonth((month) => month + 1)
  }

  const calCanGoNext =
    calYear < currentYear || (calYear === currentYear && calMonth < new Date().getMonth() + 1)

  const [yearPickerOpen, setYearPickerOpen] = useState(false)
  const [monthPickerOpen, setMonthPickerOpen] = useState(false)
  const [pickerYear, setPickerYear] = useState(calYear)

  const calYearPrev = () => {
    setCalYear((y) => y - 1)
    setCalMonth(12)
  }

  const calYearNext = () => {
    setCalYear((y) => y + 1)
    setCalMonth(12)
  }

  const heatmapLabel = String(calYear)

  const handleYearSelect = (selectedYear: number) => {
    setCalYear(selectedYear)
    setCalMonth(12)
    setYearPickerOpen(false)
  }

  const handleMonthSelect = (selectedYear: number, selectedMonth: number) => {
    setCalYear(selectedYear)
    setCalMonth(selectedMonth)
    setMonthPickerOpen(false)
  }

  const openMonthPicker = () => {
    setPickerYear(calYear)
    setMonthPickerOpen(true)
  }

  const yearList = Array.from({ length: 6 }, (_, i) => currentYear - i)
  const monthNames = i18n.language.startsWith('zh')
    ? ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
    : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  const monthLabel = useMemo(
    () => getMonthLabel(calYear, calMonth, i18n.language),
    [calMonth, calYear, i18n.language],
  )

  const rankingStats = dashStatsMetric === usageMetric ? dashStats : null
  const topKeys = useMemo(() => rankingStats?.topKeys.slice(0, 3) ?? [], [rankingStats])
  const topProjects = useMemo(() => rankingStats?.topProjects.slice(0, 3) ?? [], [rankingStats])
  const rankClasses = [styles.topRank1, styles.topRank2, styles.topRank3]
  const language = i18n.resolvedLanguage || i18n.language
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

  const renderTokenValue = (value: number) => (
    <Tooltip title={formatExactTokenCount(value, language)}>
      <span>{formatTokenCount(value, language)}</span>
    </Tooltip>
  )

  const renderUsageValue = (cost: number, tokens: number) =>
    usageMetric === 'tokens' ? renderTokenValue(tokens) : `$${cost.toFixed(4)}`

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerContent}>
          <Title level={2} className={styles.title}>
            {t('dashboard.title')}
          </Title>
          <Text type='secondary' className={styles.subtitle}>
            {t('dashboard.subtitle')}
          </Text>
        </div>
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

      <div className={styles.content}>
        <SimpleBar className={styles.scrollContent} style={{ maxHeight: '100%' }}>
          <div className={styles.statsRow}>
            <Card className={styles.statCard} variant='outlined'>
              <div className={styles.statContent}>
                {usageMetric === 'tokens' ? (
                  <DatabaseOutlined
                    className={styles.statIcon}
                    style={{ color: token.colorPrimary }}
                  />
                ) : (
                  <DollarOutlined
                    className={styles.statIcon}
                    style={{ color: token.colorWarning }}
                  />
                )}
                <div className={styles.statInfo}>
                  <Text type='secondary' className={styles.statLabel}>
                    {usageMetric === 'tokens'
                      ? t('dashboard.todayTokens')
                      : t('dashboard.todayCost')}
                  </Text>
                  <Text strong className={styles.statValue}>
                    {usageMetric === 'tokens'
                      ? renderTokenValue(dashStats?.todayTokens || 0)
                      : `$${dashStats?.todayCost.toFixed(4) || '0.0000'}`}
                  </Text>
                </div>
              </div>
            </Card>

            <Card className={styles.statCard} variant='outlined'>
              <div className={styles.statContent}>
                {usageMetric === 'tokens' ? (
                  <DatabaseOutlined
                    className={styles.statIcon}
                    style={{ color: token.colorPrimary }}
                  />
                ) : (
                  <WalletOutlined
                    className={styles.statIcon}
                    style={{ color: token.colorSuccess }}
                  />
                )}
                <div className={styles.statInfo}>
                  <Text type='secondary' className={styles.statLabel}>
                    {usageMetric === 'tokens'
                      ? t('dashboard.totalTokens')
                      : t('dashboard.totalCost')}
                  </Text>
                  <Text strong className={styles.statValue}>
                    {usageMetric === 'tokens'
                      ? renderTokenValue(dashStats?.totalTokens || 0)
                      : `$${dashStats?.totalCost.toFixed(2) || '0.00'}`}
                  </Text>
                </div>
              </div>
            </Card>

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
                    {dashStats?.todayRequests || 0}
                  </Text>
                </div>
              </div>
            </Card>

            <Card className={styles.statCard} variant='outlined'>
              <div className={styles.statContent}>
                {usageMetric === 'tokens' ? (
                  <DollarOutlined
                    className={styles.statIcon}
                    style={{ color: token.colorWarning }}
                  />
                ) : (
                  <DatabaseOutlined
                    className={styles.statIcon}
                    style={{ color: token.colorPrimary }}
                  />
                )}
                <div className={styles.statInfo}>
                  <Text type='secondary' className={styles.statLabel}>
                    {usageMetric === 'tokens'
                      ? t('dashboard.todayCost')
                      : t('dashboard.todayTokens')}
                  </Text>
                  <Text strong className={styles.statValue}>
                    {usageMetric === 'tokens'
                      ? `$${dashStats?.todayCost.toFixed(4) || '0.0000'}`
                      : renderTokenValue(dashStats?.todayTokens || 0)}
                  </Text>
                </div>
              </div>
            </Card>
          </div>

          <div className={styles.mainGrid}>
            <Card
              className={`${styles.calendarCard} ${calendarView === 'heatmap' ? styles.calendarCardCompact : ''}`}
              variant='outlined'
              title={
                <div className={styles.trendTitleRow}>
                  <div className={styles.trendTitleLeft}>
                    <Text strong>
                      {calendarView === 'calendar'
                        ? usageMetric === 'tokens'
                          ? t('dashboard.tokenCalendar')
                          : t('dashboard.costCalendar')
                        : usageMetric === 'tokens'
                          ? t('dashboard.tokenHeatmap')
                          : t('dashboard.costHeatmap')}
                    </Text>
                    {calendarView === 'calendar' ? (
                      <div className={styles.calendarNav}>
                        <button
                          type='button'
                          className={styles.calendarNavButton}
                          onClick={calPrev}
                        >
                          <LeftOutlined style={{ fontSize: 10 }} />
                        </button>
                        <Popover
                          trigger='click'
                          open={monthPickerOpen}
                          onOpenChange={(open) => {
                            if (open) openMonthPicker()
                            else setMonthPickerOpen(false)
                          }}
                          content={
                            <div className={styles.pickerContainer}>
                              <div className={styles.pickerYearRow}>
                                <button
                                  type='button'
                                  className={styles.calendarNavButton}
                                  onClick={() => setPickerYear((y) => y - 1)}
                                >
                                  <LeftOutlined style={{ fontSize: 10 }} />
                                </button>
                                <span className={styles.pickerYearLabel}>{pickerYear}</span>
                                <button
                                  type='button'
                                  className={styles.calendarNavButton}
                                  onClick={() => setPickerYear((y) => y + 1)}
                                  disabled={pickerYear >= currentYear}
                                >
                                  <RightOutlined style={{ fontSize: 10 }} />
                                </button>
                              </div>
                              <div className={styles.pickerMonthGrid}>
                                {monthNames.map((name, i) => {
                                  const isFuture =
                                    pickerYear === currentYear && i > new Date().getMonth()
                                  return (
                                    <button
                                      type='button'
                                      key={name}
                                      className={`${styles.pickerMonthButton} ${calYear === pickerYear && calMonth === i + 1 ? styles.pickerMonthActive : ''}`}
                                      disabled={isFuture}
                                      onClick={() => handleMonthSelect(pickerYear, i + 1)}
                                    >
                                      {name}
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          }
                        >
                          <button type='button' className={styles.calendarLabelButton}>
                            {monthLabel}
                          </button>
                        </Popover>
                        <button
                          type='button'
                          className={styles.calendarNavButton}
                          onClick={calNext}
                          disabled={!calCanGoNext}
                        >
                          <RightOutlined style={{ fontSize: 10 }} />
                        </button>
                      </div>
                    ) : (
                      <div className={styles.calendarNav}>
                        <button
                          type='button'
                          className={styles.calendarNavButton}
                          onClick={calYearPrev}
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
                                    onClick={() => handleYearSelect(y)}
                                  >
                                    {y}
                                  </button>
                                ))}
                              </div>
                            </div>
                          }
                        >
                          <button type='button' className={styles.calendarLabelButton}>
                            {heatmapLabel}
                          </button>
                        </Popover>
                        <button
                          type='button'
                          className={styles.calendarNavButton}
                          onClick={calYearNext}
                          disabled={calYear >= currentYear}
                        >
                          <RightOutlined style={{ fontSize: 10 }} />
                        </button>
                      </div>
                    )}
                  </div>

                  <Segmented
                    size='small'
                    value={calendarView}
                    onChange={handleCalendarViewChange}
                    options={[
                      {
                        value: 'calendar',
                        icon: <CalendarOutlined />,
                        label: t('dashboard.calendarMode'),
                      },
                      {
                        value: 'heatmap',
                        icon: <BgColorsOutlined />,
                        label: t('dashboard.heatmapMode'),
                      },
                    ]}
                  />
                </div>
              }
            >
              <MonthCalendar
                year={calYear}
                month={calMonth}
                mode={calendarView}
                metric={usageMetric}
              />
            </Card>

            <div className={styles.sidebarColumn}>
              <Card
                className={styles.topCard}
                variant='outlined'
                loading={dashStatsLoading}
                title={
                  <Text strong>
                    {usageMetric === 'tokens'
                      ? t('dashboard.topKeysByTokens')
                      : t('dashboard.topKeysByCost')}
                  </Text>
                }
              >
                {topKeys.length > 0 ? (
                  <div className={styles.topList}>
                    {topKeys.map((item, index) => (
                      <div key={item.keyId} className={styles.topItem}>
                        <span className={`${styles.topRank} ${rankClasses[index] || ''}`}>
                          {index + 1}
                        </span>
                        <div className={styles.topMeta}>
                          <span className={styles.topName}>{item.keyAlias}</span>
                          <span className={styles.topSub}>
                            {item.providerName || t('common.none')}
                          </span>
                        </div>
                        <span className={styles.topValue}>
                          {renderUsageValue(item.totalCost, item.totalTokens)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className={styles.topEmpty}>{t('common.noData')}</div>
                )}
              </Card>

              <Card
                className={styles.topCard}
                variant='outlined'
                loading={dashStatsLoading}
                title={
                  <Text strong>
                    {usageMetric === 'tokens'
                      ? t('dashboard.topProjectsByTokens')
                      : t('dashboard.topProjectsByCost')}
                  </Text>
                }
              >
                {topProjects.length > 0 ? (
                  <div className={styles.topList}>
                    {topProjects.map((item, index) => (
                      <div key={item.projectId} className={styles.topItem}>
                        <span className={`${styles.topRank} ${rankClasses[index] || ''}`}>
                          {index + 1}
                        </span>
                        <div className={styles.topMeta}>
                          <span className={styles.topName}>{item.projectName}</span>
                          <span className={styles.topSub}>
                            {item.totalRequests} {t('dashboard.requests')}
                          </span>
                        </div>
                        <span className={styles.topValue}>
                          {renderUsageValue(item.totalCost, item.totalTokens)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className={styles.topEmpty}>{t('common.noData')}</div>
                )}
              </Card>
            </div>
          </div>
        </SimpleBar>
      </div>
    </div>
  )
}
