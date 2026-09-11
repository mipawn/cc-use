import styles from './ProviderUsageWindows.module.css'
import { usageWindowLabel } from '../../utils/accountQuery'
import { Progress, Typography, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import type { UsageGroup, UsageWindow } from '@shared/types'

const { Text } = Typography

/**
 * Rolling metering periods, all visible at once.
 *
 * These are periods, not money: the percentages are never summed into a single
 * figure the provider never stated, and a period with no reported percentage
 * says so instead of showing 0%. Groups (when a provider meters per model) are
 * listed separately for the same reason — averaging them would invent a total
 * that does not exist.
 */
export default function ProviderUsageWindows({
  windows,
  groups = [],
}: {
  windows: UsageWindow[]
  groups?: UsageGroup[]
}) {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  if (groups.length > 0) {
    return (
      <div className={styles.groups}>
        {groups.map((group) => (
          <div key={group.id}>
            <Text type='secondary' style={{ fontSize: 12 }}>
              {group.label}
            </Text>
            <WindowList windows={group.windows} />
          </div>
        ))}
      </div>
    )
  }

  return <WindowList windows={windows} />

  function WindowList({ windows: list }: { windows: UsageWindow[] }) {
    return (
      <div className={styles.windows}>
        {list.map((window) => (
          <div key={window.id} className={styles.window}>
            <div className={styles.heading}>
              <Text>{usageWindowLabel(window, t)}</Text>
              <Text type='secondary' className={styles.percent}>
                {window.usedPercent === null
                  ? t('providers.usageWindowUnknown')
                  : t('providers.usageWindowUsed', { percent: window.usedPercent.toFixed(0) })}
              </Text>
            </div>
            <Progress
              percent={window.usedPercent ?? 0}
              showInfo={false}
              size='small'
              strokeColor={progressColor(window.usedPercent, token.colorPrimary)}
              trailColor={window.usedPercent === null ? 'transparent' : undefined}
            />
            <Text type='secondary' className={styles.reset}>
              {resetLabel(window.resetsAt, t)}
              {window.status && window.status !== 'ok'
                ? ` · ${t(`providers.usageStatus.${window.status}`, { defaultValue: window.status })}`
                : ''}
            </Text>
          </div>
        ))}
      </div>
    )
  }
}

/** Warn as a period fills; the colour is redundant with the printed percent. */
function progressColor(percent: number | null, fallback: string): string {
  if (percent === null) return fallback
  if (percent >= 90) return '#f48771'
  if (percent >= 70) return '#d7ba7d'
  return fallback
}

function resetLabel(
  resetsAt: string | null,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!resetsAt) return ''
  const reset = new Date(resetsAt)
  if (Number.isNaN(reset.getTime())) {
    return t('providers.usageWindowResetsAt', { time: resetsAt }) || `重置 ${resetsAt}`
  }
  const remainingMs = reset.getTime() - Date.now()
  if (remainingMs <= 0) return t('providers.usageWindowResetting') || '即将重置'
  const minutes = Math.floor(remainingMs / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const countdown =
    days > 0
      ? t('providers.usageCountdownDays', { days, hours: hours % 24 }) || `${days}d ${hours % 24}h`
      : hours > 0
        ? t('providers.usageCountdownHours', { hours, minutes: minutes % 60 }) ||
          `${hours}h ${minutes % 60}m`
        : t('providers.usageCountdownMinutes', { minutes }) || `${minutes}m`
  return t('providers.usageWindowResetsIn', { countdown }) || `${countdown}${' 后重置'}`
}
