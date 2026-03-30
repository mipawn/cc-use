/**
 * ConfigPreview - 配置预览组件
 * 展示真实启动时使用的环境变量配置
 */
import { useMemo, useState } from 'react'
import { Typography, theme, Tooltip, Space } from 'antd'
import { CopyOutlined, CheckOutlined, EyeOutlined, EyeInvisibleOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { Provider, ApiKey, TerminalLaunchPreview } from '@shared/types'
import styles from './ConfigPreview.module.css'

const { Text } = Typography

interface ConfigPreviewProps {
  provider?: Provider | null
  apiKey?: ApiKey | null
  preview?: TerminalLaunchPreview | null
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

function maskValue(key: string, value: string): string {
  const shouldMask = /(KEY|TOKEN|AUTH)/i.test(key)
  if (!shouldMask) return value
  return value.length > 8 ? `${value.slice(0, 4)}${'*'.repeat(8)}${value.slice(-4)}` : '****'
}

export default function ConfigPreview({
  provider,
  apiKey,
  preview,
  showCopy = true,
  showMask = true,
  compact = false,
  className,
}: ConfigPreviewProps) {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const [copied, setCopied] = useState(false)
  const [masked, setMasked] = useState(true)

  const envLines = useMemo<EnvLine[]>(() => {
    if (!preview) return []
    return Object.entries(preview.env)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({
        key,
        value,
        masked: maskValue(key, value),
      }))
  }, [preview])

  const exportCommand = useMemo(() => {
    if (!preview) return ''
    const exports = envLines.map((line) => `export ${line.key}="${line.value}"`).join('\n')
    return [exports, preview.command].filter(Boolean).join('\n')
  }, [envLines, preview])

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

  if (!preview) {
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
        <div className={styles.codeLine}>
          <span className={styles.variable}>{preview.command}</span>
        </div>
      </div>

      {!compact && (
        <div className={styles.footer}>
          <Text type='secondary' className={styles.footerText}>
            {provider?.name || preview.cliType}
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
