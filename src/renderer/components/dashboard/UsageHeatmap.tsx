import { useEffect, useMemo, useState } from 'react'
import { Tooltip, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { getApi } from '../../api'
import type { DailyTrendItem } from '@shared/types'
import { formatExactTokenCount, formatTokenCount } from '../../utils/formatTokens'
import styles from './MonthCalendar.module.css'

/**
 * v3.7.0 Token 活动热力图。
 * 每个格子只表示当天 Token；不再提供周聚合与累计模式。
 */

const WEEKDAY_LABELS = {
  zh: ['一', '二', '三', '四', '五', '六', '日'],
  en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
}

function toLocalDateKey(d: Date): string {
  const offsetMs = d.getTimezoneOffset() * 60_000
  return new Date(d.getTime() - offsetMs).toISOString().slice(0, 10)
}

function normalizeTrendData(data: unknown): DailyTrendItem[] {
  if (!Array.isArray(data)) return []
  return data.filter(
    (item): item is DailyTrendItem =>
      typeof item === 'object' &&
      item !== null &&
      typeof item.date === 'string' &&
      typeof item.tokens === 'number' &&
      typeof item.requests === 'number',
  )
}

interface Props {
  year: number
}

interface HeatmapDay {
  dateStr: string
  /** Raw tokens for the day (tooltip always shows this). */
  tokens: number
  requests: number
  /** Value used for coloring under the current mode. */
  heatValue: number
  isToday: boolean
  isFuture: boolean
  inRange: boolean
}

interface HeatmapWeek {
  key: string
  days: HeatmapDay[]
  firstMonthKey: string | null
}

export default function UsageHeatmap({ year }: Props) {
  const { token } = theme.useToken()
  const { t, i18n } = useTranslation()
  const language = i18n.resolvedLanguage || i18n.language
  const today = toLocalDateKey(new Date())
  const [trendData, setTrendData] = useState<DailyTrendItem[]>([])

  const weekdayLabels = i18n.language.startsWith('zh') ? WEEKDAY_LABELS.zh : WEEKDAY_LABELS.en

  useEffect(() => {
    let cancelled = false

    const fetchTrendData = async () => {
      try {
        const months = Array.from({ length: 12 }, (_, i) => i + 1)
        const results = await Promise.all(
          months.map((month) => getApi().requestLog.getMonthlyTrend(year, month)),
        )
        if (!cancelled) {
          setTrendData(results.flatMap((items) => normalizeTrendData(items)))
        }
      } catch (err) {
        console.error('Failed to fetch heatmap data:', err)
        if (!cancelled) {
          setTrendData([])
        }
      }
    }

    void fetchTrendData()
    return () => {
      cancelled = true
    }
  }, [year])

  const dataMap = useMemo(() => {
    const map = new Map<string, DailyTrendItem>()
    for (const item of trendData) {
      map.set(item.date, item)
    }
    return map
  }, [trendData])

  const yearSummary = useMemo(() => {
    let totalTokens = 0
    let totalRequests = 0
    for (const item of trendData) {
      totalTokens += item.tokens
      totalRequests += item.requests
    }
    return { totalTokens, totalRequests }
  }, [trendData])

  const heatmapWeeks = useMemo<HeatmapWeek[]>(() => {
    const todayDate = new Date(`${today}T00:00:00`)
    const rangeStart = new Date(year, 0, 1)
    const rangeEnd = new Date(year, 11, 31)

    const gridStart = new Date(rangeStart)
    gridStart.setDate(gridStart.getDate() - ((gridStart.getDay() + 6) % 7))
    const gridEnd = new Date(rangeEnd)
    gridEnd.setDate(gridEnd.getDate() + (6 - ((gridEnd.getDay() + 6) % 7)))

    // First pass: raw per-day values in grid order.
    const rawWeeks: {
      key: string
      days: Omit<HeatmapDay, 'heatValue'>[]
      firstMonthKey: string | null
    }[] = []
    const cursor = new Date(gridStart)
    while (cursor <= gridEnd) {
      const weekStart = new Date(cursor)
      const days: Omit<HeatmapDay, 'heatValue'>[] = []
      let firstMonthKey: string | null = null

      for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
        const current = new Date(weekStart)
        current.setDate(weekStart.getDate() + dayIndex)
        const dateStr = toLocalDateKey(current)
        const inRange = current >= rangeStart && current <= rangeEnd
        const item = inRange ? dataMap.get(dateStr) : undefined

        if (inRange && firstMonthKey === null) {
          firstMonthKey = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`
        }

        days.push({
          dateStr,
          tokens: item?.tokens ?? 0,
          requests: item?.requests ?? 0,
          isToday: dateStr === today,
          isFuture: current > todayDate,
          inRange,
        })
      }

      rawWeeks.push({ key: toLocalDateKey(weekStart), days, firstMonthKey })
      cursor.setDate(cursor.getDate() + 7)
    }

    return rawWeeks.map((week) => {
      const days: HeatmapDay[] = week.days.map((day) => ({ ...day, heatValue: day.tokens }))
      return { key: week.key, days, firstMonthKey: week.firstMonthKey }
    })
  }, [dataMap, today, year])

  const maxHeatValue = useMemo(() => {
    let max = 0
    for (const week of heatmapWeeks) {
      for (const day of week.days) {
        if (day.inRange && !day.isFuture && day.heatValue > max) max = day.heatValue
      }
    }
    return max
  }, [heatmapWeeks])

  const heatmapMonthMarkers = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US', {
      month: 'short',
    })
    const markers: { label: string; column: number }[] = []
    let lastKey: string | null = null
    heatmapWeeks.forEach((week, index) => {
      if (week.firstMonthKey === null) return
      if (week.firstMonthKey === lastKey) return
      lastKey = week.firstMonthKey
      const [y, m] = week.firstMonthKey.split('-').map(Number)
      markers.push({ label: formatter.format(new Date(y, m - 1, 1)), column: index + 1 })
    })
    return markers
  }, [heatmapWeeks, i18n.language])

  const getHeatLevel = (value: number) => {
    if (value <= 0 || maxHeatValue <= 0) return 0
    const ratio = value / maxHeatValue
    if (ratio >= 0.75) return 4
    if (ratio >= 0.5) return 3
    if (ratio >= 0.25) return 2
    return 1
  }

  const heatColor = token.colorPrimary
  const heatmapBackgrounds = [
    token.colorFillQuaternary,
    `color-mix(in srgb, ${heatColor} 18%, ${token.colorBgContainer})`,
    `color-mix(in srgb, ${heatColor} 38%, ${token.colorBgContainer})`,
    `color-mix(in srgb, ${heatColor} 60%, ${token.colorBgContainer})`,
    `color-mix(in srgb, ${heatColor} 86%, ${token.colorBgContainer})`,
  ]

  const getHeatmapCellStyle = (
    level: number,
    isToday: boolean,
    isFuture: boolean,
    inRange: boolean,
  ): React.CSSProperties => {
    if (!inRange) {
      return { visibility: 'hidden' }
    }
    if (isFuture) {
      return {
        background: 'transparent',
        boxShadow: `inset 0 0 0 1px ${token.colorBorderSecondary}`,
        opacity: 0.45,
      }
    }
    const ringColor =
      level === 0
        ? 'color-mix(in srgb, currentColor 8%, transparent)'
        : 'color-mix(in srgb, currentColor 14%, transparent)'
    return {
      background: heatmapBackgrounds[level],
      boxShadow: isToday
        ? `0 0 0 1.5px ${heatColor}, 0 0 0 2.5px ${token.colorBgContainer}`
        : `inset 0 0 0 1px ${ringColor}`,
    }
  }

  const heatmapStyle = {
    ['--week-count' as string]: String(heatmapWeeks.length),
  } as React.CSSProperties

  return (
    <div style={heatmapStyle} className={styles.heatmapSection}>
      <div className={styles.heatmapSummary}>
        {yearSummary.totalRequests > 0
          ? t('dashboard.heatmapYearTokenSummary', {
              requests: yearSummary.totalRequests.toLocaleString(),
              tokens: formatTokenCount(yearSummary.totalTokens, language),
            })
          : t('dashboard.heatmapNoData')}
      </div>

      <div className={styles.heatmapScroll}>
        <div className={styles.heatmapBoard}>
          <div className={styles.heatmapMonthsRow}>
            {heatmapMonthMarkers.map((marker) => (
              <span
                key={`${marker.label}-${marker.column}`}
                className={styles.heatmapMonthCell}
                style={{ gridColumnStart: marker.column }}
              >
                {marker.label}
              </span>
            ))}
          </div>

          <div className={styles.heatmapAxis}>
            {weekdayLabels.map((weekday, index) => (
              <div
                key={weekday}
                className={styles.heatmapAxisLabel}
                data-hidden={![0, 2, 4].includes(index)}
              >
                {weekday}
              </div>
            ))}
          </div>

          <div className={styles.heatmapWeeks}>
            {heatmapWeeks.map((week) => (
              <div key={week.key} className={styles.heatmapWeekColumn}>
                {week.days.map((day) => {
                  const level = getHeatLevel(day.heatValue)
                  const tooltipContent = (
                    <div className={styles.tooltipContent}>
                      <div className={styles.tooltipDate}>{day.dateStr}</div>
                      <div className={styles.tooltipRow}>
                        <span
                          className={styles.tooltipDot}
                          style={{ background: heatmapBackgrounds[level] }}
                        />
                        <span>
                          <span className={styles.tooltipCost}>
                            {`${formatTokenCount(day.tokens, language)} Token`}
                          </span>
                          <span className={styles.tooltipSep}>·</span>
                          <span>
                            {day.requests} {t('dashboard.requests')}
                          </span>
                        </span>
                      </div>
                    </div>
                  )

                  return (
                    <Tooltip
                      key={day.dateStr}
                      title={tooltipContent}
                      mouseEnterDelay={0.05}
                      placement='top'
                    >
                      <div
                        className={styles.heatmapCell}
                        data-empty={day.inRange && !day.isFuture && day.heatValue === 0}
                        style={getHeatmapCellStyle(level, day.isToday, day.isFuture, day.inRange)}
                        aria-label={`${day.dateStr} ${formatExactTokenCount(day.tokens, language)} Token ${day.requests} ${t('dashboard.requests')}`}
                      />
                    </Tooltip>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.legendRow}>
        <span className={styles.legendLabel}>{t('dashboard.heatmapLess')}</span>
        <div className={styles.legendCells}>
          {[0, 1, 2, 3, 4].map((level) => (
            <div
              key={level}
              className={styles.legendCell}
              style={getHeatmapCellStyle(level, false, false, true)}
            />
          ))}
        </div>
        <span className={styles.legendLabel}>{t('dashboard.heatmapMore')}</span>
      </div>
    </div>
  )
}
