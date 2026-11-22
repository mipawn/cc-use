import { useMemo, useState } from 'react'
import { Button, Popconfirm, Select, Space, Tag, Tooltip } from 'antd'
import {
  CheckCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  StarFilled,
  StarOutlined,
  SwapOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import type { ApiKey, ClientProfile, Provider } from '@shared/types'
import ProviderIcon from '../providers/ProviderIcon'
import { formatAccountAmount } from '../../utils/accountQuery'
import { CLIENT_ROLES, parseModelMapping } from '../../utils/modelMapping'
import styles from './ClientProfileCard.module.css'

interface ClientProfileCardProps {
  profile: ClientProfile
  provider: Provider | undefined
  apiKey: ApiKey | undefined
  providerKeys: ApiKey[]
  catalogCount: number
  /** For Desktop clients: whether this profile is the currently applied desktop route. */
  isAppliedDesktop?: boolean
  applying?: boolean
  onApplyDesktop?: (profile: ClientProfile) => void
  onEdit: (profile: ClientProfile) => void
  onDuplicate: (profile: ClientProfile) => void
  onDelete: (profile: ClientProfile) => void
  onSetDefault?: (profile: ClientProfile) => void
  onSwapKey: (profile: ClientProfile, nextApiKeyId: string) => Promise<void>
}

export default function ClientProfileCard({
  profile,
  provider,
  apiKey,
  providerKeys,
  catalogCount,
  isAppliedDesktop = false,
  applying = false,
  onApplyDesktop,
  onEdit,
  onDuplicate,
  onDelete,
  onSetDefault,
  onSwapKey,
}: ClientProfileCardProps) {
  const { t } = useTranslation()
  const [swapping, setSwapping] = useState(false)

  const parsed = useMemo(() => parseModelMapping(profile.modelConfig), [profile.modelConfig])
  const clientModelCfg = parsed.clients[profile.clientKind]

  const providerDisabled = provider ? !provider.isActive : true
  const keyUnavailable = !apiKey || !apiKey.isActive || apiKey.isExhausted

  const availableSiblingKeys = useMemo(
    () =>
      providerKeys.filter(
        (item) => item.id === profile.apiKeyId || (item.isActive && !item.isExhausted),
      ),
    [providerKeys, profile.apiKeyId],
  )

  const handleKeyChange = async (nextKeyId: string) => {
    if (nextKeyId === profile.apiKeyId) return
    setSwapping(true)
    try {
      await onSwapKey(profile, nextKeyId)
    } finally {
      setSwapping(false)
    }
  }

  const quotaLabel = useMemo(() => {
    if (apiKey?.cachedUsage) {
      const rem = formatAccountAmount(apiKey.cachedUsage.remaining, apiKey.cachedUsage.unit)
      if (rem) return rem
    }
    if (provider && provider.cachedWalletBalance !== null && provider.cachedWalletBalance !== undefined) {
      return formatAccountAmount(
        provider.cachedWalletBalance,
        provider.cachedWalletBalanceCurrency ?? undefined,
      )
    }
    return null
  }, [apiKey, provider])

  const envCount = profile.launchEnv ? Object.keys(profile.launchEnv).length : 0
  const claudePrimaryModel =
    typeof profile.launchEnv?.ANTHROPIC_MODEL === 'string'
      ? profile.launchEnv.ANTHROPIC_MODEL
      : undefined

  const mappedRoleCount =
    profile.clientKind === 'claude_desktop'
      ? CLIENT_ROLES.filter((role) => Boolean(clientModelCfg.roles[role]?.trim())).length
      : 0

  const hasConnectionOverride = Boolean(
    profile.connectionConfig &&
      (profile.connectionConfig.baseUrl ||
        profile.connectionConfig.userAgent ||
        (profile.connectionConfig.authScheme && profile.connectionConfig.authScheme !== 'bearer')),
  )

  return (
    <article
      className={`${styles.card} ${isAppliedDesktop ? styles.cardActiveDesktop : ''}`}
      data-profile-id={profile.id}
    >
      <div className={styles.header}>
        <div className={styles.titleArea}>
          <h3 className={styles.title}>{profile.name}</h3>
          {isAppliedDesktop && (
            <Tag color='green' icon={<CheckCircleOutlined />}>
              {t('profiles.activeDesktopBadge')}
            </Tag>
          )}
          {profile.isDefault &&
            (profile.clientKind === 'claude_code' || profile.clientKind === 'grok') && (
              <Tooltip title={t('profiles.cliDefaultTooltip')}>
                <Tag color='blue' icon={<StarFilled />}>
                  {t('profiles.cliDefaultBadge')}
                </Tag>
              </Tooltip>
            )}
          {providerDisabled && (
            <Tag color='red' icon={<WarningOutlined />}>
              {t('profiles.statusProviderOff')}
            </Tag>
          )}
          {!providerDisabled && keyUnavailable && (
            <Tag color='orange' icon={<WarningOutlined />}>
              {t('profiles.statusKeyUnavailable')}
            </Tag>
          )}
        </div>
        {onApplyDesktop && (
          <Button
            type={isAppliedDesktop ? 'default' : 'primary'}
            size='small'
            loading={applying}
            disabled={providerDisabled || keyUnavailable}
            onClick={() => onApplyDesktop(profile)}
          >
            {isAppliedDesktop ? t('profiles.applied') : t('profiles.apply')}
          </Button>
        )}
      </div>

      {/* Upstream Binding + 1-Click Key Rotation */}
      <div className={styles.bindingBox}>
        <div className={styles.bindingLeft}>
          {provider && <ProviderIcon icon={provider.icon} name={provider.name} size={22} />}
          <span className={styles.providerName} title={provider?.name}>
            {provider?.name ?? t('desktopAccess.resourceUnavailable')}
          </span>
          {quotaLabel && (
            <Tag style={{ marginInlineEnd: 0, fontSize: 11 }}>{quotaLabel}</Tag>
          )}
        </div>

        <Tooltip title={t('profiles.quickSwapKey')}>
          <Select
            size='small'
            className={styles.keySwapSelect}
            value={profile.apiKeyId}
            loading={swapping}
            disabled={swapping || availableSiblingKeys.length === 0}
            aria-label={t('profiles.quickSwapKey')}
            suffixIcon={<SwapOutlined />}
            options={availableSiblingKeys.map((item) => {
              const rem = item.cachedUsage
                ? formatAccountAmount(item.cachedUsage.remaining, item.cachedUsage.unit)
                : null
              const baseLabel = item.alias || t('instances.unnamedKey')
              return {
                value: item.id,
                label: rem ? `${baseLabel} (${rem})` : baseLabel,
              }
            })}
            onChange={(nextKeyId) => void handleKeyChange(nextKeyId)}
          />
        </Tooltip>
      </div>

      {/* Concise Summary Chips */}
      <div className={styles.summaryRow}>
        {profile.clientKind !== 'grok' && (
          <Tag>
            {clientModelCfg.catalogMode === 'custom'
              ? t('profiles.summaryModelsSelected', { count: clientModelCfg.models.length })
              : t('profiles.summaryModelsAll', { count: catalogCount })}
          </Tag>
        )}

        {profile.clientKind === 'claude_code' && claudePrimaryModel && (
          <Tag color='geekblue'>
            {t('profiles.summaryDefaultModel', { model: claudePrimaryModel })}
          </Tag>
        )}
        {profile.clientKind === 'claude_code' && envCount > 0 && (
          <Tag>{t('profiles.summaryEnvCount', { count: envCount })}</Tag>
        )}

        {profile.clientKind === 'codex' && clientModelCfg.defaultModel && (
          <Tag color='geekblue'>
            {t('profiles.summaryDefaultModel', { model: clientModelCfg.defaultModel })}
          </Tag>
        )}

        {profile.clientKind === 'grok' && clientModelCfg.defaultModel && (
          <Tag color='geekblue'>
            {t('profiles.summaryDefaultModel', { model: clientModelCfg.defaultModel })}
          </Tag>
        )}

        {profile.clientKind === 'claude_desktop' &&
          mappedRoleCount > 0 &&
          CLIENT_ROLES.filter((role) => Boolean(clientModelCfg.roles[role]?.trim())).map((role) => {
            const label = `${role} → ${clientModelCfg.roles[role]}`
            return (
              <Tooltip key={role} title={label}>
                <Tag color='geekblue'>{label}</Tag>
              </Tooltip>
            )
          })}

        {clientModelCfg.forwardMode === 'fixed' && clientModelCfg.upstreamModel ? (
          <Tag color='purple'>
            {t('profiles.summaryRewriteFixed', { model: clientModelCfg.upstreamModel })}
          </Tag>
        ) : clientModelCfg.forwardMode === 'family' ? (
          <Tag color='purple'>{t('profiles.summaryRewriteFamily')}</Tag>
        ) : (
          <Tag>{t('profiles.summaryPassthrough')}</Tag>
        )}

        {profile.clientKind === 'claude_code' && parsed.autoMode.enabled && (
          <Tag color='cyan'>
            {t('profiles.autoModeSummaryOn', { model: parsed.autoMode.model || 'auto' })}
          </Tag>
        )}

        {hasConnectionOverride && (
          <Tag color='gold'>{t('profiles.connectionOverridden')}</Tag>
        )}
      </div>

      <div className={styles.footer}>
        <Space size={4}>
          <Button size='small' icon={<EditOutlined />} onClick={() => onEdit(profile)}>
            {t('common.edit')}
          </Button>
          <Button
            size='small'
            type='text'
            icon={<CopyOutlined />}
            onClick={() => onDuplicate(profile)}
          >
            {t('profiles.duplicate')}
          </Button>
          {onSetDefault &&
            !profile.isDefault &&
            (profile.clientKind === 'claude_code' || profile.clientKind === 'grok') && (
              <Tooltip title={t('profiles.cliDefaultTooltip')}>
                <Button
                  size='small'
                  type='text'
                  icon={<StarOutlined />}
                  onClick={() => onSetDefault(profile)}
                >
                  {t('profiles.cliDefaultLabel')}
                </Button>
              </Tooltip>
            )}
        </Space>

        <Popconfirm
          title={t('profiles.deleteConfirm', { name: profile.name })}
          onConfirm={() => onDelete(profile)}
          okText={t('common.delete')}
          cancelText={t('common.cancel')}
          okButtonProps={{ danger: true }}
        >
          <Button
            size='small'
            type='text'
            danger
            icon={<DeleteOutlined />}
            aria-label={t('common.delete')}
          />
        </Popconfirm>
      </div>
    </article>
  )
}
