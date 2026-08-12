import { useMemo, useState } from 'react'
import { theme } from 'antd'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts'
import styles from './MultiMetricLineChart.module.css'

interface LineAxisDefinition {
  key: string
  label: string
  orientation: 'left' | 'right'
  formatTick: (value: number) => string
  domain?: [number | 'auto', number | 'auto']
  allowDecimals?: boolean
}

interface LineSeries<T> {
  key: string
  label: string
  color: string
  axisKey: string
  value: (item: T) => number | null
  format: (value: number | null) => string
}

interface TooltipMetric<T> {
  key: string
  label: string
  color: string
  value: (item: T) => number | null
  format: (value: number | null) => string
}

interface MultiMetricLineChartProps<T> {
  data: T[]
  series: LineSeries<T>[]
  tooltipMetrics?: TooltipMetric<T>[]
  axes: LineAxisDefinition[]
  getDate: (item: T) => string
  ariaLabel: string
  legendHint: string
  sampledHint: (shown: number, total: number) => string
}

interface ChartDatum {
  date: string
  [key: string]: string | number | null
}

const MAX_RENDERED_POINTS = 400

function sampleEvenly<T>(data: T[], limit = MAX_RENDERED_POINTS): T[] {
  if (limit <= 0) return []
  if (limit === 1) return data.length === 0 ? [] : [data[0]]
  if (data.length <= limit) return data
  return Array.from({ length: limit }, (_, index) => {
    const sourceIndex = Math.round((index * (data.length - 1)) / (limit - 1))
    return data[sourceIndex]
  })
}

function dateLabel(date: string): string {
  const value = new Date(`${date}T00:00:00`)
  return `${value.getMonth() + 1}/${value.getDate()}`
}

function MultiMetricLineChart<T>({
  data,
  series,
  tooltipMetrics = [],
  axes,
  getDate,
  ariaLabel,
  legendHint,
  sampledHint,
}: MultiMetricLineChartProps<T>) {
  const { token } = theme.useToken()
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set())

  const renderedData = useMemo(() => sampleEvenly(data), [data])
  const chartData = useMemo<ChartDatum[]>(
    () =>
      renderedData.map((item) => {
        const datum: ChartDatum = { date: getDate(item) }
        const metricDefinitions = [...series, ...tooltipMetrics]
        metricDefinitions.forEach((definition) => {
          datum[definition.key] = definition.value(item)
        })
        return datum
      }),
    [getDate, renderedData, series, tooltipMetrics],
  )

  const visibleSeries = series.filter((item) => !hiddenSeries.has(item.key))
  const activeAxisKeys = new Set(visibleSeries.map((item) => item.axisKey))
  const visibleAxes = axes.filter((axis) => activeAxisKeys.has(axis.key))

  const toggleSeries = (key: string) => {
    setHiddenSeries((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const renderTooltip = ({ active, payload, label }: TooltipContentProps<number, string>) => {
    if (!active || !payload?.length) return null
    const datum = payload[0]?.payload as ChartDatum | undefined
    return (
      <div className={styles.tooltip} role='tooltip' data-testid='multi-metric-chart-tooltip'>
        <strong className={styles.tooltipDate}>{String(label)}</strong>
        {payload.map((entry) => {
          const definition = series.find((item) => item.key === entry.dataKey)
          if (!definition) return null
          const value = typeof entry.value === 'number' ? entry.value : null
          return (
            <span key={definition.key} className={styles.tooltipRow}>
              <span className={styles.tooltipDot} style={{ background: definition.color }} />
              <span className={styles.tooltipLabel}>{definition.label}</span>
              <strong>{definition.format(value)}</strong>
            </span>
          )
        })}
        {datum && tooltipMetrics.length > 0 && (
          <span className={styles.tooltipMetaGroup}>
            {tooltipMetrics.map((metric) => {
              const rawValue = datum[metric.key]
              const value = typeof rawValue === 'number' ? rawValue : null
              return (
                <span key={metric.key} className={styles.tooltipRow}>
                  <span className={styles.tooltipDot} style={{ background: metric.color }} />
                  <span className={styles.tooltipLabel}>{metric.label}</span>
                  <strong>{metric.format(value)}</strong>
                </span>
              )
            })}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className={styles.root} aria-label={ariaLabel}>
      <div className={styles.legend}>
        <div className={styles.legendItems}>
          {series.map((item) => {
            const visible = !hiddenSeries.has(item.key)
            return (
              <button
                type='button'
                key={item.key}
                className={`${styles.legendItem} ${visible ? '' : styles.legendItemHidden}`}
                aria-pressed={visible}
                onClick={() => toggleSeries(item.key)}
              >
                <span className={styles.legendLine} style={{ background: item.color }} />
                {item.label}
              </button>
            )
          })}
        </div>
        <span className={styles.legendHint}>
          {data.length > renderedData.length
            ? sampledHint(renderedData.length, data.length)
            : legendHint}
        </span>
      </div>

      <div className={styles.axisCaptions} aria-hidden='true'>
        <span>{visibleAxes.find((axis) => axis.orientation === 'left')?.label}</span>
        <span>{visibleAxes.find((axis) => axis.orientation === 'right')?.label}</span>
      </div>

      <div
        className={styles.chartWrap}
        data-input-points={data.length}
        data-rendered-points={renderedData.length}
      >
        <ResponsiveContainer width='100%' height={286} minWidth={0}>
          <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
            <CartesianGrid
              vertical={false}
              stroke={token.colorBorderSecondary}
              strokeDasharray='3 5'
            />
            <XAxis
              dataKey='date'
              axisLine={false}
              tickLine={false}
              tick={{ fill: token.colorTextSecondary, fontSize: 11 }}
              tickFormatter={dateLabel}
              minTickGap={30}
              padding={{ left: 6, right: 6 }}
            />
            {visibleAxes.map((axis) => (
              <YAxis
                key={axis.key}
                yAxisId={axis.key}
                orientation={axis.orientation}
                domain={axis.domain ?? [0, 'auto']}
                allowDecimals={axis.allowDecimals ?? false}
                axisLine={false}
                tickLine={false}
                width={58}
                tick={{ fill: token.colorTextSecondary, fontSize: 11 }}
                tickFormatter={axis.formatTick}
              />
            ))}
            <Tooltip
              cursor={{ stroke: token.colorTextSecondary, strokeDasharray: '4 4' }}
              content={renderTooltip}
              animationDuration={100}
            />
            {visibleSeries.map((item) => (
              <Line
                key={item.key}
                type='monotone'
                dataKey={item.key}
                name={item.label}
                yAxisId={item.axisKey}
                stroke={item.color}
                strokeWidth={2.25}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, fill: token.colorBgContainer }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

export default MultiMetricLineChart
export { MAX_RENDERED_POINTS, sampleEvenly }
export type { LineAxisDefinition, LineSeries, TooltipMetric }
