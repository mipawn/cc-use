/**
 * ConfigPreview - 配置预览组件
 * 展示合并后的真实环境变量配置
 */
import { useMemo } from 'react'
import { Typography, theme, Tooltip, Space } from 'antd'
import { CopyOutlined, CheckOutlined, EyeOutlined, EyeInvisibleOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import type { Provider, ApiKey } from '@shared/types'
import { getProviderTypeConfig } from '@shared/types'
import styles from './ConfigPreview.module.css'

const { Text } = Typography

interface ConfigPreviewProps {
  provider?: Provider | null
  apiKey?: ApiKey | null
  proxyPort?: number
  useProxy?: boolean
  showCopy?: boolean
  showMask?: boolean
  compact?: boolean
  className?: string
}

interface EnvLine {
  key: string
  value: string
  masked?: string
}

export default function ConfigPreview({
  provider,
  apiKey,
  proxyPort = 12345,
  useProxy = true,
  showCopy = true,
  showMask = true,
  compact = false,
  className,
}: ConfigPreviewProps) {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [copied, setCopied] = useState(false)
  const [masked, setMasked] = useState(true)

  // Generate environment variables based on provider type
  const envLines = useMemo<EnvLine[]>(() => {
    if (!provider) {
      return []
    }

    const config = getProviderTypeConfig(provider.type ?? 'claude')
    const baseUrl = useProxy ? `http://localhost:${proxyPort}` : provider.baseUrl
    const keyValue = apiKey?.value || 'YOUR_API_KEY'
    const maskedKey =
      keyValue.length > 8 ? `${keyValue.slice(0, 4)}${'*'.repeat(8)}${keyValue.slice(-4)}` : '****'

    return [
      {
        key: config.envBaseUrlName,
        value: baseUrl,
      },
      {
        key: config.envKeyName,
        value: keyValue,
        masked: maskedKey,
      },
    ]
  }, [provider, apiKey, useProxy, proxyPort])

  // Generate full export command
  const exportCommand = useMemo(() => {
    if (envLines.length === 0) return ''
    return envLines.map((line) => `export ${line.key}="${line.value}"`).join('\n')
  }, [envLines])

  const handleCopy = async () => {
    if (!exportCommand) return
    try {
      await navigator.clipboard.writeText(exportCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('Failed to copy:', error)
    }
  }

  if (!provider) {
    return (
      <div className={`${styles.container} ${styles.empty} ${className || ''}`}>
        <Text type='secondary' className={styles.emptyText}>
          {t('configPreview.selectKeyFirst') || '选择密钥后查看配置'}
        </Text>
      </div>
    )
  }

  return (
    <div className={`${styles.container} ${compact ? styles.compact : ''} ${className || ''}`}>
      {/* Header */}
      <div className={styles.header}>
        <Space size={8}>
          <div className={styles.indicator} style={{ background: token.colorSuccess }} />
          <Text type='secondary' className={styles.headerText}>
            {t('configPreview.envVars') || '环境变量'}
          </Text>
        </Space>
        <Space size={4}>
          {showMask && (
            <Tooltip title={masked ? t('common.show') : t('common.hide')}>
              <button className={styles.iconButton} onClick={() => setMasked(!masked)}>
                {masked ? <EyeOutlined /> : <EyeInvisibleOutlined />}
              </button>
            </Tooltip>
          )}
          {showCopy && (
            <Tooltip title={copied ? t('common.copied') : t('common.copy')}>
              <button className={styles.iconButton} onClick={handleCopy}>
                {copied ? (
                  <CheckOutlined style={{ color: token.colorSuccess }} />
                ) : (
                  <CopyOutlined />
                )}
              </button>
            </Tooltip>
          )}
        </Space>
      </div>

      {/* Code Block */}
      <div className={styles.codeBlock}>
        {envLines.map((line) => (
          <div key={line.key} className={styles.codeLine}>
            <span className={styles.keyword}>export</span>{' '}
            <span className={styles.variable}>{line.key}</span>
            <span className={styles.operator}>=</span>
            <span className={styles.string}>
              "{masked && line.masked ? line.masked : line.value}"
            </span>
          </div>
        ))}
      </div>

      {/* Provider Info */}
      {!compact && (
        <div className={styles.footer}>
          <Text type='secondary' className={styles.footerText}>
            {provider.name}
            {apiKey && (
              <>
                <span className={styles.footerSeparator}>·</span>
                {apiKey.alias || `Key ${apiKey.priority + 1}`}
              </>
            )}
          </Text>
        </div>
      )}
    </div>
  )
}
