import { useMemo, useState } from 'react'
import { theme } from 'antd'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts'
import type { DailyModelUsageItem, TrendGranularity } from '@shared/types'
import { formatTokenCount } from '../../utils/formatTokens'
import { formatTrendTick } from './MultiMetricLineChart'
import styles from './DailyModelUsageChart.module.css'

/**
 * Stacked daily model usage. One bar per time bucket (day / week / month from
 * the backend), one stack segment per model, so a hover reads the daily
 * composition per model. Mirrors the supplier trend chart's tooltip and legend
 * interaction.
 */
const MODEL_PALETTE = [
  '#1677ff',
  '#52c41a',
  '#722ed1',
  '#d48806',
  '#13a8a8',
  '#eb2f96',
  '#fa541c',
  '#2f54eb',
  '#a0d911',
  '#cf1322',
]

interface DailyModelUsageChartProps {
  data: DailyModelUsageItem[]
  granularity?: TrendGranularity
  legendHint: string
  ariaLabel: string
  unknownModelLabel: string
}

interface ChartDatum {
  date: string
  [model: string]: string | number
}

function displayModel(model: string, unknownModelLabel: string): string {
  return model.trim() || unknownModelLabel
}

function DailyModelUsageChart({
  data,
  granularity = 'day',
  legendHint,
  ariaLabel,
  unknownModelLabel,
}: DailyModelUsageChartProps) {
  const { token } = theme.useToken()
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage || i18n.language || 'en'
  const [hiddenModels, setHiddenModels] = useState<Set<string>>(() => new Set())

  const { models, chartData } = useMemo(() => {
    const totals = new Map<string, number>()
    const byDate = new Map<string, ChartDatum>()
    for (const item of data) {
      const model = displayModel(item.model, unknownModelLabel)
      totals.set(model, (totals.get(model) ?? 0) + item.tokens)
      const datum = byDate.get(item.date) ?? { date: item.date }
      datum[model] = ((datum[model] as number | undefined) ?? 0) + item.tokens
      byDate.set(item.date, datum)
    }
    const models = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([model]) => model)
    const chartData = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
    return { models, chartData }
  }, [data, unknownModelLabel])

  const colorFor = (model: string) =>
    MODEL_PALETTE[Math.max(0, models.indexOf(model)) % MODEL_PALETTE.length]

  const visibleModels = models.filter((model) => !hiddenModels.has(model))

  const toggleModel = (model: string) => {
    setHiddenModels((current) => {
      const next = new Set(current)
      if (next.has(model)) next.delete(model)
      else next.add(model)
      return next
    })
  }

  const renderTooltip = ({ active, payload, label }: TooltipContentProps<number, string>) => {
    if (!active || !payload?.length) return null
    const entries = payload.filter(
      (entry) => typeof entry.value === 'number' && entry.value > 0,
    )
    if (entries.length === 0) return null
    return (
      <div className={styles.tooltip} role='tooltip' data-testid='daily-model-chart-tooltip'>
        <strong className={styles.tooltipDate}>{String(label)}</strong>
        {entries.map((entry) => (
          <span key={String(entry.dataKey)} className={styles.tooltipRow}>
            <span
              className={styles.tooltipDot}
              style={{ background: colorFor(String(entry.dataKey)) }}
            />
            <span className={styles.tooltipLabel}>{String(entry.dataKey)}</span>
            <strong>{formatTokenCount(entry.value as number, language)}</strong>
          </span>
        ))}
      </div>
    )
  }

  return (
    <div className={styles.root} aria-label={ariaLabel}>
      <div className={styles.legend}>
        <div className={styles.legendItems}>
          {models.map((model) => {
            const visible = !hiddenModels.has(model)
            return (
              <button
                type='button'
                key={model}
                className={`${styles.legendItem} ${visible ? '' : styles.legendItemHidden}`}
                aria-pressed={visible}
                onClick={() => toggleModel(model)}
              >
                <span className={styles.legendSwatch} style={{ background: colorFor(model) }} />
                {model}
              </button>
            )
          })}
        </div>
        <span className={styles.legendHint}>{legendHint}</span>
      </div>

      <div className={styles.chartWrap} data-points={chartData.length}>
        <ResponsiveContainer width='100%' height={286} minWidth={0}>
          <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
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
              tickFormatter={(date) => formatTrendTick(date, granularity)}
              minTickGap={30}
              padding={{ left: 6, right: 6 }}
            />
            <YAxis
              domain={[0, 'auto']}
              axisLine={false}
              tickLine={false}
              width={58}
              tick={{ fill: token.colorTextSecondary, fontSize: 11 }}
              tickFormatter={(value) => formatTokenCount(Number(value), language)}
            />
            <Tooltip
              cursor={{ fill: token.colorFillTertiary }}
              content={renderTooltip}
              animationDuration={100}
            />
            {visibleModels.map((model) => (
              <Bar
                key={model}
                dataKey={model}
                stackId='tokens'
                fill={colorFor(model)}
                isAnimationActive={false}
                maxBarSize={46}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

export default DailyModelUsageChart
