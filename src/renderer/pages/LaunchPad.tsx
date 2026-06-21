/**
 * LaunchPad - 启动台 (v3.2.0)
 * 三个客户端接入的入口: Claude Code / Codex / Claude Desktop
 */
import { Typography, Card, Row, Col, Space, Tag, theme } from 'antd'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  CodeOutlined,
  DesktopOutlined,
} from '@ant-design/icons'

const { Title, Text } = Typography

export default function LaunchPad() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const navigate = useNavigate()

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
          <Card
            hoverable
            variant='outlined'
            onClick={() => navigate('/claude-code')}
            style={{ cursor: 'pointer', borderColor: token.colorPrimary }}
          >
            <Space direction='vertical' style={{ width: '100%' }}>
              <Space>
                <CodeOutlined style={{ fontSize: 20 }} />
                <Title level={4} className='m-0!'>Claude Code</Title>
              </Space>
              <Tag color='blue'>进程级注入</Tag>
              <Text type='secondary'>
                项目级隔离，多实例可各用不同 route。wrapper 注入 env 指向本地代理。
              </Text>
              <Text type='secondary' style={{ fontSize: 12 }}>
                项目 · 实例 · 会话
              </Text>
            </Space>
          </Card>
        </Col>

        {/* Codex */}
        <Col xs={24} md={8}>
          <Card
            hoverable
            variant='outlined'
            onClick={() => navigate('/codex')}
            style={{ cursor: 'pointer', borderColor: token.colorPrimary }}
          >
            <Space direction='vertical' style={{ width: '100%' }}>
              <Space>
                <CodeOutlined style={{ fontSize: 20 }} />
                <Title level={4} className='m-0!'>Codex</Title>
              </Space>
              <Tag color='purple'>配置级接管</Tag>
              <Text type='secondary'>
                接管 ~/.codex/config.toml，指向本地代理。Desktop 与 CLI 共享同一配置。
              </Text>
              <Text type='secondary' style={{ fontSize: 12 }}>
                配置接管 · 恢复 · 查看
              </Text>
            </Space>
          </Card>
        </Col>

        {/* Claude Desktop */}
        <Col xs={24} md={8}>
          <Card
            hoverable
            variant='outlined'
            onClick={() => navigate('/claude-desktop')}
            style={{ cursor: 'pointer', borderColor: token.colorPrimary }}
          >
            <Space direction='vertical' style={{ width: '100%' }}>
              <Space>
                <DesktopOutlined style={{ fontSize: 20 }} />
                <Title level={4} className='m-0!'>Claude Desktop</Title>
              </Space>
              <Tag color='purple'>配置级接管</Tag>
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
