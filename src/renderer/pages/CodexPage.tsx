/**
 * Codex 配置页 — config.toml 接管
 */
import { useState } from 'react'
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
  const [loading, setLoading] = useState(false)
  const [takenOver, setTakenOver] = useState(false)
  const [configPreview, setConfigPreview] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)

  const handleTakeover = async () => {
    setLoading(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('codex_config_takeover', { proxyPort: 12345 })
      setTakenOver(true)
      message.success('Codex config.toml 已接管')
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
      await invoke('codex_config_restore', {})
      setTakenOver(false)
      message.success('Codex 官方配置已恢复')
    } catch (e) {
      message.error(`恢复失败: ${e}`)
    } finally {
      setLoading(false)
    }
  }

  const handlePreview = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const content: string = await invoke('codex_config_read', {})
      setConfigPreview(content || '(config.toml 为空或不存在)')
      setPreviewOpen(true)
    } catch {
      setConfigPreview('(读取失败)')
      setPreviewOpen(true)
    }
  }

  const handleCheckStatus = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const status: boolean = await invoke('codex_config_is_taken_over', {})
      setTakenOver(status)
      message.info(status ? '当前状态: 已接管' : '当前状态: 官方配置')
    } catch {
      message.error('状态查询失败')
    }
  }

  return (
    <div className='page-container'>
      <div className='page-header'>
        <div>
          <Title level={3} className='m-0! mb-1!'>
            <SettingOutlined style={{ marginRight: 8 }} />
            Codex
          </Title>
          <Text type='secondary'>
            配置级接入点 — 接管 ~/.codex/config.toml，指向本地代理
          </Text>
        </div>
        <Space>
          <Button icon={<EyeOutlined />} onClick={handlePreview}>
            查看配置
          </Button>
          <Button icon={<ReloadOutlined />} onClick={handleCheckStatus}>
            检测状态
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
            <Text code>~/.codex/config.toml</Text>
          </Descriptions.Item>
          <Descriptions.Item label='接管状态'>
            {takenOver ? (
              <Tag color='green' icon={<CheckCircleOutlined />}>已接管</Tag>
            ) : (
              <Tag icon={<ExclamationCircleOutlined />}>官方配置</Tag>
            )}
          </Descriptions.Item>
          <Descriptions.Item label='接入方式'>
            <Text type='secondary'>
              接管后写入 [model_providers.cc-use] block，指向本地代理。
              不做 launchctl setenv、不碰 auth.json。
              Desktop 与 CLI 共享同一套配置。
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

      <Modal
        title='~/.codex/config.toml'
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
