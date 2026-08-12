import { useEffect, useState } from 'react'
import { DatePicker, Segmented } from 'antd'
import { useTranslation } from 'react-i18next'
import type { StatsTimeRange } from '@shared/types'
import styles from './UsageTimeRangePicker.module.css'

const { RangePicker } = DatePicker

type TimeRangeMode = 'week' | 'last30Days' | 'lastYear' | 'month' | 'lastMonth' | 'year' | 'custom'

interface UsageTimeRangePickerProps {
  value: StatsTimeRange
  onChange: (value: StatsTimeRange) => void
}

function modeFromValue(value: StatsTimeRange): TimeRangeMode {
  if (value.startsWith('custom:')) return 'custom'
  if (
    value === 'last30Days' ||
    value === 'lastYear' ||
    value === 'month' ||
    value === 'lastMonth' ||
    value === 'year'
  ) {
    return value
  }
  return 'week'
}

export default function UsageTimeRangePicker({ value, onChange }: UsageTimeRangePickerProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<TimeRangeMode>(() => modeFromValue(value))

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
