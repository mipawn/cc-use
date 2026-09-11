import { useEffect, useState, type CSSProperties } from 'react'
import { AppstoreOutlined, PictureOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { getApi } from '../../api'
import { providerIconSrc } from '../../utils/providerIcon'

// Uploaded filenames are immutable. Share reads across the tabs, list and editor.
const uploadedSources = new Map<string, Promise<string>>()

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
  const [loaded, setLoaded] = useState<{ source: string; data: string | null } | null>(null)
  const [failedSource, setFailedSource] = useState<string | null>(null)

  useEffect(() => {
    if (!uploaded) return
    let active = true
    let pending = uploadedSources.get(uploaded)
    if (!pending) {
      const filename = decodeURIComponent(new URL(uploaded).pathname.slice(1))
      pending = getApi().icon.read(filename)
      uploadedSources.set(uploaded, pending)
    }
    pending.then(
      (data) => active && setLoaded({ source: uploaded, data }),
      () => {
        uploadedSources.delete(uploaded)
        if (active) setLoaded({ source: uploaded, data: null })
      },
    )
    return () => {
      active = false
    }
  }, [uploaded])

  const src = uploaded ? (loaded?.source === uploaded ? loaded.data : null) : source
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
