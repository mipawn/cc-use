import { Descriptions, Drawer, Space, Tag, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import type { RecentRequestLogDisplay } from '@shared/types'
import { formatExactTokenCount, formatTokenCount } from '../../utils/formatTokens'

const { Text } = Typography

/**
 * One request in full.
 *
 * The list shows seven columns; everything a user only needs once something
 * looks wrong is here: the complete model id, the token breakdown and the full
 * error text. The proxy's route token is not a request identifier and is not
 * shown; no API key material appears either.
 */
export default function RecentRequestDetailDrawer({
  record,
  onClose,
}: {
  record: RecentRequestLogDisplay | null
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.resolvedLanguage || i18n.language

  const tokens = record
    ? record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheCreationTokens
    : 0

  return (
    <Drawer
      title={t('statistics.detailTitle') || '请求详情'}
      open={record !== null}
      onClose={onClose}
      size='large'
      destroyOnHidden
    >
      {record && (
        <Space direction='vertical' size={12} style={{ width: '100%' }}>
          {/* What happened, first. */}
          <Space wrap>
            <Tag color={record.outcome === 'success' ? 'green' : 'red'}>
              {record.statusCode ?? record.outcome ?? '-'}
            </Tag>
            <Text strong>{record.model || '—'}</Text>
            {record.requestKind === 'auto_mode' && <Tag color='gold'>Auto mode</Tag>}
            <Text type='secondary'>{record.latencyMs != null ? `${record.latencyMs}ms` : '—'}</Text>
          </Space>

          <Descriptions column={1} size='small' bordered>
            <Descriptions.Item label={t('statistics.time')}>
              {new Date(record.createdAt).toLocaleString()}
            </Descriptions.Item>
            <Descriptions.Item label={t('statistics.route')}>
              {[record.providerName || '-', record.keyAlias || '-'].join(' / ')}
            </Descriptions.Item>
            <Descriptions.Item label={t('statistics.project')}>
              {record.projectName || t('statistics.other')}
            </Descriptions.Item>
            <Descriptions.Item label={t('statistics.tokens')}>
              <Space direction='vertical' size={0}>
                <Text>
                  {formatTokenCount(tokens, language)}
                  <Text type='secondary' style={{ marginLeft: 8, fontSize: 12 }}>
                    {formatExactTokenCount(tokens, language)}
                  </Text>
                </Text>
                <Text type='secondary' style={{ fontSize: 12 }}>
                  {t('statistics.inputTokens')} {record.inputTokens} ·{' '}
                  {t('statistics.outputTokens')} {record.outputTokens} ·{' '}
                  {t('statistics.cacheReadTokens')} {record.cacheReadTokens} ·{' '}
                  {t('statistics.cacheCreationTokens')} {record.cacheCreationTokens}
                </Text>
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label={t('statistics.status')}>
              {record.outcome ?? '-'}
            </Descriptions.Item>
          </Descriptions>

          {record.errorMessage && (
            <div>
              <Text type='secondary'>{t('statistics.errorDetail') || '错误信息'}</Text>
              {/* Rendered as plain text: an upstream message is not markup. */}
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12 }}>
                {record.errorMessage}
              </pre>
            </div>
          )}
        </Space>
      )}
    </Drawer>
  )
}
