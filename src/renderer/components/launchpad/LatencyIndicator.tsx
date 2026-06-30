import { Tooltip } from 'antd'
import { useTranslation } from 'react-i18next'
import type { LatencyReport } from '../../../shared/types'

/// Latency thresholds (ms) for the status dot color.
const SLOW_MS = 1000

type DotState = 'fast' | 'slow' | 'down' | 'idle'

function dotColor(state: DotState): string {
  switch (state) {
    case 'fast':
      return '#52c41a'
    case 'slow':
      return '#faad14'
    case 'down':
      return '#ff4d4f'
    default:
      return '#bfbfbf'
  }
}

function latencyState(reachable: boolean, ms: number | null): DotState {
  if (!reachable || ms == null) return 'down'
  return ms > SLOW_MS ? 'slow' : 'fast'
}

function Pill({ label, state, text, tip }: { label: string; state: DotState; text: string; tip?: string }) {
  const body = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: dotColor(state),
          flexShrink: 0,
        }}
      />
      <span style={{ color: '#8c8c8c' }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{text}</span>
    </span>
  )
  return tip ? <Tooltip title={tip}>{body}</Tooltip> : body
}

/// Compact upstream latency display for a provider row.
/// `report` is null until the first probe resolves.
export default function LatencyIndicator({ report }: { report: LatencyReport | null }) {
  const { t } = useTranslation()

  const upstreamState: DotState = report
    ? latencyState(report.upstreamReachable, report.upstreamLatencyMs)
    : 'idle'

  const fmt = (reachable: boolean, ms: number | null): string => {
    if (!report) return '…'
    if (!reachable || ms == null) return t('latency.unreachable')
    return `${ms}ms`
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      <Pill
        label={t('latency.upstream')}
        state={upstreamState}
        text={fmt(report?.upstreamReachable ?? false, report?.upstreamLatencyMs ?? null)}
        tip={report?.upstreamError ?? undefined}
      />
    </span>
  )
}
