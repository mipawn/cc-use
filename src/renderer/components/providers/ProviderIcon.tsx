import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { AppstoreOutlined, PictureOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { providerIconSrc } from '../../utils/providerIcon'
import {
  getUploadedIconsRevision,
  isUploadedIconDeleted,
  readUploadedIcon,
  subscribeUploadedIcons,
} from '../../utils/providerIconCache'

export default function ProviderIcon({
  icon,
  name = '',
  size = 24,
  className,
  style,
}: {
  icon?: string | null
  name?: string
  size?: number
  className?: string
  style?: CSSProperties
}) {
  const { t } = useTranslation()
  const source = providerIconSrc(icon)
  const uploaded = source?.startsWith('cc-use-icon:') ? source : null
  const revision = useSyncExternalStore(subscribeUploadedIcons, getUploadedIconsRevision)
  const deleted = Boolean(icon && isUploadedIconDeleted(icon))
  const [loaded, setLoaded] = useState<{ source: string; data: string | null } | null>(null)
  const [failedSource, setFailedSource] = useState<string | null>(null)

  useEffect(() => {
    if (!uploaded || deleted) return
    let active = true
    const filename = decodeURIComponent(new URL(uploaded).pathname.slice(1))
    const pending = readUploadedIcon(filename)
    pending.then(
      (data) => active && setLoaded({ source: uploaded, data }),
      () => {
        if (active) setLoaded({ source: uploaded, data: null })
      },
    )
    return () => {
      active = false
    }
  }, [uploaded, deleted, revision])

  const src = deleted
    ? null
    : uploaded
      ? loaded?.source === uploaded
        ? loaded.data
        : null
      : source
  const failed = Boolean(
    source &&
    (failedSource === source || (uploaded && loaded?.source === uploaded && loaded.data === null)),
  )
  const dimensions: CSSProperties = {
    width: size,
    height: size,
    flexShrink: 0,
    objectFit: 'contain',
    ...style,
  }
  if (src && !failed) {
    return (
      <img
        src={src}
        alt={name}
        className={className}
        style={dimensions}
        onError={() => setFailedSource(source)}
      />
    )
  }
  return (
    <span
      className={className}
      role='img'
      aria-label={failed ? t('providers.iconLoadFailed') : name}
      title={failed ? t('providers.iconLoadFailed') : name}
      style={{
        ...dimensions,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--ant-color-text-tertiary)',
      }}
    >
      {failed ? <PictureOutlined /> : <AppstoreOutlined />}
    </span>
  )
}
