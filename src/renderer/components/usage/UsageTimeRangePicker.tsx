import { useEffect, useMemo, useState } from 'react'
import { DatePicker, Segmented } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { useTranslation } from 'react-i18next'
import type { StatsTimeRange } from '@shared/types'
import styles from './UsageTimeRangePicker.module.css'

const { RangePicker } = DatePicker

type TimeRangeMode =
  | 'week'
  | 'last30Days'
  | 'lastYear'
  | 'month'
  | 'lastMonth'
  | 'year'
  | 'all'
  | 'custom'

interface UsageTimeRangePickerProps {
  value: StatsTimeRange
  onChange: (value: StatsTimeRange) => void
}

function modeFromValue(value: StatsTimeRange): TimeRangeMode {
  if (value === 'today' || value === 'yesterday' || value.startsWith('custom:')) return 'custom'
  if (
    value === 'last30Days' ||
    value === 'lastYear' ||
    value === 'month' ||
    value === 'lastMonth' ||
    value === 'year' ||
    value === 'all'
  ) {
    return value
  }
  return 'week'
}

export default function UsageTimeRangePicker({ value, onChange }: UsageTimeRangePickerProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<TimeRangeMode>(() => modeFromValue(value))
  const localToday = dayjs().format('YYYY-MM-DD')
  const customRange = useMemo<[Dayjs, Dayjs] | null>(() => {
    if (value === 'today' || value === 'yesterday') {
      // Calendar-day subtraction respects DST; a day is not always 24 hours.
      const date = dayjs(localToday).subtract(value === 'yesterday' ? 1 : 0, 'day')
      return [date, date]
    }
    if (!value.startsWith('custom:')) return null
    const [, start, end] = value.split(':')
    // Parse calendar dates locally; Date's ISO-date parsing would shift them from UTC.
    return [dayjs(start), dayjs(end)]
  }, [value, localToday])

  // Choosing custom is only a local draft until both dates are committed.
  useEffect(() => {
    setMode(modeFromValue(value))
  }, [value])

  const options: { value: TimeRangeMode; label: string }[] = [
    { value: 'week', label: t('statistics.week') },
    { value: 'last30Days', label: t('statistics.last30Days') },
    { value: 'lastYear', label: t('statistics.lastYear') },
    { value: 'month', label: t('statistics.month') },
    { value: 'lastMonth', label: t('statistics.lastMonth') },
    { value: 'year', label: t('statistics.year') },
    { value: 'all', label: t('statistics.all') },
    { value: 'custom', label: t('statistics.custom') },
  ]

  return (
    <div className={styles.root}>
      <Segmented<TimeRangeMode>
        value={mode}
        options={options}
        onChange={(next) => {
          setMode(next)
          if (next !== 'custom') onChange(next)
        }}
        className={styles.presetSegmented}
        aria-label={t('statistics.timeRange')}
      />
      {mode === 'custom' && (
        <RangePicker
          value={customRange}
          className={styles.rangePicker}
          allowClear={false}
          format='YYYY-MM-DD'
          placeholder={[t('statistics.startDate'), t('statistics.endDate')]}
          separator={t('statistics.rangeSeparator')}
          disabledDate={(current) => current.valueOf() > Date.now()}
          onChange={(dates, dateStrings) => {
            if (dates?.[0] && dates[1] && dateStrings[0] && dateStrings[1]) {
              onChange(`custom:${dateStrings[0]}:${dateStrings[1]}`)
            }
          }}
        />
      )}
    </div>
  )
}
