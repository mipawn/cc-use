/**
 * LaunchPad - 启动台 (v3.2.0)
 *
 * 三个客户端接入的入口: Claude Code / Codex / Claude Desktop
 * 显示每个客户端的可用密钥数量。
 */
import { useEffect } from 'react'
import { Typography, Card, Row, Col, Space, Tag } from 'antd'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  CodeOutlined,
  DesktopOutlined,
  AppstoreOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'
import { supportsKeyClient } from '../utils/clientSupport'

const { Title, Text } = Typography

export default function LaunchPad() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const { providers, fetchProviders } = useProviderStore()
  const { getAllApiKeys, fetchAllApiKeys } = useApiKeyStore()

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  useEffect(() => {
    if (providers.length > 0) {
      fetchAllApiKeys(providers.map(p => p.id))
    }
  }, [providers, fetchAllApiKeys])

  const allKeys = getAllApiKeys()
  // 按客户端支持情况计数
  const claudeCodeKeyCount = allKeys.filter(k => {
    const p = providers.find(pr => pr.id === k.providerId)
    return p && supportsKeyClient(p, k, 'claude_code')
  }).length
  const codexKeyCount = allKeys.filter(k => {
    const p = providers.find(pr => pr.id === k.providerId)
    return p && supportsKeyClient(p, k, 'codex')
  }).length
  const claudeDesktopKeyCount = allKeys.filter(k => {
    const p = providers.find(pr => pr.id === k.providerId)
    return p && supportsKeyClient(p, k, 'claude_desktop')
  }).length

  const cardStyle = { cursor: 'pointer', borderColor: 'var(--ant-color-primary)' }

  return (
    <div className='page-container'>
      <div className='page-header'>
        <div>
          <Title level={3} className='m-0! mb-1!'>
            {t('launchpad.title') || '启动台'}
          </Title>
          <Text type='secondary'>
            {t('launchpad.subtitle') || '选择客户端开始使用'}
          </Text>
        </div>
      </div>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        {/* Claude Code */}
        <Col xs={24} md={8}>
          <Card hoverable variant='outlined' onClick={() => navigate('/claude-code')} style={cardStyle}>
            <Space direction='vertical' style={{ width: '100%' }}>
              <Space>
                <CodeOutlined style={{ fontSize: 20 }} />
                <Title level={4} className='m-0!'>Claude Code</Title>
              </Space>
              <Space size={8} wrap>
                <Tag color='blue'>进程级注入</Tag>
                {claudeCodeKeyCount > 0 ? (
                  <Tag color='green'>{claudeCodeKeyCount} 个可用密钥</Tag>
                ) : (
                  <Tag color='orange' icon={<WarningOutlined />}>暂无密钥</Tag>
                )}
              </Space>
              <Text type='secondary'>
                项目级隔离，多实例可各用不同 route。wrapper 注入 env 指向本地代理。
              </Text>
              <Text type='secondary' style={{ fontSize: 12 }}>
                项目 · 实例 · 会话
              </Text>
            </Space>
          </Card>
        </Col>

        {/* Codex Desktop */}
        <Col xs={24} md={8}>
          <Card hoverable variant='outlined' onClick={() => navigate('/codex')} style={cardStyle}>
            <Space direction='vertical' style={{ width: '100%' }}>
              <Space>
                <AppstoreOutlined style={{ fontSize: 20 }} />
                <Title level={4} className='m-0!'>Codex Desktop</Title>
              </Space>
              <Space size={8} wrap>
                <Tag color='purple'>配置级接管</Tag>
                {codexKeyCount > 0 ? (
                  <Tag color='green'>{codexKeyCount} 个可用密钥</Tag>
                ) : (
                  <Tag color='orange' icon={<WarningOutlined />}>暂无密钥</Tag>
                )}
              </Space>
              <Text type='secondary'>
                接管 Codex Desktop 配置，指向本地代理。
              </Text>
              <Text type='secondary' style={{ fontSize: 12 }}>
                配置接管 · 恢复 · 查看
              </Text>
            </Space>
          </Card>
        </Col>

        {/* Claude Desktop */}
        <Col xs={24} md={8}>
          <Card hoverable variant='outlined' onClick={() => navigate('/claude-desktop')} style={cardStyle}>
            <Space direction='vertical' style={{ width: '100%' }}>
              <Space>
                <DesktopOutlined style={{ fontSize: 20 }} />
                <Title level={4} className='m-0!'>Claude Desktop</Title>
              </Space>
              <Space size={8} wrap>
                <Tag color='purple'>配置级接管</Tag>
                {claudeDesktopKeyCount > 0 ? (
                  <Tag color='green'>{claudeDesktopKeyCount} 个可用密钥</Tag>
                ) : (
                  <Tag color='orange' icon={<WarningOutlined />}>暂无密钥</Tag>
                )}
              </Space>
              <Text type='secondary'>
                接管 Claude Desktop config.json，指向本地代理。
              </Text>
              <Text type='secondary' style={{ fontSize: 12 }}>
                配置接管 · 恢复 · 查看
              </Text>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
