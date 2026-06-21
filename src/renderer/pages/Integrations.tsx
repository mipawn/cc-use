/**
 * Integrations - 接入点页面 (v3.2.0 核心页)
 *
 * 一张表列出所有客户端接入点：
 * - Claude Code（进程级注入）— 多实例多 route,展示项目数和运行实例
 * - Codex（配置级接管）— 单一 active route,接管/恢复/打开
 * - Claude Desktop（配置级接管，待验证）
 */
import { useEffect, useState } from 'react'
import { Typography, Card, Tag, Space, Button, Spin, theme, Row, Col } from 'antd'
import { useTranslation } from 'react-i18next'
import {
  CodeOutlined,
  DesktopOutlined,
  RocketOutlined,
  ReloadOutlined,
  SettingOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'

const { Title, Text } = Typography

interface IntegrationStatus {
  clientKind: string
  label: string
  form: 'process_injection' | 'config_takeover'
  status: string
  activeRoute?: { providerName: string; keyAlias: string }
  instanceCount?: number
  projectCount?: number
}

export default function Integrations() {
  const { t } = useTranslation()
  const { token } = theme.useToken()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([])

  useEffect(() => {
    // Build integration status from known client kinds
    // In production, this would query backend for actual status
    const items: IntegrationStatus[] = [
      {
        clientKind: 'claude_code',
        label: 'Claude Code',
        form: 'process_injection',
        status: 'configured',
        activeRoute: { providerName: '—', keyAlias: '—' },
        instanceCount: 0,
        projectCount: 0,
      },
      {
        clientKind: 'codex',
        label: 'Codex',
        form: 'config_takeover',
        status: 'not_configured',
        activeRoute: undefined,
      },
      {
        clientKind: 'claude_desktop',
        label: 'Claude Desktop',
        form: 'config_takeover',
        status: 'unsupported',
        activeRoute: undefined,
      },
    ]
    setIntegrations(items)
    setLoading(false)
  }, [])

  const getStatusTag = (item: IntegrationStatus) => {
    switch (item.status) {
      case 'configured':
      case 'taken_over':
        return <Tag color='green' icon={<CheckCircleOutlined />}>{t('integrations.configured')}</Tag>
      case 'not_configured':
        return <Tag color='default'>{t('integrations.notConfigured')}</Tag>
      case 'restart_required':
        return <Tag color='blue' icon={<ExclamationCircleOutlined />}>{t('integrations.restartRequired')}</Tag>
      case 'config_conflict':
        return <Tag color='orange' icon={<ExclamationCircleOutlined />}>{t('integrations.configConflict')}</Tag>
      case 'unsupported':
        return <Tag color='default' icon={<ExclamationCircleOutlined />}>{t('integrations.unsupported')}</Tag>
      default:
        return <Tag>{item.status}</Tag>
    }
  }

  const getFormTag = (form: string) => {
    return form === 'process_injection'
      ? <Tag color='blue'>{t('integrations.processInjection')}</Tag>
      : <Tag color='purple'>{t('integrations.configTakeover')}</Tag>
  }

  const getActions = (item: IntegrationStatus) => {
    switch (item.clientKind) {
      case 'claude_code':
        return (
          <Space>
            <Button size='small' type='primary' onClick={() => navigate('/projects')}>
              {t('integrations.viewProjects')}
            </Button>
            <Button size='small' onClick={() => navigate('/instances')}>
              {t('integrations.viewInstances')}
            </Button>
          </Space>
        )
      case 'codex':
        return (
          <Space>
            {item.status === 'taken_over' ? (
              <>
                <Button size='small' onClick={() => navigate('/launch')}>
                  <RocketOutlined /> {t('integrations.openCodex')}
                </Button>
                <Button size='small'>
                  <ReloadOutlined /> {t('integrations.restore')}
                </Button>
              </>
            ) : (
              <Button size='small' type='primary' onClick={() => navigate('/launch')}>
                <SettingOutlined /> {t('integrations.takeover')}
              </Button>
            )}
          </Space>
        )
      case 'claude_desktop':
        return (
          <Space>
            <Button size='small' disabled={item.status === 'unsupported'}>
              <SettingOutlined /> {t('integrations.takeover')}
            </Button>
          </Space>
        )
      default:
        return null
    }
  }

  return (
    <div className='page-container'>
      <div className='page-header'>
        <div>
          <Title level={3} className='m-0! mb-1!'>
            {t('integrations.title') || '接入点'}
          </Title>
          <Text type='secondary'>
            {t('integrations.subtitle') || '所有客户端接入状态与 active route 管理'}
          </Text>
        </div>
      </div>

      {loading ? (
        <div className='empty-state'>
          <Spin size='large' />
        </div>
      ) : (
        <Row gutter={[16, 16]}>
          {integrations.map((item) => (
            <Col key={item.clientKind} xs={24} lg={8}>
              <Card
                variant='outlined'
                title={
                  <Space>
                    {item.clientKind.includes('desktop') ? (
                      <DesktopOutlined />
                    ) : (
                      <CodeOutlined />
                    )}
                    <span>{item.label}</span>
                    {getStatusTag(item)}
                  </Space>
                }
                styles={{ body: { minHeight: 160 } }}
              >
                <Space direction='vertical' style={{ width: '100%' }}>
                  {/* Form tag */}
                  <div>{getFormTag(item.form)}</div>

                  {/* Active route */}
                  {item.activeRoute ? (
                    <Text style={{ fontSize: 13 }}>
                      {t('integrations.activeRoute')}: {item.activeRoute.providerName} / {item.activeRoute.keyAlias}
                    </Text>
                  ) : item.form === 'config_takeover' ? (
                    <Text type='secondary' style={{ fontSize: 13 }}>
                      {t('integrations.noRoute')}
                    </Text>
                  ) : (
                    <Text type='secondary' style={{ fontSize: 13 }}>
                      {t('integrations.perInstanceRoute')}
                    </Text>
                  )}

                  {/* Instance/project count (process-level) */}
                  {item.form === 'process_injection' && (
                    <Text type='secondary' style={{ fontSize: 13 }}>
                      {item.instanceCount != null && (
                        <span>
                          <CheckCircleOutlined style={{ color: token.colorSuccess, marginRight: 4 }} />
                          {item.instanceCount} {t('integrations.instancesRunning')}
                          {' · '}
                        </span>
                      )}
                      {item.projectCount} {t('integrations.projects')}
                    </Text>
                  )}

                  {/* Actions */}
                  <div style={{ marginTop: 8 }}>{getActions(item)}</div>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </div>
  )
}
