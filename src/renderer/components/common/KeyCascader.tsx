/**
 * KeyCascader - 树选择器组件
 * Provider → Key 两级结构，默认展开所有节点
 */
import { useMemo } from 'react'
import { TreeSelect, Space, Tag, Typography, theme } from 'antd'
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
}

interface TreeDataNode {
  title: React.ReactNode
  label?: React.ReactNode
  value: string
  selectable?: boolean
  searchText?: string
  children?: TreeDataNode[]
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
}: KeyCascaderProps) {
  const { t } = useTranslation()
  const { token } = theme.useToken()

  const treeData = useMemo<TreeDataNode[]>(() => {
    return providers
      .filter((p) => p.isActive)
      .map((provider) => {
        const providerKeys = apiKeys.filter(
          (k) => k.providerId === provider.id && k.isActive && !k.isExhausted,
        )
        const hasKeys = providerKeys.length > 0

        return {
          title: (
            <Space size={8} className={styles.providerLabel}>
              {showProviderIcon && (
                <CloudServerOutlined style={{ color: token.colorTextSecondary }} />
              )}
              <span className={styles.providerName}>{provider.name}</span>
              {showKeyCount && (
                <Tag color={hasKeys ? 'cyan' : 'default'} className={styles.keyCountTag}>
                  {providerKeys.length}
                </Tag>
              )}
            </Space>
          ),
          value: `provider-${provider.id}`,
          selectable: false,
          searchText: provider.name,
          children: providerKeys.map((key) => ({
            title: (
              <Space size={6} className={styles.keyLabel}>
                <KeyOutlined style={{ color: token.colorPrimary, fontSize: 12 }} />
                <span className={styles.keyAlias}>{key.alias || `Key ${key.priority + 1}`}</span>
                {key.priority === 0 && (
                  <ThunderboltOutlined
                    style={{ color: token.colorWarning, fontSize: 10 }}
                    title={t('apiKeys.primaryKey') || '主密钥'}
                  />
                )}
              </Space>
            ),
            label: (
              <Space size={4} className={styles.selectedDisplay}>
                <Text type='secondary' className={styles.selectedProvider}>
                  {provider.name}
                </Text>
                <span className={styles.separator}>/</span>
                <Text className={styles.selectedKey}>
                  {key.alias || `Key ${key.priority + 1}`}
                </Text>
              </Space>
            ),
            value: key.id,
            searchText: `${provider.name} ${key.alias || ''} ${key.value}`,
          })),
        }
      })
  }, [providers, apiKeys, showKeyCount, showProviderIcon, token, t])

  const treeSelectValue = useMemo(() => {
    if (!value) return undefined
    return value[1]
  }, [value])

  const handleChange = (keyId: string | undefined) => {
    if (!keyId) {
      onChange?.(null)
      return
    }
    const apiKey = apiKeys.find((k) => k.id === keyId)
    if (apiKey) {
      const provider = providers.find((p) => p.id === apiKey.providerId)
      onChange?.([apiKey.providerId, keyId], provider, apiKey)
    }
  }

  return (
    <TreeSelect
      treeData={treeData}
      value={treeSelectValue}
      onChange={handleChange}
      treeNodeLabelProp='label'
      placeholder={placeholder || t('keyCascader.placeholder') || '选择供应商 / 密钥'}
      size={size}
      allowClear={allowClear}
      disabled={disabled}
      treeDefaultExpandAll
      showSearch
      listHeight={400}
      dropdownStyle={{ maxHeight: 500 }}
      filterTreeNode={(input, node) => {
        const searchText = (node as TreeDataNode).searchText || ''
        return searchText.toLowerCase().includes(input.toLowerCase())
      }}
      className={`${styles.treeSelect} ${className || ''}`}
      style={style}
      popupClassName={styles.treeSelectPopup}
      notFoundContent={
        <div className={styles.emptyState}>
          <KeyOutlined style={{ fontSize: 24, color: token.colorTextQuaternary }} />
          <Text type='secondary' className={styles.emptyText}>
            {t('keyCascader.noKeys') || '暂无可用密钥'}
          </Text>
        </div>
      }
    />
  )
}
