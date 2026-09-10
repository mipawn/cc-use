import { useEffect, useState } from 'react'
import { Drawer, Empty, Select, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import type { AutoModeAudit, StatsTimeRange } from '@shared/types'
import { getApi } from '../../api'
import { useAppMessage } from '../../hooks/useAppMessage'

const { Text } = Typography

/**
 * What Auto mode asked the safety classifier to review, and what came back.
 *
 * Every column is one observable fact. The transport succeeding, the model
 * returning a verdict and the client running the tool are shown separately:
 * collapsing them into one "allowed" would claim more than the proxy can see.
 */
export default function AutoModeAuditDrawer({
  open,
  timeRange,
  onClose,
}: {
  open: boolean
  timeRange: StatsTimeRange
  onClose: () => void
}) {
  const { t } = useTranslation()
  const message = useAppMessage()
  const [audits, setAudits] = useState<AutoModeAudit[]>([])
  const [tools, setTools] = useState<string[]>([])
  const [tool, setTool] = useState<string | undefined>(undefined)
  const [verdict, setVerdict] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    Promise.all([
      getApi().autoModeAudit.list({ timeRange, tool, verdict, limit: 200 }),
      getApi().autoModeAudit.tools(timeRange),
    ])
      .then(([rows, availableTools]) => {
        if (cancelled) return
        setAudits(rows)
        setTools(availableTools)
      })
      .catch((error) => {
        if (cancelled) return
        console.error('Failed to load Auto mode audits:', error)
        message.error(t('statistics.autoAuditLoadFailed') || '加载 Auto 记录失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // Only the query parameters are dependencies: `message` and `t` change
    // identity between renders and would re-trigger this effect forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, timeRange, tool, verdict])

  const verdictTag = (row: AutoModeAudit) => {
    if (!row.parseOk || !row.verdict || row.verdict === 'unknown') {
      // Nothing parseable is not the same as "allowed".
      return <Tag color='default'>{t('statistics.verdictUnknown') || '未知'}</Tag>
    }
    return row.verdict === 'block' ? (
      <Tag color='red'>{t('statistics.verdictBlock') || '拦截'}</Tag>
    ) : (
      <Tag color='gold'>{t('statistics.verdictNoBlock') || '未拦截'}</Tag>
    )
  }

  const stateTag = (row: AutoModeAudit) => {
    const label = t(`statistics.requestStates.${row.requestState}`)
    const text = label.startsWith('statistics.') ? row.requestState : label
    const color =
      row.requestState === 'completed'
        ? 'blue'
        : row.requestState === 'pending'
          ? 'default'
          : 'orange'
    return <Tag color={color}>{text}</Tag>
  }

  return (
    <Drawer
      title={t('statistics.autoAuditTitle') || 'Auto 记录'}
      open={open}
      onClose={onClose}
      size='large'
      destroyOnHidden
    >
      <Space style={{ marginBottom: 12 }} wrap>
        <Select
          allowClear
          placeholder={t('statistics.autoAuditTool') || '工具'}
          style={{ minWidth: 160 }}
          value={tool}
          onChange={setTool}
          options={tools.map((name) => ({ value: name, label: name }))}
        />
        <Select
          allowClear
          placeholder={t('statistics.autoAuditVerdict') || '模型返回'}
          style={{ minWidth: 160 }}
          value={verdict}
          onChange={setVerdict}
          options={[
            { value: 'no_block', label: t('statistics.verdictNoBlock') || '未拦截' },
            { value: 'block', label: t('statistics.verdictBlock') || '拦截' },
            { value: 'unknown', label: t('statistics.verdictUnknown') || '未知' },
          ]}
        />
        <Text type='secondary' style={{ fontSize: 12 }}>
          {t('statistics.autoAuditHint') ||
            '记录分类器审核了什么；工具是否真正执行只有客户端回执才能确认'}
        </Text>
      </Space>

      <Table<AutoModeAudit>
        rowKey='requestId'
        size='small'
        loading={loading}
        dataSource={audits}
        pagination={{ pageSize: 20, size: 'small' }}
        locale={{ emptyText: <Empty description={t('statistics.autoAuditEmpty') || '暂无记录'} /> }}
        columns={[
          {
            title: t('statistics.time') || '时间',
            dataIndex: 'createdAt',
            width: 160,
            render: (value: string) => new Date(value).toLocaleString(),
          },
          {
            title: t('statistics.autoAuditAction') || '待审核动作',
            dataIndex: 'actionSummary',
            render: (value: string | null, row) =>
              value ? (
                <Tooltip title={row.toolUseId ?? undefined}>
                  <Text style={{ fontSize: 12 }} ellipsis>
                    {value}
                    {row.actionTruncated ? ' …' : ''}
                  </Text>
                </Tooltip>
              ) : (
                <Text type='secondary'>{t('statistics.autoAuditUnknownAction') || '未识别'}</Text>
              ),
          },
          {
            title: t('statistics.autoAuditModel') || '模型',
            dataIndex: 'forwardedModel',
            width: 170,
            render: (value: string | null, row) => (
              <Tooltip
                title={
                  row.requestModel && row.requestModel !== value
                    ? `${t('statistics.autoAuditOriginalModel') || '原始'}：${row.requestModel}`
                    : undefined
                }
              >
                <Text style={{ fontSize: 12 }}>{value ?? '—'}</Text>
              </Tooltip>
            ),
          },
          {
            title: t('statistics.autoAuditThinking') || '思考',
            dataIndex: 'thinking',
            width: 90,
            render: (value: string | null) => (
              <Text type='secondary' style={{ fontSize: 12 }}>
                {value ?? '—'}
              </Text>
            ),
          },
          {
            title: t('statistics.autoAuditVerdict') || '模型返回',
            width: 100,
            render: (_, row) => verdictTag(row),
          },
          {
            title: t('statistics.autoAuditState') || '请求状态',
            width: 110,
            render: (_, row) => stateTag(row),
          },
          {
            title: t('statistics.autoAuditClient') || '客户端执行',
            width: 110,
            render: (_, row) =>
              // Only ever filled from a reliable client receipt.
              row.clientOutcome ? (
                <Text style={{ fontSize: 12 }}>{row.clientOutcome}</Text>
              ) : (
                <Text type='secondary' style={{ fontSize: 12 }}>
                  {t('statistics.autoAuditNotObserved') || '未观测'}
                </Text>
              ),
          },
        ]}
        expandable={{
          expandedRowRender: (row) => (
            <Space direction='vertical' size={2} style={{ fontSize: 12 }}>
              <Text type='secondary'>
                {t('statistics.autoAuditRequestId') || '请求 ID'}：{row.requestId}
              </Text>
              {row.verdictReason && <Text>{row.verdictReason}</Text>}
              {row.stopReason && (
                <Text type='secondary'>
                  {t('statistics.autoAuditStop') || '结束原因'}：{row.stopReason}
                </Text>
              )}
              {row.errorMessage && <Text type='danger'>{row.errorMessage}</Text>}
              {row.sessionRef && (
                <Text type='secondary'>
                  {t('statistics.autoAuditSession') || '会话'}：{row.sessionRef}（
                  {row.sessionSource}）
                </Text>
              )}
            </Space>
          ),
        }}
      />
    </Drawer>
  )
}
