/**
 * Codex Desktop 配置页 — auth.json + config.toml 接管
 */
import { useEffect, useState } from 'react'
import { Typography, Button, Card, Space, Tag, Descriptions, Modal, Input, message, Spin, Select, Divider, Alert } from 'antd'
import {
  SettingOutlined,
  ReloadOutlined,
  EyeOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'

const { Title, Text } = Typography
const { TextArea } = Input

/** 某个 key 是否支持 Codex(client kind = codex) */
const isCodexKey = (types: string[]) => types.includes('codex')

export default function CodexPage() {
  const [loading, setLoading] = useState(true)
  const [takenOver, setTakenOver] = useState(false)
  const [configContent, setConfigContent] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [selectedProviderId, setSelectedProviderId] = useState<string>('')
  const [selectedKeyId, setSelectedKeyId] = useState<string>('')

  const { providers, fetchProviders } = useProviderStore()
  const { fetchAllApiKeys, getAllApiKeys } = useApiKeyStore()

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  useEffect(() => {
    if (providers.length > 0) {
      fetchAllApiKeys(providers.map(p => p.id))
    }
  }, [providers, fetchAllApiKeys])

  const checkStatus = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const taken: boolean = await invoke('codex_config_is_taken_over')
      setTakenOver(taken)
    } catch (e) {
      console.error('Status check failed:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { checkStatus() }, [])

  const handleReadConfig = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const content: string = await invoke('codex_config_read')
      setConfigContent(content || '(空)')
      setPreviewOpen(true)
    } catch (e) {
      message.error(`读取失败: ${e}`)
    }
  }

  const handleTakeover = async () => {
    if (!selectedProviderId || !selectedKeyId) {
      message.warning('请先选择供应商和密钥')
      return
    }
    setLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result: string = await invoke('codex_config_takeover', {
        providerId: selectedProviderId,
        apiKeyId: selectedKeyId,
      })
      message.success(result)
      setTakenOver(true)
    } catch (e) {
      message.error(`接管失败: ${e}`)
    } finally {
      setLoading(false)
    }
  }

  const handleRestore = async () => {
    setLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result: string = await invoke('codex_config_restore')
      message.success(result)
      setTakenOver(false)
    } catch (e) {
      message.error(`恢复失败: ${e}`)
    } finally {
      setLoading(false)
    }
  }

  const allKeys = getAllApiKeys()
  // 仅保留支持 Codex 的 key,以及至少有一个 Codex key 的 provider,避免选到
  // anthropic 风格 provider 导致 /responses 路由错配。
  const codexKeys = allKeys.filter(k => isCodexKey(k.types))
  const codexProviderIds = new Set(codexKeys.map(k => k.providerId))
  const activeProviders = providers.filter(p => p.isActive && codexProviderIds.has(p.id))
  const filteredKeys = codexKeys.filter(k =>
    !selectedProviderId || k.providerId === selectedProviderId
  )

  const selectedKey = allKeys.find(k => k.id === selectedKeyId)
  const selectedProvider = providers.find(p => p.id === selectedProviderId)

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 80 }}><Spin size='large' /></div>
  }

  return (
    <div className='page-container'>
      <div className='page-header'>
        <div>
          <Title level={3} className='m-0! mb-1!'>
            <SettingOutlined style={{ marginRight: 8 }} />
            Codex Desktop
          </Title>
          <Text type='secondary'>配置级接管 — 写入 ~/.codex/auth.json + config.toml,转发到本地网关</Text>
        </div>
        <Button icon={<EyeOutlined />} onClick={handleReadConfig}>查看配置</Button>
      </div>

      <Card variant='outlined' style={{ marginTop: 16 }}>
        <Descriptions column={1} size='small'>
          <Descriptions.Item label='接入形态'><Tag color='purple'>配置级接管</Tag></Descriptions.Item>
          <Descriptions.Item label='配置文件'>
            <Text code>~/.codex/config.toml</Text>
          </Descriptions.Item>
          <Descriptions.Item label='当前状态'>
            {takenOver
              ? <Tag color='green' icon={<CheckCircleOutlined />}>已接管 — 指向本地网关</Tag>
              : <Tag icon={<ExclamationCircleOutlined />}>官方配置</Tag>}
          </Descriptions.Item>
        </Descriptions>

        <Divider />

        <Title level={5}>选择上游供应商和密钥</Title>
        <Text type='secondary' style={{ display: 'block', marginBottom: 12 }}>
          仅列出支持 Codex 的密钥。接管会把 session token 写入 config.toml 的 experimental_bearer_token,<strong>不动 auth.json</strong> → 保留你的官方 ChatGPT 登录和插件能力。
        </Text>

        <Space direction='vertical' style={{ width: '100%' }}>
          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>供应商</Text>
            <Select
              style={{ width: '100%' }}
              placeholder='选择供应商'
              value={selectedProviderId || undefined}
              onChange={(v) => { setSelectedProviderId(v); setSelectedKeyId('') }}
              options={activeProviders.map(p => ({
                value: p.id,
                label: p.name,
              }))}
            />
          </div>

          <div>
            <Text strong style={{ display: 'block', marginBottom: 4 }}>密钥</Text>
            <Select
              style={{ width: '100%' }}
              placeholder='选择密钥'
              value={selectedKeyId || undefined}
              onChange={(v) => setSelectedKeyId(v)}
              options={filteredKeys.map(k => ({
                value: k.id,
                label: k.alias || k.value.slice(0, 12) + '...',
              }))}
              notFoundContent={selectedProviderId ? '该供应商下无密钥，请先去密钥页添加' : '请先选择供应商'}
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

        <Alert
          type='warning'
          showIcon
          style={{ marginBottom: 12 }}
          message='接管后需重启 Codex Desktop 才生效'
          description='Codex Desktop 仅在启动时读取配置。另外:若在 App 内登录 ChatGPT 账号并使用第一方模型,会绕过本接管直连官方。接管采用 experimental_bearer_token 机制保留官方登录,但该字段为 Codex 实验特性,跨版本可能变化。'
        />

        <Space>
          {takenOver ? (
            <>
              <Button danger icon={<ReloadOutlined />} onClick={handleRestore} loading={loading}>
                恢复官方配置
              </Button>
              <Button type='primary' icon={<SettingOutlined />} onClick={handleTakeover} loading={loading}>
                重新接管 (切换上游)
              </Button>
            </>
          ) : (
            <Button type='primary' icon={<SettingOutlined />} onClick={handleTakeover} loading={loading}>
              接管 Codex Desktop
            </Button>
          )}
        </Space>
      </Card>

      <Modal title='~/.codex/config.toml' open={previewOpen} onCancel={() => setPreviewOpen(false)} footer={null} width={600}>
        <TextArea value={configContent} readOnly autoSize={{ minRows: 4, maxRows: 20 }} style={{ fontFamily: 'monospace', fontSize: 12 }} />
      </Modal>
    </div>
  )
}
