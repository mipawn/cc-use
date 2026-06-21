/**
 * Codex 配置页 — config.toml 接管
 */
import { useEffect, useState } from 'react'
import { Typography, Button, Card, Space, Tag, Descriptions, Modal, Input, message, Spin } from 'antd'
import {
  SettingOutlined,
  ReloadOutlined,
  EyeOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons'

const { Title, Text } = Typography
const { TextArea } = Input

export default function CodexPage() {
  const [loading, setLoading] = useState(true)
  const [takenOver, setTakenOver] = useState(false)
  const [configContent, setConfigContent] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)

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
    setLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result: string = await invoke('codex_config_takeover')
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

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 80 }}><Spin size='large' /></div>
  }

  return (
    <div className='page-container'>
      <div className='page-header'>
        <div>
          <Title level={3} className='m-0! mb-1!'>
            <SettingOutlined style={{ marginRight: 8 }} />
            Codex
          </Title>
          <Text type='secondary'>配置级接入点 — 接管 ~/.codex/config.toml</Text>
        </div>
        <Button icon={<EyeOutlined />} onClick={handleReadConfig}>查看配置</Button>
      </div>

      <Card variant='outlined' style={{ marginTop: 16 }}>
        <Descriptions column={1} size='small'>
          <Descriptions.Item label='接入形态'><Tag color='purple'>配置级接管</Tag></Descriptions.Item>
          <Descriptions.Item label='配置文件'><Text code>~/.codex/config.toml</Text></Descriptions.Item>
          <Descriptions.Item label='当前状态'>
            {takenOver
              ? <Tag color='green' icon={<CheckCircleOutlined />}>已接管 — 指向本地代理</Tag>
              : <Tag icon={<ExclamationCircleOutlined />}>官方配置</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label='说明'>
            <Text type='secondary'>
              接管后在 config.toml 中写入 [model_providers.cc-use] block。
              Desktop 与 CLI 共享同一配置。不碰 auth.json。
            </Text>
          </Descriptions.Item>
        </Descriptions>

        <div style={{ marginTop: 16 }}>
          <Space>
            {takenOver ? (
              <Button danger icon={<ReloadOutlined />} onClick={handleRestore} loading={loading}>
                恢复官方配置
              </Button>
            ) : (
              <Button type='primary' icon={<SettingOutlined />} onClick={handleTakeover} loading={loading}>
                接管 Codex
              </Button>
            )}
          </Space>
        </div>
      </Card>

      <Modal title='~/.codex/config.toml' open={previewOpen} onCancel={() => setPreviewOpen(false)} footer={null} width={600}>
        <TextArea value={configContent} readOnly autoSize={{ minRows: 4, maxRows: 20 }} style={{ fontFamily: 'monospace', fontSize: 12 }} />
      </Modal>
    </div>
  )
}
