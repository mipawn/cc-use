import { useEffect, useMemo, useState } from 'react'
import { Tooltip, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { getApi } from '../../api'
import type { DailyCostTrendItem } from '@shared/types'
import styles from './MonthCalendar.module.css'

const WEEKDAY_LABELS = {
  zh: ['一', '二', '三', '四', '五', '六', '日'],
  en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
}

function toLocalDateKey(d: Date): string {
  const offsetMs = d.getTimezoneOffset() * 60_000
  return new Date(d.getTime() - offsetMs).toISOString().slice(0, 10)
}

function parseDateKey(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00`)
}

function formatCost(cost: number): string {
  if (cost <= 0) return '$0'
  if (cost >= 100) return `$${cost.toFixed(0)}`
  if (cost >= 1) return `$${cost.toFixed(2)}`
  if (cost >= 0.01) return `$${cost.toFixed(2)}`
  return `$${cost.toFixed(3)}`
}

function formatCostCompact(cost: number): string {
  if (cost >= 1000) return `${(cost / 1000).toFixed(1)}K`
  if (cost >= 100) return cost.toFixed(0)
  if (cost >= 1) return cost.toFixed(2)
  return cost.toFixed(2)
}

function normalizeTrendData(data: unknown): DailyCostTrendItem[] {
  if (!Array.isArray(data)) return []
  return data.filter(
    (item): item is DailyCostTrendItem =>
      typeof item === 'object' &&
      item !== null &&
      typeof item.date === 'string' &&
      typeof item.cost === 'number' &&
      typeof item.requests === 'number',
  )
}

interface Props {
  style?: React.CSSProperties
  year: number
  month: number
  mode?: 'calendar' | 'heatmap'
}

interface HeatmapDay {
  dateStr: string
  cost: number
  requests: number
  isToday: boolean
  isFuture: boolean
  inRange: boolean
}

interface HeatmapWeek {
  key: string
  days: HeatmapDay[]
  firstMonthKey: string | null
}

export default function MonthCalendar({ style, year, month, mode = 'calendar' }: Props) {
  const { token } = theme.useToken()
  const { t, i18n } = useTranslation()
  const today = toLocalDateKey(new Date())
  const todayDate = parseDateKey(today)
  const [trendData, setTrendData] = useState<DailyCostTrendItem[]>([])

  const weekdayLabels = i18n.language.startsWith('zh') ? WEEKDAY_LABELS.zh : WEEKDAY_LABELS.en

  useEffect(() => {
    let cancelled = false

    const fetchTrendData = async () => {
      try {
        if (mode === 'heatmap') {
          const rangeEnd = new Date(year, month, 0)
          const rangeStart = new Date(year, month - 1, 1)
          rangeStart.setMonth(rangeStart.getMonth() - 11)
          const fetchMonths: { year: number; month: number }[] = []
          const cursor = new Date(rangeStart)
          while (cursor <= rangeEnd) {
            fetchMonths.push({ year: cursor.getFullYear(), month: cursor.getMonth() + 1 })
            cursor.setMonth(cursor.getMonth() + 1)
          }
          const results = await Promise.all(
            fetchMonths.map(({ year: y, month: m }) =>
              getApi().requestLog.getMonthlyTrend(y, m),
            ),
          )

          if (!cancelled) {
            setTrendData(results.flatMap((items) => normalizeTrendData(items)))
          }
          return
        }

        const data = await getApi().requestLog.getMonthlyTrend(year, month)
        if (!cancelled) {
          setTrendData(normalizeTrendData(data))
        }
      } catch (err) {
        console.error('Failed to fetch trend data:', err)
        if (!cancelled) {
          setTrendData([])
        }
      }
    }

    void fetchTrendData()

    return () => {
      cancelled = true
    }
  }, [mode, month, year])

  const dataMap = useMemo(() => {
    const map = new Map<string, DailyCostTrendItem>()
    for (const item of trendData) {
      map.set(item.date, item)
    }
    return map
  }, [trendData])

  const maxCost = useMemo(() => {
    let max = 0
    for (const item of trendData) {
      if (item.cost > max) max = item.cost
    }
    return max
  }, [trendData])

  const daysInMonth = new Date(year, month, 0).getDate()
  const firstDayOfWeek = (new Date(year, month - 1, 1).getDay() + 6) % 7

  const cells: (number | null)[] = []
  for (let index = 0; index < firstDayOfWeek; index++) cells.push(null)
  for (let day = 1; day <= daysInMonth; day++) cells.push(day)

  const heatmapWeeks = useMemo<HeatmapWeek[]>(() => {
    const rangeEnd = new Date(year, month, 0)
    const rangeStart = new Date(year, month - 1, 1)
    rangeStart.setMonth(rangeStart.getMonth() - 11)

    const gridStart = new Date(rangeStart)
    gridStart.setDate(gridStart.getDate() - ((gridStart.getDay() + 6) % 7))

    const gridEnd = new Date(rangeEnd)
    gridEnd.setDate(gridEnd.getDate() + (6 - ((gridEnd.getDay() + 6) % 7)))

    const weeks: HeatmapWeek[] = []
    const cursor = new Date(gridStart)

    while (cursor <= gridEnd) {
      const weekStart = new Date(cursor)
      const days: HeatmapDay[] = []
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
          cost: item?.cost ?? 0,
          requests: item?.requests ?? 0,
          isToday: dateStr === today,
          isFuture: current > todayDate,
          inRange,
        })
      }

      weeks.push({
        key: toLocalDateKey(weekStart),
        days,
        firstMonthKey,
      })

      cursor.setDate(cursor.getDate() + 7)
    }

    return weeks
  }, [dataMap, today, todayDate, year, month])

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
      markers.push({
        label: formatter.format(new Date(y, m - 1, 1)),
        column: index + 1,
      })
    })

    return markers
  }, [heatmapWeeks, i18n.language])

  const yearSummary = useMemo(() => {
    let totalCost = 0
    let totalRequests = 0
    for (const item of trendData) {
      totalCost += item.cost
      totalRequests += item.requests
    }
    return { totalCost, totalRequests }
  }, [trendData])

  const getHeatLevel = (cost: number) => {
    if (cost <= 0 || maxCost <= 0) return 0
    const ratio = cost / maxCost
    if (ratio >= 0.75) return 4
    if (ratio >= 0.5) return 3
    if (ratio >= 0.25) return 2
    return 1
  }

  const getCalendarCellStyle = (
    cost: number,
    hasData: boolean,
    isToday: boolean,
  ): React.CSSProperties => {
    if (!hasData) {
      return {
        borderColor: isToday ? token.colorPrimary : token.colorBorderSecondary,
        borderWidth: isToday ? 1.5 : 1,
      }
    }

    const ratio = maxCost > 0 ? Math.min(cost / maxCost, 1) : 0
    const alpha = 0.14 + ratio * 0.7

    return {
      borderColor: isToday ? token.colorPrimary : 'transparent',
      borderWidth: isToday ? 1.5 : 1,
      background: `color-mix(in srgb, ${token.colorPrimary} ${Math.round(alpha * 100)}%, ${token.colorBgContainer})`,
    }
  }

  const heatmapBackgrounds = [
    token.colorFillQuaternary,
    `color-mix(in srgb, ${token.colorPrimary} 18%, ${token.colorBgContainer})`,
    `color-mix(in srgb, ${token.colorPrimary} 38%, ${token.colorBgContainer})`,
    `color-mix(in srgb, ${token.colorPrimary} 60%, ${token.colorBgContainer})`,
    `color-mix(in srgb, ${token.colorPrimary} 86%, ${token.colorBgContainer})`,
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
        ? `0 0 0 1.5px ${token.colorPrimary}, 0 0 0 2.5px ${token.colorBgContainer}`
        : `inset 0 0 0 1px ${ringColor}`,
    }
  }

  if (mode === 'heatmap') {
    const heatmapStyle = {
      ...(style ?? {}),
      ['--week-count' as string]: String(heatmapWeeks.length),
    } as React.CSSProperties

    const costText = formatCostCompact(yearSummary.totalCost)
    const requestsText = yearSummary.totalRequests.toLocaleString()

    return (
      <div style={heatmapStyle} className={styles.heatmapSection}>
        <div className={styles.heatmapSummary}>
          {yearSummary.totalRequests > 0
            ? (month === new Date().getMonth() + 1 && year === new Date().getFullYear()
              ? t('dashboard.heatmapYearSummary', {
                  requests: requestsText,
                  cost: costText,
                })
              : t('dashboard.heatmapCalendarYear', {
                  year: String(year),
                  requests: requestsText,
                  cost: costText,
                }))
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
                    const level = getHeatLevel(day.cost)
                    const tooltipContent = (
                      <div className={styles.tooltipContent}>
                        <div className={styles.tooltipDate}>{day.dateStr}</div>
                        <div className={styles.tooltipRow}>
                          <span className={styles.tooltipDot} style={{ background: heatmapBackgrounds[level] }} />
                          <span>
                            <span className={styles.tooltipCost}>{formatCost(day.cost)}</span>
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
                          data-empty={day.inRange && !day.isFuture && day.cost === 0}
                          style={getHeatmapCellStyle(level, day.isToday, day.isFuture, day.inRange)}
                          aria-label={`${day.dateStr} ${formatCost(day.cost)} ${day.requests} ${t('dashboard.requests')}`}
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

  return (
    <div style={style}>
      <div className={styles.weekdays}>
        {weekdayLabels.map((weekday) => (
          <div key={weekday} className={styles.weekday}>
            {weekday}
          </div>
        ))}
      </div>

      <div className={styles.calendarGrid}>
        {cells.map((day, index) => {
          if (day === null) {
            return <div key={`empty-${index}`} className={styles.emptyCell} />
          }

          const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
          const item = dataMap.get(dateStr)
          const cost = item?.cost ?? 0
          const hasData = cost > 0
          const isToday = dateStr === today

          return (
            <div
              key={dateStr}
              className={styles.calendarCell}
              data-empty={!hasData}
              data-today={isToday}
              style={getCalendarCellStyle(cost, hasData, isToday)}
            >
              <span className={styles.dayNumber}>{day}</span>
              {isToday ? <span className={styles.todayDot} style={{ background: token.colorPrimary }} /> : null}
              {hasData ? <span className={styles.costValue}>{formatCost(cost)}</span> : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
