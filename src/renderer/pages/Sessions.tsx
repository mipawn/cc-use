import { useState, useEffect, useMemo } from 'react'
import { Card, Table, Button, Space, Tag, Modal, Input, Select, message, Popconfirm, Tooltip, Alert } from 'antd'
import { DeleteOutlined, CopyOutlined, ReloadOutlined, InfoCircleOutlined } from '@ant-design/icons'
import { getApi } from '../api'
import type { ClaudeSession } from '../api/types'

const { Search } = Input

export default function Sessions() {
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
      message.error('加载会话失败')
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
      message.success(`已删除 ${sessionIds.length} 个会话`)
      setSelectedRowKeys([])
      loadSessions()
    } catch (error) {
      message.error('删除失败')
    }
  }

  const handleBatchDelete = () => {
    if (selectedRowKeys.length === 0) return
    Modal.confirm({
      title: '确认删除',
      content: `确定要删除选中的 ${selectedRowKeys.length} 个会话吗？此操作将删除对应的 JSONL 文件和附件目录。`,
      onOk: () => handleDelete(selectedRowKeys),
    })
  }

  const handleCleanOld = (days: number) => {
    Modal.confirm({
      title: '确认清理',
      content: `确定要删除 ${days} 天前的所有会话吗？`,
      onOk: async () => {
        try {
          const count = await getApi().sessions.cleanOldSessions(days)
          message.success(`已清理 ${count} 个会话`)
          loadSessions()
        } catch (error) {
          message.error('清理失败')
        }
      },
    })
  }

  const handleKeepRecent = (count: number) => {
    Modal.confirm({
      title: '确认清理',
      content: `每个项目只保留最近 ${count} 个会话，删除其余的？`,
      onOk: async () => {
        try {
          const deleted = await getApi().sessions.keepRecentSessions(count)
          message.success(`已清理 ${deleted} 个会话`)
          loadSessions()
        } catch (error) {
          message.error('清理失败')
        }
      },
    })
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    message.success('已复制')
  }

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '-'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  const formatTime = (timestamp: number) => {
    if (timestamp === 0) return '-'
    return new Date(timestamp * 1000).toLocaleString('zh-CN')
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
      title: '项目',
      dataIndex: 'projectPath',
      key: 'projectPath',
      width: 180,
      ellipsis: true,
      filters: Array.from(projectGroups.entries()).map(([path, stats]) => ({
        text: `${getProjectName(path)} (${stats.count})`,
        value: path,
      })),
      onFilter: (value: any, record: ClaudeSession) => record.projectPath === value,
      render: (path: string) => (
        <Tooltip title={path}>
          <span
            style={{ cursor: 'pointer' }}
            onClick={() => copyToClipboard(path)}
          >
            {getProjectName(path)}
            {' '}<CopyOutlined style={{ fontSize: 11, color: '#999' }} />
          </span>
        </Tooltip>
      ),
    },
    {
      title: '首条消息',
      dataIndex: 'firstMessage',
      key: 'firstMessage',
      ellipsis: true,
      render: (text: string | undefined) => (
        <span style={{ color: text ? undefined : '#ccc', fontSize: 13 }}>
          {text || '(无)'}
        </span>
      ),
    },
    {
      title: '大小',
      dataIndex: 'totalSize',
      key: 'totalSize',
      width: 100,
      sorter: (a: ClaudeSession, b: ClaudeSession) => a.totalSize - b.totalSize,
      render: (size: number, record: ClaudeSession) => {
        const parts: string[] = []
        if (record.jsonlSize > 0) parts.push(`JSONL: ${formatSize(record.jsonlSize)}`)
        if (record.dirSize > 0) parts.push(`附件: ${formatSize(record.dirSize)}`)
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
      title: '消息',
      dataIndex: 'messageCount',
      key: 'messageCount',
      width: 70,
      sorter: (a: ClaudeSession, b: ClaudeSession) => a.messageCount - b.messageCount,
      render: (count: number) => count > 0 ? count : <span style={{ color: '#ccc' }}>-</span>,
    },
    {
      title: '最后修改',
      dataIndex: 'lastModified',
      key: 'lastModified',
      width: 160,
      sorter: (a: ClaudeSession, b: ClaudeSession) => a.lastModified - b.lastModified,
      defaultSortOrder: 'descend' as const,
      render: (time: number) => <span style={{ fontSize: 13 }}>{formatTime(time)}</span>,
    },
    {
      title: '操作',
      key: 'action',
      width: 60,
      render: (_: any, record: ClaudeSession) => (
        <Popconfirm
          title="确定删除此会话？"
          description="将删除 JSONL 文件及附件目录"
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
          message="关于会话管理"
          description={
            <div style={{ fontSize: 13, lineHeight: 1.8 }}>
              <p style={{ margin: '4px 0' }}>
                <strong>功能范围：</strong>仅管理 Claude Code 的会话文件（<code>~/.claude/projects/</code> 下的 JSONL 及附件），
                帮助你了解磁盘占用并清理不需要的旧会话。
              </p>
              <p style={{ margin: '4px 0' }}>
                <strong>不包含内容预览：</strong>会话 JSONL 格式随版本迭代差异较大（包含 file-history-snapshot、progress、tool-results、subagent 等多种类型），
                解析复杂且显示效果不佳。如需查看会话内容，建议直接使用 <code>claude --resume</code> 命令。
              </p>
              <p style={{ margin: '4px 0' }}>
                <strong>不管理 Codex 会话：</strong>Codex 使用完全不同的存储格式（SQLite + 独立 JSONL schema），
                且 Codex 仍在快速迭代，格式变化频繁，暂不支持。
              </p>
              <p style={{ margin: '4px 0' }}>
                <strong>不修改 history.jsonl：</strong>该文件是 Claude Code CLI 正在使用的全局历史索引，
                删除会话文件时不会改写它，避免与 CLI 产生冲突。
              </p>
            </div>
          }
        />
      )}

      <Card
        title={
          <Space>
            会话管理
            <Tag color="blue">{filteredSessions.length} 个会话</Tag>
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
            <Button icon={<ReloadOutlined />} onClick={loadSessions} loading={loading}>刷新</Button>
            <Button onClick={() => handleKeepRecent(10)}>每项目保留10个</Button>
            <Button onClick={() => handleCleanOld(30)}>清理30天前</Button>
            <Button onClick={() => handleCleanOld(60)}>清理60天前</Button>
          </Space>
        }
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' } }}
      >
        <Space style={{ marginBottom: 16 }} wrap>
          <Search
            placeholder="搜索项目、会话ID或消息内容"
            style={{ width: 280 }}
            onChange={e => setSearchText(e.target.value)}
            allowClear
          />
          <Select
            style={{ width: 120 }}
            value={sizeFilter}
            onChange={setSizeFilter}
            options={[
              { label: '全部大小', value: 'all' },
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
              { label: '全部时间', value: 'all' },
              { label: '7天前', value: '7' },
              { label: '30天前', value: '30' },
              { label: '60天前', value: '60' },
            ]}
          />
          {selectedRowKeys.length > 0 && (
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={handleBatchDelete}
            >
              删除选中 ({selectedRowKeys.length})
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
            showTotal: (total) => `共 ${total} 条`,
          }}
        />
      </Card>
    </div>
  )
}
