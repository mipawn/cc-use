/**
 * Claude Desktop 配置页 — config.json 接管
 */
import { useEffect, useState } from 'react'
import { Typography, Button, Card, Space, Tag, Descriptions, Modal, Input, message, Spin } from 'antd'
import {
  SettingOutlined,
  ReloadOutlined,
  EyeOutlined,
} from '@ant-design/icons'

const { Title, Text } = Typography
const { TextArea } = Input

export default function ClaudeDesktopPage() {
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [configContent, setConfigContent] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)

  const checkStatus = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const s: string = await invoke('claude_desktop_schema_detect')
      setStatus(s)
    } catch (e) {
      console.error('Schema detect failed:', e)
      setStatus('error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { checkStatus() }, [])

  const handleReadConfig = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const content: string = await invoke('claude_desktop_config_read')
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
      const result: string = await invoke('claude_desktop_config_takeover')
      message.success(result)
      setStatus('taken_over')
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
      const result: string = await invoke('claude_desktop_config_restore')
      message.success(result)
      setStatus('official')
    } catch (e) {
      message.error(`恢复失败: ${e}`)
    } finally {
      setLoading(false)
    }
  }

  const statusTag = () => {
    switch (status) {
      case 'taken_over': return <Tag color='green'>已接管 — 指向本地代理</Tag>
      case 'official': return <Tag color='blue'>官方配置</Tag>
      case 'not_found': return <Tag>配置不存在</Tag>
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
          <Descriptions.Item label='说明'>
            <Text type='secondary'>
              接管后修改 provider/baseUrl/apiKey 指向本地代理。
            </Text>
          </Descriptions.Item>
        </Descriptions>

        <div style={{ marginTop: 16 }}>
          <Space>
            {status === 'taken_over' ? (
              <Button danger icon={<ReloadOutlined />} onClick={handleRestore} loading={loading}>
                恢复官方配置
              </Button>
            ) : (
              <Button type='primary' icon={<SettingOutlined />} onClick={handleTakeover} loading={loading}>
                接管 Claude Desktop
              </Button>
            )}
          </Space>
        </div>
      </Card>

      <Modal title='Claude Desktop config.json' open={previewOpen} onCancel={() => setPreviewOpen(false)} footer={null} width={600}>
        <TextArea value={configContent} readOnly autoSize={{ minRows: 4, maxRows: 20 }} style={{ fontFamily: 'monospace', fontSize: 12 }} />
      </Modal>
    </div>
  )
}
