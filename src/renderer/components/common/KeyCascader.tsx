/**
 * KeyCascader - 级联选择器组件
 * Provider → Key 两级结构，清晰展示层级关系
 */
import { useMemo } from 'react'
import { Cascader, Space, Tag, Typography, theme } from 'antd'
import { KeyOutlined, CloudServerOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { Provider, ApiKey } from '@shared/types'
import styles from './KeyCascader.module.css'

const { Text } = Typography

interface KeyCascaderProps {
  providers: Provider[]
  apiKeys: ApiKey[]
  value?: [string, string] | null // [providerId, keyId]
  onChange?: (value: [string, string] | null, provider?: Provider, apiKey?: ApiKey) => void
  placeholder?: string
  size?: 'small' | 'middle' | 'large'
  allowClear?: boolean
  disabled?: boolean
  className?: string
  style?: React.CSSProperties
  showKeyCount?: boolean
  showProviderIcon?: boolean
  expandTrigger?: 'click' | 'hover'
}

interface CascaderOption {
  value: string
  label: React.ReactNode
  disabled?: boolean
  children?: CascaderOption[]
  provider?: Provider
  apiKey?: ApiKey
}

export default function KeyCascader({
  providers,
  apiKeys,
  value,
  onChange,
  placeholder,
  size = 'middle',
  allowClear = true,
  disabled = false,
  className,
  style,
  showKeyCount = true,
  showProviderIcon = true,
  expandTrigger = 'click',
}: KeyCascaderProps) {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  // Build cascader options: Provider → Keys
  const options = useMemo<CascaderOption[]>(() => {
    return providers
      .filter((p) => p.isActive)
      .map((provider) => {
        const providerKeys = apiKeys.filter(
          (k) => k.providerId === provider.id && k.isActive && !k.isExhausted
        )
        const hasKeys = providerKeys.length > 0

        return {
          value: provider.id,
          label: (
            <Space size={8} className={styles.providerLabel}>
              {showProviderIcon && (
                <CloudServerOutlined style={{ color: token.colorTextSecondary }} />
              )}
              <span className={styles.providerName}>{provider.name}</span>
              {showKeyCount && (
                <Tag
                  color={hasKeys ? 'cyan' : 'default'}
                  className={styles.keyCountTag}
                >
                  {providerKeys.length}
                </Tag>
              )}
            </Space>
          ),
          disabled: !hasKeys,
          provider,
          children: providerKeys.map((key) => ({
            value: key.id,
            label: (
              <Space size={6} className={styles.keyLabel}>
                <KeyOutlined style={{ color: token.colorPrimary, fontSize: 12 }} />
                <span className={styles.keyAlias}>
                  {key.alias || `Key ${key.priority + 1}`}
                </span>
                {key.priority === 0 && (
                  <ThunderboltOutlined
                    style={{ color: token.colorWarning, fontSize: 10 }}
                    title={t('apiKeys.primaryKey') || '主密钥'}
                  />
                )}
              </Space>
            ),
            apiKey: key,
          })),
        }
      })
  }, [providers, apiKeys, showKeyCount, showProviderIcon, token, t])

  // Display render for selected value
  const displayRender = (labels: React.ReactNode[]) => {
    if (labels.length === 2) {
      // Find the actual provider and key for display
      const providerId = value?.[0]
      const keyId = value?.[1]
      const provider = providers.find((p) => p.id === providerId)
      const key = apiKeys.find((k) => k.id === keyId)

      if (provider && key) {
        return (
          <Space size={4} className={styles.selectedDisplay}>
            <Text type="secondary" className={styles.selectedProvider}>
              {provider.name}
            </Text>
            <span className={styles.separator}>/</span>
            <Text className={styles.selectedKey}>
              {key.alias || `Key ${key.priority + 1}`}
            </Text>
          </Space>
        )
      }
    }
    return labels.join(' / ')
  }

  const handleChange = (selectedValue: (string | number)[]) => {
    if (!selectedValue || selectedValue.length === 0) {
      onChange?.(null)
      return
    }

    if (selectedValue.length === 2) {
      const [providerId, keyId] = selectedValue as [string, string]
      const provider = providers.find((p) => p.id === providerId)
      const apiKey = apiKeys.find((k) => k.id === keyId)
      onChange?.([providerId, keyId], provider, apiKey)
    }
  }

  return (
    <Cascader
      options={options}
      value={value || undefined}
      onChange={handleChange}
      displayRender={displayRender}
      placeholder={placeholder || t('keyCascader.placeholder') || '选择服务商 / 密钥'}
      size={size}
      allowClear={allowClear}
      disabled={disabled}
      expandTrigger={expandTrigger}
      className={`${styles.cascader} ${className || ''}`}
      style={style}
      popupClassName={styles.cascaderPopup}
      showSearch={{
        filter: (inputValue, path) => {
          return path.some((option) => {
            const opt = option as CascaderOption
            const provider = opt.provider
            const apiKey = opt.apiKey
            const searchText = inputValue.toLowerCase()

            if (provider) {
              return provider.name.toLowerCase().includes(searchText)
            }
            if (apiKey) {
              return (
                (apiKey.alias?.toLowerCase().includes(searchText)) ||
                apiKey.value.toLowerCase().includes(searchText)
              )
            }
            return false
          })
        },
      }}
      notFoundContent={
        <div className={styles.emptyState}>
          <KeyOutlined style={{ fontSize: 24, color: token.colorTextQuaternary }} />
          <Text type="secondary" className={styles.emptyText}>
            {t('keyCascader.noKeys') || '暂无可用密钥'}
          </Text>
        </div>
      }
    />
  )
}
