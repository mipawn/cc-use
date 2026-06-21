/**
 * Claude Desktop 配置页 — 配置接管 (adapter)
 */
import { useState } from 'react'
import { Typography, Button, Card, Space, Tag, Descriptions, Modal, Input, message, Spin } from 'antd'
import {
  SettingOutlined,
  ReloadOutlined,
  EyeOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons'

const { Title, Text } = Typography
const { TextArea } = Input

export default function ClaudeDesktopPage() {
  const [loading, setLoading] = useState(false)
  const [schemaSupported, setSchemaSupported] = useState(false)
  const [takenOver, setTakenOver] = useState(false)
  const [configPreview, setConfigPreview] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)

  const handleDetectSchema = async () => {
    setLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const result: boolean = await invoke('claude_desktop_schema_detect', {})
      setSchemaSupported(result)
      message.info(result ? 'Schema 已验证，可以接管' : 'Schema 尚未验证，接管暂不可用')
    } catch {
      message.error('Schema 探测失败')
    } finally {
      setLoading(false)
    }
  }

  const handleTakeover = async () => {
    setLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('claude_desktop_config_takeover', {})
      setTakenOver(true)
      message.success('Claude Desktop 配置已接管')
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
      await invoke('claude_desktop_config_restore', {})
      setTakenOver(false)
      message.success('Claude Desktop 官方配置已恢复')
    } catch (e) {
      message.error(`恢复失败: ${e}`)
    } finally {
      setLoading(false)
    }
  }

  const handlePreview = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const content: string = await invoke('claude_desktop_config_read', {})
      setConfigPreview(content || '(config.json 为空或不存在)')
      setPreviewOpen(true)
    } catch {
      setConfigPreview('(读取失败)')
      setPreviewOpen(true)
    }
  }

  return (
    <div className='page-container'>
      <div className='page-header'>
        <div>
          <Title level={3} className='m-0! mb-1!'>
            <SettingOutlined style={{ marginRight: 8 }} />
            Claude Desktop
          </Title>
          <Text type='secondary'>
            配置级接入点 — 接管 Claude Desktop config.json，指向本地代理
          </Text>
        </div>
        <Space>
          <Button icon={<EyeOutlined />} onClick={handlePreview}>
            查看配置
          </Button>
        </Space>
      </div>

      {loading && (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin size='large' />
        </div>
      )}

      <Card variant='outlined' style={{ marginTop: 16 }}>
        <Descriptions column={1} size='small'>
          <Descriptions.Item label='接入形态'>
            <Tag color='purple'>配置级接管</Tag>
          </Descriptions.Item>
          <Descriptions.Item label='配置文件'>
            <Text code>~/Library/Application Support/Claude/config.json</Text>
          </Descriptions.Item>
          <Descriptions.Item label='Schema 状态'>
            {schemaSupported ? (
              <Tag color='green'>已验证</Tag>
            ) : (
              <Tag color='default' icon={<ExclamationCircleOutlined />}>待验证</Tag>
            )}
          </Descriptions.Item>
          <Descriptions.Item label='接管状态'>
            {takenOver ? (
              <Tag color='green'>已接管</Tag>
            ) : (
              <Tag>官方配置</Tag>
            )}
          </Descriptions.Item>
          <Descriptions.Item label='接入方式'>
            <Text type='secondary'>
              接管后修改 provider/baseUrl/apiKey 指向本地代理。
              Schema 验证通过前接管不可用，不伪装已支持。
            </Text>
          </Descriptions.Item>
        </Descriptions>

        <div style={{ marginTop: 16 }}>
          <Space>
            {!schemaSupported && (
              <Button icon={<ReloadOutlined />} onClick={handleDetectSchema} loading={loading}>
                探测 Schema
              </Button>
            )}
            {schemaSupported && (
              takenOver ? (
                <Button danger icon={<ReloadOutlined />} onClick={handleRestore} loading={loading}>
                  恢复官方配置
                </Button>
              ) : (
                <Button type='primary' icon={<SettingOutlined />} onClick={handleTakeover} loading={loading}>
                  接管 Claude Desktop
                </Button>
              )
            )}
          </Space>
        </div>
      </Card>

      <Modal
        title='Claude Desktop config.json'
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        footer={null}
        width={600}
      >
        <TextArea
          value={configPreview}
          readOnly
          autoSize={{ minRows: 4, maxRows: 20 }}
          style={{ fontFamily: 'monospace', fontSize: 12 }}
        />
      </Modal>
    </div>
  )
}
