import { useState, type PointerEvent } from 'react'
import { theme } from 'antd'
import styles from './MultiMetricLineChart.module.css'

interface LineSeries<T> {
  key: string
  label: string
  color: string
  value: (item: T) => number | null
  format: (value: number | null) => string
  /** Fixed scale ceiling, for example 1 for a percentage. */
  domainMax?: number
}

interface MultiMetricLineChartProps<T> {
  data: T[]
  series: LineSeries<T>[]
  getDate: (item: T) => string
  ariaLabel: string
  relativeScaleLabel: string
}

interface ChartPoint {
  x: number
  y: number | null
}

const CHART_WIDTH = 920
const CHART_HEIGHT = 250
const PADDING = { top: 16, right: 18, bottom: 34, left: 48 }
const PLOT_WIDTH = CHART_WIDTH - PADDING.left - PADDING.right
const PLOT_HEIGHT = CHART_HEIGHT - PADDING.top - PADDING.bottom

function dateLabel(date: string): string {
  const value = new Date(`${date}T00:00:00`)
  return `${value.getMonth() + 1}/${value.getDate()}`
}

function linePath(points: ChartPoint[]): string {
  let drawing = false
  return points
    .map((point) => {
      if (point.y == null) {
        drawing = false
        return ''
      }
      const command = drawing ? 'L' : 'M'
      drawing = true
      return `${command} ${point.x} ${point.y}`
    })
    .filter(Boolean)
    .join(' ')
}

function MultiMetricLineChart<T>({
  data,
  series,
  getDate,
  ariaLabel,
  relativeScaleLabel,
}: MultiMetricLineChartProps<T>) {
  const { token } = theme.useToken()
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const labelStep = Math.max(1, Math.ceil(data.length / 7))

  const xAt = (index: number) =>
    data.length === 1
      ? PADDING.left + PLOT_WIDTH / 2
      : PADDING.left + (index / Math.max(data.length - 1, 1)) * PLOT_WIDTH

  const renderedSeries = series.map((definition) => {
    const values = data.map(definition.value)
    const observedMax = Math.max(...values.map((value) => value ?? 0), 1)
    const domainMax = definition.domainMax ?? observedMax
    const points = values.map(
      (value, index): ChartPoint => ({
        x: xAt(index),
        y:
          value == null
            ? null
            : PADDING.top +
              PLOT_HEIGHT -
              (Math.min(Math.max(value, 0), domainMax) / domainMax) * PLOT_HEIGHT,
      }),
    )
    return { definition, values, points, path: linePath(points) }
  })

  const handlePointerMove = (event: PointerEvent<SVGRectElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width <= 0 || data.length === 0) return
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width))
    setHoveredIndex(Math.round(ratio * Math.max(data.length - 1, 0)))
  }

  const hoveredX = hoveredIndex == null ? null : xAt(hoveredIndex)
  const tooltipSide =
    hoveredIndex == null || data.length <= 1
      ? 'center'
      : hoveredIndex < data.length / 3
        ? 'start'
        : hoveredIndex > (data.length - 1) * (2 / 3)
          ? 'end'
          : 'center'

  return (
    <div className={styles.root}>
      <div className={styles.legend} aria-label={ariaLabel}>
        {series.map((item) => (
          <span key={item.key} className={styles.legendItem}>
            <span className={styles.legendLine} style={{ background: item.color }} />
            {item.label}
          </span>
        ))}
        <span className={styles.scaleLabel}>{relativeScaleLabel}</span>
      </div>

      <div className={styles.scroller}>
        <div className={styles.chartWrap}>
          <svg
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            className={styles.chart}
            role='img'
            aria-label={ariaLabel}
          >
            {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
              const y = PADDING.top + PLOT_HEIGHT - ratio * PLOT_HEIGHT
              return (
                <g key={ratio}>
                  <line
                    x1={PADDING.left}
                    x2={CHART_WIDTH - PADDING.right}
                    y1={y}
                    y2={y}
                    stroke={token.colorBorderSecondary}
                    strokeDasharray='3 4'
                  />
                  <text
                    x={PADDING.left - 9}
                    y={y + 4}
                    textAnchor='end'
                    fill={token.colorTextSecondary}
                    fontSize='10'
                  >
                    {Math.round(ratio * 100)}%
                  </text>
                </g>
              )
            })}

            {renderedSeries.map(({ definition, points, path }) => (
              <g key={definition.key}>
                <path
                  d={path}
                  fill='none'
                  stroke={definition.color}
                  strokeWidth='2.5'
                  strokeLinejoin='round'
                  strokeLinecap='round'
                />
                {points.map((point, index) =>
                  point.y == null ? null : (
                    <circle
                      key={`${definition.key}-${getDate(data[index])}`}
                      cx={point.x}
                      cy={point.y}
                      r={hoveredIndex === index ? 4.5 : 3}
                      fill={token.colorBgContainer}
                      stroke={definition.color}
                      strokeWidth='2'
                    />
                  ),
                )}
              </g>
            ))}

            {hoveredX != null && (
              <line
                x1={hoveredX}
                x2={hoveredX}
                y1={PADDING.top}
                y2={PADDING.top + PLOT_HEIGHT}
                stroke={token.colorTextSecondary}
                strokeDasharray='4 4'
                pointerEvents='none'
              />
            )}

            {data.map((item, index) =>
              index % labelStep === 0 || index === data.length - 1 ? (
                <text
                  key={getDate(item)}
                  x={xAt(index)}
                  y={CHART_HEIGHT - 10}
                  textAnchor='middle'
                  fill={token.colorTextSecondary}
                  fontSize='10'
                >
                  {dateLabel(getDate(item))}
                </text>
              ) : null,
            )}

            <rect
              x={PADDING.left}
              y={PADDING.top}
              width={PLOT_WIDTH}
              height={PLOT_HEIGHT}
              fill='transparent'
              className={styles.hitArea}
              onPointerMove={handlePointerMove}
              onPointerLeave={() => setHoveredIndex(null)}
            />
          </svg>

          {hoveredIndex != null && data[hoveredIndex] && (
            <div
              className={`${styles.tooltip} ${styles[`tooltip${tooltipSide[0].toUpperCase()}${tooltipSide.slice(1)}`]}`}
              style={{ left: `${(xAt(hoveredIndex) / CHART_WIDTH) * 100}%` }}
              role='tooltip'
              data-testid='multi-metric-chart-tooltip'
            >
              <strong className={styles.tooltipDate}>{getDate(data[hoveredIndex])}</strong>
              {renderedSeries.map(({ definition, values }) => (
                <span key={definition.key} className={styles.tooltipRow}>
                  <span className={styles.tooltipDot} style={{ background: definition.color }} />
                  <span className={styles.tooltipLabel}>{definition.label}</span>
                  <strong>{definition.format(values[hoveredIndex])}</strong>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default MultiMetricLineChart
export type { LineSeries }
