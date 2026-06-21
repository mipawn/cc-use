/**
 * Claude Desktop 配置页 — config.json 接管 + route 管理
 */
import { useEffect, useState } from 'react'
import { Typography, Button, Card, Space, Tag, Descriptions, Modal, Input, message, Spin, Select, Divider } from 'antd'
import {
  SettingOutlined,
  ReloadOutlined,
  EyeOutlined,
} from '@ant-design/icons'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'

const { Title, Text } = Typography
const { TextArea } = Input

export default function ClaudeDesktopPage() {
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [configContent, setConfigContent] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [selectedProviderId, setSelectedProviderId] = useState<string>('')
  const [selectedKeyId, setSelectedKeyId] = useState<string>('')

  const { providers, fetchProviders } = useProviderStore()
  const { fetchAllApiKeys, getAllApiKeys } = useApiKeyStore()

  useEffect(() => { fetchProviders() }, [fetchProviders])
  useEffect(() => {
    if (providers.length > 0) fetchAllApiKeys(providers.map(p => p.id))
  }, [providers, fetchAllApiKeys])

  const checkStatus = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const s: string = await invoke('claude_desktop_schema_detect')
      setStatus(s)
    } catch (e) {
      setStatus('error')
    } finally { setLoading(false) }
  }

  useEffect(() => { checkStatus() }, [])

  const handleReadConfig = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const content: string = await invoke('claude_desktop_config_read')
      setConfigContent(content || '(空)')
      setPreviewOpen(true)
    } catch (e) { message.error(`读取失败: ${e}`) }
  }

  const handleTakeover = async () => {
    if (!selectedProviderId || !selectedKeyId) {
      message.warning('请先选择供应商和密钥')
      return
    }
    setLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result: string = await invoke('claude_desktop_config_takeover', {
        providerId: selectedProviderId,
        apiKeyId: selectedKeyId,
      })
      message.success(result)
      setStatus('taken_over')
    } catch (e) { message.error(`接管失败: ${e}`) }
    finally { setLoading(false) }
  }

  const handleRestore = async () => {
    setLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result: string = await invoke('claude_desktop_config_restore')
      message.success(result)
      setStatus('official')
    } catch (e) { message.error(`恢复失败: ${e}`) }
    finally { setLoading(false) }
  }

  const allKeys = getAllApiKeys()
  const activeProviders = providers.filter(p => p.isActive)
  const filteredKeys = allKeys.filter(k => !selectedProviderId || k.providerId === selectedProviderId)
  const selectedKey = allKeys.find(k => k.id === selectedKeyId)
  const selectedProvider = providers.find(p => p.id === selectedProviderId)

  const statusTag = () => {
    switch (status) {
      case 'taken_over': return <Tag color='green' icon={<ReloadOutlined />}>已接管</Tag>
      case 'official': return <Tag color='blue'>官方配置</Tag>
      case 'not_found': return <Tag color='default'>配置不存在</Tag>
      default: return <Tag color='default'>待探测</Tag>
    }
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 80 }}><Spin size='large' /></div>
  }

  return (
    <div className='page-container'>
      <div className='page-header'>
        <div>
          <Title level={3} className='m-0! mb-1!'>
            <SettingOutlined style={{ marginRight: 8 }} />
            Claude Desktop
          </Title>
          <Text type='secondary'>配置级接入点 — 接管 Claude Desktop config.json</Text>
        </div>
        <Button icon={<EyeOutlined />} onClick={handleReadConfig}>查看配置</Button>
      </div>

      <Card variant='outlined' style={{ marginTop: 16 }}>
        <Descriptions column={1} size='small'>
          <Descriptions.Item label='接入形态'><Tag color='purple'>配置级接管</Tag></Descriptions.Item>
          <Descriptions.Item label='配置文件'>
            <Text code>~/Library/Application Support/Claude/config.json</Text>
          </Descriptions.Item>
          <Descriptions.Item label='当前状态'>{statusTag()}</Descriptions.Item>
        </Descriptions>

        <Divider />

        <Title level={5}>Route 配置 — 选择上游供应商和密钥</Title>
        <Text type='secondary' style={{ display: 'block', marginBottom: 12 }}>
          Claude Desktop 通过代理转发到上游时使用此配置。
        </Text>

        <Space direction='vertical' style={{ width: '100%' }}>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>供应商</Text>
            <Select
              style={{ width: '100%' }}
              placeholder='选择供应商'
              value={selectedProviderId || undefined}
              onChange={(v) => { setSelectedProviderId(v); setSelectedKeyId('') }}
              options={activeProviders.map(p => ({ value: p.id, label: p.name }))}
            />
          </div>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>密钥</Text>
            <Select
              style={{ width: '100%' }}
              placeholder='选择密钥'
              value={selectedKeyId || undefined}
              onChange={(v) => setSelectedKeyId(v)}
              options={filteredKeys.map(k => ({ value: k.id, label: k.alias || k.value.slice(0, 12) + '...' }))}
              notFoundContent={selectedProviderId ? '该供应商下无密钥' : '请先选择供应商'}
            />
          </div>
        </Space>

        {selectedProvider && selectedKey && (
          <div style={{ marginTop: 12, padding: '8px 12px', background: '#f6ffed', borderRadius: 6, border: '1px solid #b7eb8f' }}>
            <Text style={{ fontSize: 13 }}>
              当前选择: <Text strong>{selectedProvider.name}</Text> / <Text code>{selectedKey.alias || selectedKey.value.slice(0, 12)}</Text>
            </Text>
          </div>
        )}

        <Divider />

        <Space>
          {status === 'taken_over' ? (
            <>
              <Button danger icon={<ReloadOutlined />} onClick={handleRestore} loading={loading}>恢复官方配置</Button>
              <Button type='primary' icon={<SettingOutlined />} onClick={handleTakeover} loading={loading}>重新接管 (切 route)</Button>
            </>
          ) : (
            <Button type='primary' icon={<SettingOutlined />} onClick={handleTakeover} loading={loading}>接管 Claude Desktop</Button>
          )}
        </Space>
      </Card>

      <Modal title='Claude Desktop config.json' open={previewOpen} onCancel={() => setPreviewOpen(false)} footer={null} width={600}>
        <TextArea value={configContent} readOnly autoSize={{ minRows: 4, maxRows: 20 }} style={{ fontFamily: 'monospace', fontSize: 12 }} />
      </Modal>
    </div>
  )
}
