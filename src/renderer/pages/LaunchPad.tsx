/**
 * LaunchPad - 启动台页面 (v3.2.0)
 *
 * 高频「打开 / 接管」动作入口。
 */
import { useState } from 'react'
import { Typography, Button, Card, Row, Col, Space, Tag } from 'antd'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  RocketOutlined,
  CodeOutlined,
  DesktopOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons'

const { Title, Text } = Typography

export default function LaunchPad() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)

  const handleOpenCodex = async () => {
    try {
      setLoading(true)
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('system_open_app', { appName: 'Codex' })
    } catch {
      // best-effort
    } finally {
      setLoading(false)
    }
  }

  const handleOpenClaudeDesktop = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('system_open_app', { appName: 'Claude' })
    } catch {
      // best-effort
    }
  }

  return (
    <div className='page-container'>
      <div className='page-header'>
        <div>
          <Title level={3} className='m-0! mb-1!'>
            <RocketOutlined style={{ marginRight: 8 }} />
            {t('launchpad.title') || '启动台'}
          </Title>
          <Text type='secondary'>
            {t('launchpad.subtitle') || '快速打开客户端与管理接入点'}
          </Text>
        </div>
      </div>

      <Row gutter={[16, 16]}>
        {/* ── Codex ── */}
        <Col xs={24} md={12}>
          <Card
            variant='outlined'
            title={
              <Space>
                <CodeOutlined />
                <span>Codex</span>
                <Tag color='purple'>{t('launchpad.configTakeover') || '配置级'}</Tag>
              </Space>
            }
          >
            <Space direction='vertical' style={{ width: '100%' }}>
              <Text type='secondary'>
                {t('launchpad.codexDesc') ||
                  'Desktop 与 CLI 共享同一 config.toml 接入点'}
              </Text>
              <Space wrap>
                <Button
                  type='primary'
                  icon={<PlayCircleOutlined />}
                  onClick={handleOpenCodex}
                  loading={loading}
                >
                  {t('launchpad.openCodex') || '打开 Codex App'}
                </Button>
                <Button
                  icon={<RocketOutlined />}
                  onClick={() => navigate('/integrations')}
                >
                  {t('launchpad.manageRoute') || '管理接入'}
                </Button>
              </Space>
            </Space>
          </Card>
        </Col>

        {/* ── Claude Desktop ── */}
        <Col xs={24} md={12}>
          <Card
            variant='outlined'
            title={
              <Space>
                <DesktopOutlined />
                <span>Claude Desktop</span>
                <Tag color='purple'>{t('launchpad.configTakeover') || '配置级'}</Tag>
              </Space>
            }
          >
            <Space direction='vertical' style={{ width: '100%' }}>
              <Text type='secondary'>
                {t('launchpad.desktopDesc') ||
                  '配置级接入点 — 改 Claude Desktop 配置指向本地代理'}
              </Text>
              <Space wrap>
                <Button icon={<PlayCircleOutlined />} onClick={handleOpenClaudeDesktop}>
                  {t('launchpad.openDesktop') || '打开 Claude Desktop'}
                </Button>
                <Button
                  icon={<RocketOutlined />}
                  onClick={() => navigate('/integrations')}
                >
                  {t('launchpad.manageRoute') || '管理接入'}
                </Button>
              </Space>
            </Space>
          </Card>
        </Col>

        {/* ── Claude Code ── */}
        <Col xs={24} md={12}>
          <Card
            variant='outlined'
            title={
              <Space>
                <CodeOutlined />
                <span>Claude Code</span>
                <Tag color='blue'>{t('launchpad.processInjection') || '进程级'}</Tag>
              </Space>
            }
          >
            <Space direction='vertical' style={{ width: '100%' }}>
              <Text type='secondary'>
                {t('launchpad.claudeCodeDesc') ||
                  '进程级注入 — 项目级隔离，多实例可各用不同 route'}
              </Text>
              <Space wrap>
                <Button
                  type='primary'
                  icon={<PlayCircleOutlined />}
                  onClick={() => navigate('/projects')}
                >
                  {t('launchpad.newTerminal') || '打开终端'}
                </Button>
                <Button onClick={() => navigate('/instances')}>
                  {t('launchpad.viewInstances') || '查看实例'}
                </Button>
              </Space>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
