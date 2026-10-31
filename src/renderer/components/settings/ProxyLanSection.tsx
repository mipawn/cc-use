import { Alert, Button, Tag, Typography } from 'antd'
import { CopyOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { ProxyLanAddress, ProxyLanInfo } from '@shared/types'
import styles from './ProxyLanSection.module.css'

const { Text } = Typography

export interface ProxyLanAddressListProps {
  addresses: ProxyLanAddress[]
  onCopy: (url: string) => void
}

/**
 * Read-only list of reachable LAN gateway URLs with the interface name and a
 * copy button per entry. The caller owns the empty state so the same list can
 * be embedded in the settings warning block or elsewhere.
 */
export function ProxyLanAddressList({ addresses, onCopy }: ProxyLanAddressListProps) {
  const { t } = useTranslation()
  return (
    <ul className={styles.addressList}>
      {addresses.map((address) => (
        <li key={`${address.interface ?? 'if'}:${address.ip}`} className={styles.addressItem}>
          <code className={styles.addressUrl}>{address.url}</code>
          {address.interface && <Tag className={styles.interfaceTag}>{address.interface}</Tag>}
          <Button
            type='text'
            size='small'
            icon={<CopyOutlined />}
            aria-label={t('settings.copyLanUrl')}
            onClick={() => onCopy(address.url)}
          />
        </li>
      ))}
    </ul>
  )
}

export interface ProxyLanSectionProps {
  /** Latest `api.proxy.lanAddresses()` result, or null before the first load. */
  info: ProxyLanInfo | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  onCopy: (url: string) => void
}

/**
 * LAN-access block for the settings page: the required security warning, the
 * discovered IPv4 entries with copy buttons, and the explicit empty reason.
 * Purely presentational — the page loads `info` through
 * `api.proxy.lanAddresses()` and owns toasts/refresh side effects.
 */
export default function ProxyLanSection({
  info,
  loading,
  error,
  onRefresh,
  onCopy,
}: ProxyLanSectionProps) {
  const { t } = useTranslation()
  const addresses = info?.addresses ?? []

  return (
    <div className={styles.section}>
      <Alert
        type='warning'
        showIcon
        title={t('settings.lanWarningTitle')}
        description={t('settings.lanWarningDesc')}
      />
      {error ? (
        <Alert
          type='error'
          showIcon
          title={t('settings.lanLoadFailed')}
          description={error}
          action={
            <Button size='small' onClick={onRefresh}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : (
        <div className={styles.entries}>
          <div className={styles.entriesHeader}>
            <Text strong>{t('settings.lanEntries')}</Text>
            <Button
              size='small'
              type='text'
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={onRefresh}
            >
              {t('common.refresh')}
            </Button>
          </div>
          {loading && !info ? (
            <Text type='secondary'>{t('common.loading')}</Text>
          ) : addresses.length > 0 ? (
            <ProxyLanAddressList addresses={addresses} onCopy={onCopy} />
          ) : (
            <div className={styles.empty}>
              <Text type='secondary' className={styles.note}>
                {t('settings.lanEmpty')}
              </Text>
              <Text type='secondary' className={styles.note}>
                {t('settings.lanIpv6Note')}
              </Text>
            </div>
          )}
        </div>
      )}
      <ul className={styles.notes}>
        <li>{t('settings.lanManagementNote')}</li>
      </ul>
    </div>
  )
}
