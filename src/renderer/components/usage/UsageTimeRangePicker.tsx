import { useEffect, useState } from 'react'
import { CalendarOutlined } from '@ant-design/icons'
import { DatePicker, Select } from 'antd'
import { useTranslation } from 'react-i18next'
import type { StatsTimeRange } from '@shared/types'
import styles from './UsageTimeRangePicker.module.css'

const { RangePicker } = DatePicker

type TimeRangeMode = Exclude<StatsTimeRange, `custom:${string}:${string}`> | 'custom'

interface UsageTimeRangePickerProps {
  value: StatsTimeRange
  onChange: (value: StatsTimeRange) => void
}

function modeFromValue(value: StatsTimeRange): TimeRangeMode {
  return value.startsWith('custom:') ? 'custom' : (value as TimeRangeMode)
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
    { value: 'thisWeek', label: t('statistics.thisWeek') },
    { value: 'lastWeek', label: t('statistics.lastWeek') },
    { value: 'month', label: t('statistics.month') },
    { value: 'lastMonth', label: t('statistics.lastMonth') },
    { value: 'today', label: t('statistics.today') },
    { value: 'yesterday', label: t('statistics.yesterday') },
    { value: 'all', label: t('statistics.all') },
    { value: 'custom', label: t('statistics.custom') },
  ]

  return (
    <div className={styles.root}>
      <Select<TimeRangeMode>
        value={mode}
        options={options}
        onChange={(next) => {
          setMode(next)
          if (next !== 'custom') onChange(next)
        }}
        suffixIcon={<CalendarOutlined />}
        className={styles.presetSelect}
        aria-label={t('statistics.timeRange')}
      />
      {mode === 'custom' && (
        <RangePicker
          className={styles.rangePicker}
          allowClear={false}
          format='YYYY-MM-DD'
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
