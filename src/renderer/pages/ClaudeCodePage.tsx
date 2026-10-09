/**
 * Claude Code 页面 — 进程级接入点
 *
 * 项目 / 实例 / 会话在主工作区，低频配置集中到客户端设置抽屉。
 */
import { useEffect, useState } from 'react'
import { usePageRefresh } from '../hooks/usePageRefresh'
import { Button, Drawer, Tabs } from 'antd'
import { SettingOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'
import Projects from './Projects'
import Instances from './Instances'
import Sessions from './Sessions'
import GlobalConfigModal from '../components/providers/GlobalConfigModal'
import TerminalToolsPanel from '../components/providers/TerminalToolsPanel'
import type { ClientKind } from '@shared/types'
import styles from './ClaudeCodePage.module.css'
import ClientIcon from '../components/common/ClientIcon'
import { clientWorkspaces } from '../components/layout/workspaceNavigation'

type CliWorkspaceKind = Extract<ClientKind, 'claude_code' | 'grok'>

interface ClaudeCodePageProps {
  clientKind?: CliWorkspaceKind
}

export default function ClaudeCodePage({ clientKind = 'claude_code' }: ClaudeCodePageProps) {
  const { t } = useTranslation()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const client = clientWorkspaces.find((item) => item.kind === clientKind)!

  const { providers, fetchProviders } = useProviderStore()
  const { fetchAllApiKeys } = useApiKeyStore()

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])
  useEffect(() => {
    if (providers.length > 0) fetchAllApiKeys(providers.map((p) => p.id))
  }, [providers, fetchAllApiKeys])

  // The embedded projects / instances / sessions tabs register their own
  // refreshes; this covers the shared provider and key data they sit on.
  usePageRefresh(fetchProviders)

  const items = [
    {
      key: 'projects',
      label: t('common.projects') || '项目',
      children: <Projects defaultCliType={clientKind} embedded />,
    },
    {
      key: 'instances',
      label: t('instances.title') || '实例',
      children: <Instances clientKind={clientKind} embedded />,
    },
    ...(clientKind === 'claude_code'
      ? [
          {
            key: 'sessions',
            label: t('sidebar.sessions'),
            children: <Sessions />,
          },
        ]
      : []),
  ]

  return (
    <div className={styles.container}>
      <div className={styles.workspaceHeader}>
        <div className={styles.workspaceIdentity}>
          <span className={styles.clientIcon}>
            <ClientIcon kind={clientKind} size={24} />
          </span>
          <div>
            <h2>{client.name}</h2>
            <p>{t(client.description)}</p>
          </div>
        </div>
        {clientKind === 'claude_code' && (
          <Button icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)}>
            {t('workspace.clientSettings')}
          </Button>
        )}
      </div>
      <Tabs defaultActiveKey='projects' items={items} className={styles.tabs} />
      {clientKind === 'claude_code' && (
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
      )}
    </div>
  )
}
