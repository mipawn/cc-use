import { useState, useEffect, useMemo } from 'react'
import { Card, Table, Button, Space, Tag, Modal, Input, Select, Popconfirm, Tooltip, Alert } from 'antd'
import { DeleteOutlined, CopyOutlined, ReloadOutlined, InfoCircleOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAppMessage } from '../hooks/useAppMessage'
import { getApi } from '../api'
import type { ClaudeSession } from '../api/types'

const { Search } = Input

function buildSessionShortCode(sessionId: string) {
  return sessionId.slice(-8)
}

export default function Sessions() {
  const { t } = useTranslation()
  const message = useAppMessage()
  const [sessions, setSessions] = useState<ClaudeSession[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([])
  const [searchText, setSearchText] = useState('')
  const [sizeFilter, setSizeFilter] = useState<string>('all')
  const [timeFilter, setTimeFilter] = useState<string>('all')
  const [showInfo, setShowInfo] = useState(false)

  const loadSessions = async () => {
    setLoading(true)
    try {
      const data = await getApi().sessions.scanSessions()
      setSessions(data)
    } catch (error) {
      message.error(t('sessions.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadSessions()
  }, [])

  const filteredSessions = useMemo(() => {
    let filtered = sessions

    if (searchText) {
      const keyword = searchText.toLowerCase()
      filtered = filtered.filter(s =>
        s.projectPath.toLowerCase().includes(keyword) ||
        s.sessionId.toLowerCase().includes(keyword) ||
        (s.firstMessage || '').toLowerCase().includes(keyword)
      )
    }

    if (sizeFilter !== 'all') {
      const size = parseInt(sizeFilter)
      filtered = filtered.filter(s => s.totalSize > size * 1024 * 1024)
    }

    if (timeFilter !== 'all') {
      const days = parseInt(timeFilter)
      const cutoff = Date.now() / 1000 - days * 86400
      filtered = filtered.filter(s => s.lastModified < cutoff)
    }

    return filtered
  }, [sessions, searchText, sizeFilter, timeFilter])

  const handleDelete = async (sessionIds: string[]) => {
    try {
      await getApi().sessions.deleteSessions(sessionIds)
      message.success(t('sessions.deleteSuccess', { count: sessionIds.length }))
      setSelectedRowKeys([])
      loadSessions()
    } catch (error) {
      message.error(t('sessions.deleteFailed'))
    }
  }

  const handleBatchDelete = () => {
    if (selectedRowKeys.length === 0) return
    Modal.confirm({
      title: t('sessions.confirmDelete'),
      content: t('sessions.confirmDeleteContent', { count: selectedRowKeys.length }),
      onOk: () => handleDelete(selectedRowKeys),
    })
  }

  const handleCleanOld = (days: number) => {
    Modal.confirm({
      title: t('sessions.confirmClean'),
      content: t('sessions.confirmCleanDays', { days }),
      onOk: async () => {
        try {
          const count = await getApi().sessions.cleanOldSessions(days)
          message.success(t('sessions.cleanSuccess', { count }))
          loadSessions()
        } catch (error) {
          message.error(t('sessions.cleanFailed'))
        }
      },
    })
  }

  const handleKeepRecent = (count: number) => {
    Modal.confirm({
      title: t('sessions.confirmClean'),
      content: t('sessions.confirmKeepRecent', { count }),
      onOk: async () => {
        try {
          const deleted = await getApi().sessions.keepRecentSessions(count)
          message.success(t('sessions.cleanSuccess', { count: deleted }))
          loadSessions()
        } catch (error) {
          message.error(t('sessions.cleanFailed'))
        }
      },
    })
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    message.success(t('sessions.copied'))
  }

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '-'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  const formatTime = (timestamp: number) => {
    if (timestamp === 0) return '-'
    return new Date(timestamp * 1000).toLocaleString()
  }

  const getProjectName = (path: string) => {
    const normalized = path.endsWith('/') ? path.slice(0, -1) : path
    const parts = normalized.split('/').filter(Boolean)
    return parts[parts.length - 1] || path
  }

  // Group stats
  const projectGroups = useMemo(() => {
    const map = new Map<string, { count: number; size: number }>()
    for (const s of sessions) {
      const existing = map.get(s.projectPath) || { count: 0, size: 0 }
      map.set(s.projectPath, {
        count: existing.count + 1,
        size: existing.size + s.totalSize,
      })
    }
    return map
  }, [sessions])

  const columns = [
    {
      title: t('sessions.columnProject'),
      dataIndex: 'projectPath',
      key: 'projectPath',
      width: 180,
      ellipsis: true,
      filters: Array.from(projectGroups.entries()).map(([path, stats]) => ({
        text: `${getProjectName(path)} (${stats.count})`,
        value: path,
      })),
      onFilter: (value: any, record: ClaudeSession) => record.projectPath === value,
      render: (path: string, record: ClaudeSession) => (
        <Tooltip title={path}>
          <span
            style={{ cursor: 'pointer' }}
            onClick={() => copyToClipboard(path)}
          >
            {getProjectName(path)}
            {' '}<CopyOutlined style={{ fontSize: 11, color: '#999' }} />
          </span>
          <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
            {buildSessionShortCode(record.sessionId)}
          </div>
        </Tooltip>
      ),
    },
    {
      title: t('sessions.columnFirstMessage'),
      dataIndex: 'firstMessage',
      key: 'firstMessage',
      ellipsis: true,
      render: (text: string | undefined) => (
        <span style={{ color: text ? undefined : '#ccc', fontSize: 13 }}>
          {text || t('sessions.noMessage')}
        </span>
      ),
    },
    {
      title: t('sessions.columnSize'),
      dataIndex: 'totalSize',
      key: 'totalSize',
      width: 100,
      sorter: (a: ClaudeSession, b: ClaudeSession) => a.totalSize - b.totalSize,
      render: (size: number, record: ClaudeSession) => {
        const parts: string[] = []
        if (record.jsonlSize > 0) parts.push(`JSONL: ${formatSize(record.jsonlSize)}`)
        if (record.dirSize > 0) parts.push(`${t('sessions.attachment')}: ${formatSize(record.dirSize)}`)
        return (
          <Tooltip title={parts.join('\n')}>
            <Tag color={size > 1024 * 1024 ? 'red' : size > 100 * 1024 ? 'orange' : 'default'}>
              {formatSize(size)}
            </Tag>
          </Tooltip>
        )
      },
    },
    {
      title: t('sessions.columnMessages'),
      dataIndex: 'messageCount',
      key: 'messageCount',
      width: 70,
      sorter: (a: ClaudeSession, b: ClaudeSession) => a.messageCount - b.messageCount,
      render: (count: number) => count > 0 ? count : <span style={{ color: '#ccc' }}>-</span>,
    },
    {
      title: t('sessions.columnLastModified'),
      dataIndex: 'lastModified',
      key: 'lastModified',
      width: 160,
      sorter: (a: ClaudeSession, b: ClaudeSession) => a.lastModified - b.lastModified,
      defaultSortOrder: 'descend' as const,
      render: (time: number) => <span style={{ fontSize: 13 }}>{formatTime(time)}</span>,
    },
    {
      title: t('sessions.columnAction'),
      key: 'action',
      width: 60,
      render: (_: any, record: ClaudeSession) => (
        <Popconfirm
          title={t('sessions.confirmDeleteSingle')}
          description={t('sessions.confirmDeleteSingleDesc')}
          onConfirm={() => handleDelete([record.sessionId])}
        >
          <Button type="link" size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ]

  const totalSize = filteredSessions.reduce((sum, s) => sum + s.totalSize, 0)

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', padding: 24 }}>
      {showInfo && (
        <Alert
          type="info"
          showIcon
          closable
          onClose={() => setShowInfo(false)}
          style={{ marginBottom: 16 }}
          message={t('sessions.infoTitle')}
          description={
            <div style={{ fontSize: 13, lineHeight: 1.8 }}>
              <p style={{ margin: '4px 0' }}>
                <strong>{t('sessions.infoScopeLabel')}</strong>{t('sessions.infoScope')}
              </p>
              <p style={{ margin: '4px 0' }}>
                <strong>{t('sessions.infoNoPreviewLabel')}</strong>{t('sessions.infoNoPreview')}
              </p>
              <p style={{ margin: '4px 0' }}>
                <strong>{t('sessions.infoNoCodexLabel')}</strong>{t('sessions.infoNoCodex')}
              </p>
              <p style={{ margin: '4px 0' }}>
                <strong>{t('sessions.infoNoHistoryLabel')}</strong>{t('sessions.infoNoHistory')}
              </p>
            </div>
          }
        />
      )}

      <Card
        title={
          <Space>
            {t('sessions.title')}
            <Tag color="blue">{t('sessions.sessionCount', { count: filteredSessions.length })}</Tag>
            <Tag color="orange">{formatSize(totalSize)}</Tag>
            <Button
              type="text"
              size="small"
              icon={<InfoCircleOutlined />}
              onClick={() => setShowInfo(!showInfo)}
            />
          </Space>
        }
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={loadSessions} loading={loading}>{t('sessions.refresh')}</Button>
            <Button onClick={() => handleKeepRecent(10)}>{t('sessions.keepPerProject', { count: 10 })}</Button>
            <Button onClick={() => handleCleanOld(30)}>{t('sessions.cleanOlderThan', { days: 30 })}</Button>
            <Button onClick={() => handleCleanOld(60)}>{t('sessions.cleanOlderThan', { days: 60 })}</Button>
          </Space>
        }
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' } }}
      >
        <Space style={{ marginBottom: 16 }} wrap>
          <Search
            placeholder={t('sessions.searchPlaceholder')}
            style={{ width: 280 }}
            onChange={e => setSearchText(e.target.value)}
            allowClear
          />
          <Select
            style={{ width: 120 }}
            value={sizeFilter}
            onChange={setSizeFilter}
            options={[
              { label: t('sessions.allSizes'), value: 'all' },
              { label: '> 100 KB', value: '0.1' },
              { label: '> 1 MB', value: '1' },
              { label: '> 5 MB', value: '5' },
            ]}
          />
          <Select
            style={{ width: 120 }}
            value={timeFilter}
            onChange={setTimeFilter}
            options={[
              { label: t('sessions.allTimes'), value: 'all' },
              { label: t('sessions.daysAgo', { days: 7 }), value: '7' },
              { label: t('sessions.daysAgo', { days: 30 }), value: '30' },
              { label: t('sessions.daysAgo', { days: 60 }), value: '60' },
            ]}
          />
          {selectedRowKeys.length > 0 && (
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={handleBatchDelete}
            >
              {t('sessions.deleteSelected', { count: selectedRowKeys.length })}
            </Button>
          )}
        </Space>

        <Table
          rowKey="sessionId"
          columns={columns}
          dataSource={filteredSessions}
          loading={loading}
          size="small"
          rowSelection={{
            selectedRowKeys,
            onChange: (keys) => setSelectedRowKeys(keys as string[]),
          }}
          scroll={{ y: 'calc(100vh - 320px)' }}
          pagination={{
            pageSize: 50,
            showSizeChanger: true,
            showTotal: (total) => t('sessions.total', { total }),
          }}
        />
      </Card>
    </div>
  )
}
