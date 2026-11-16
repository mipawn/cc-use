import { Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import type { UsageData } from '@shared/types'
import { formatAccountAmount } from '../../utils/accountQuery'
import ProviderUsageWindows from '../providers/ProviderUsageWindows'

/** A single owner's snapshot. Never aggregate owners, units, windows or groups. */
export default function QuotaSnapshot({
  usage,
  checkedAt,
  owner,
  balance,
  currency,
}: {
  usage: UsageData | null | undefined
  checkedAt?: string | null
  owner: 'account' | 'key'
  balance?: number | null
  currency?: string | null
}) {
  const { t, i18n } = useTranslation()
  const amount = (value: number) => formatAccountAmount(value, usage?.unit)
  const summaries = [
    balance != null ? formatAccountAmount(balance, currency) : null,
    usage?.isUnlimited ? t('resources.unlimited') : null,
    usage?.remaining != null ? t('resources.remaining', { value: amount(usage.remaining) }) : null,
    usage?.used != null ? t('resources.used', { value: amount(usage.used) }) : null,
    usage?.total != null ? t('resources.total', { value: amount(usage.total) }) : null,
  ].filter(Boolean)
  const hasWindows = Boolean(usage?.windows?.length || usage?.groups?.length)
  return (
    <div style={{ fontSize: 12, marginTop: 6 }}>
      <Typography.Text type='secondary'>
        {t(owner === 'account' ? 'resources.accountQuota' : 'resources.keyQuota')}
      </Typography.Text>
      <div>
        {summaries.length
          ? summaries.join(' · ')
          : !hasWindows
            ? t('resources.unknownQuota')
            : null}
      </div>
      {hasWindows && (
        <ProviderUsageWindows windows={usage?.windows ?? []} groups={usage?.groups ?? []} />
      )}
      {usage?.expireAt && (
        <div>
          {t('resources.expires', { time: new Date(usage.expireAt).toLocaleString(i18n.language) })}
        </div>
      )}
      <Typography.Text type='secondary'>
        {checkedAt
          ? t('resources.cachedAt', { time: new Date(checkedAt).toLocaleString(i18n.language) })
          : t('resources.never')}
      </Typography.Text>
    </div>
  )
}
