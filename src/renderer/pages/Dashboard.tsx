import { useEffect, useState } from 'react'
import { Typography, Card, theme, Popover, Tooltip } from 'antd'
import {
  ThunderboltOutlined,
  DatabaseOutlined,
  WarningOutlined,
  LeftOutlined,
  RightOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import SimpleBar from 'simplebar-react'
import { getApi } from '../api'
import UsageHeatmap from '../components/dashboard/UsageHeatmap'
import type { UsageOverview } from '@shared/types'
import { formatExactTokenCount, formatTokenCount } from '../utils/formatTokens'
import styles from './Dashboard.module.css'

const { Title, Text } = Typography

export default function Dashboard() {
  const { t, i18n } = useTranslation()
  const { token } = theme.useToken()

  const currentYear = new Date().getFullYear()
  const [overview, setOverview] = useState<UsageOverview | null>(null)
  const [calYear, setCalYear] = useState(() => new Date().getFullYear())
  const [yearPickerOpen, setYearPickerOpen] = useState(false)
  const language = i18n.resolvedLanguage || i18n.language

  useEffect(() => {
    let cancelled = false

    const fetchOverview = async () => {
      try {
        const data = await getApi().requestLog.getOverview()
        if (!cancelled) {
          setOverview(data)
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to fetch usage overview:', error)
        }
      }
    }

    void fetchOverview()
    return () => {
      cancelled = true
    }
  }, [])

  const yearList = Array.from({ length: 6 }, (_, i) => currentYear - i)

  const renderTokenValue = (value: number) => (
    <Tooltip title={formatExactTokenCount(value, language)}>
      <span>{formatTokenCount(value, language)}</span>
    </Tooltip>
  )

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
      </div>

      <div className={styles.content}>
        <SimpleBar className={styles.scrollContent} style={{ maxHeight: '100%' }}>
          {/* 今日概况 */}
          <div className={styles.statsRow}>
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
                    {renderTokenValue(overview?.todayTokens || 0)}
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
                    {overview?.todayRequests || 0}
                  </Text>
                </div>
              </div>
            </Card>

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
                    {overview?.todayFailedRequests || 0}
                  </Text>
                </div>
              </div>
            </Card>
          </div>

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
            <UsageHeatmap year={calYear} />
          </Card>
        </SimpleBar>
      </div>
    </div>
  )
}
