import { useState } from 'react'
import { Button, Drawer, Segmented, Tabs } from 'antd'
import { ArrowLeftOutlined, SettingOutlined } from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Instances, { type InstanceClient } from './Instances'
import Sessions from './Sessions'
import GlobalConfigModal from '../components/providers/GlobalConfigModal'
import TerminalToolsPanel from '../components/providers/TerminalToolsPanel'
import PageHeader from '../components/common/PageHeader'
import styles from './Instances.module.css'

export default function InstancesPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const client = params.get('client')
  const clientKind: InstanceClient | undefined =
    client === 'claude_code' || client === 'grok' ? client : undefined
  const sessions = params.get('view') === 'sessions' && clientKind === 'claude_code'
  const update = (values: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    setParams(next)
  }

  return (
    <div className={styles.container}>
      <PageHeader
        title={t(sessions ? 'instances.claudeSessions' : 'workspace.instances')}
        description={t(sessions ? 'instances.sessionsHint' : 'instances.subtitle')}
        actions={
          <>
            {sessions ? (
              <Button icon={<ArrowLeftOutlined />} onClick={() => update({ view: null })}>
                {t('instances.backToInstances')}
              </Button>
            ) : (
              <Button onClick={() => update({ view: 'sessions', client: 'claude_code' })}>
                {t('instances.claudeSessions')}
              </Button>
            )}
            <Button icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>
              {t('workspace.clientSettings')}
            </Button>
          </>
        }
      />
      {sessions ? (
        <Sessions />
      ) : (
        <>
          <div>
            <Segmented
              value={clientKind || 'all'}
              onChange={(value) => update({ client: value === 'all' ? null : String(value) })}
              options={[
                { value: 'all', label: t('instances.allClients') },
                { value: 'claude_code', label: 'Claude Code' },
                { value: 'grok', label: 'Grok' },
              ]}
            />
          </div>
          <Instances
            clientKind={clientKind}
            embedded
            view={params.get('view') === 'history' ? 'history' : 'active'}
            onViewChange={(view) => update({ view: view === 'active' ? null : view })}
            onViewRequests={(id) => navigate(`/stats?instanceId=${encodeURIComponent(id)}`)}
          />
        </>
      )}
      <Drawer
        title={`Claude Code · ${t('workspace.clientSettings')}`}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        closable={{ 'aria-label': t('common.close') }}
        size={720}
        styles={{ body: { padding: '12px 24px 24px' } }}
      >
        <Tabs
          items={[
            {
              key: 'global-config',
              label: t('workspace.launchDefaults'),
              children: <GlobalConfigModal embedded />,
            },
            {
              key: 'terminal-tools',
              label: t('terminalTools.tabTitle'),
              children: <TerminalToolsPanel />,
            },
          ]}
        />
      </Drawer>
    </div>
  )
}
