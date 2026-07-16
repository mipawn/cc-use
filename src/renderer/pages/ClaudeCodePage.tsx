/**
 * Claude Code 页面 — 进程级接入点
 *
 * Tab 1: 项目 (Projects / Instances / Sessions)
 * Tab 2: 供应商密钥
 */
import { useEffect } from 'react'
import { Tabs } from 'antd'
import { useTranslation } from 'react-i18next'
import { useProviderStore } from '../stores/providerStore'
import { useApiKeyStore } from '../stores/apiKeyStore'
import Projects from './Projects'
import Instances from './Instances'
import Sessions from './Sessions'
import GlobalConfigModal from '../components/providers/GlobalConfigModal'
import type { ClientKind } from '@shared/types'
import styles from './ClaudeCodePage.module.css'

type CliWorkspaceKind = Extract<ClientKind, 'claude_code' | 'grok'>

interface ClaudeCodePageProps {
  clientKind?: CliWorkspaceKind
}

export default function ClaudeCodePage({ clientKind = 'claude_code' }: ClaudeCodePageProps) {
  const { t } = useTranslation()

  const { providers, fetchProviders } = useProviderStore()
  const { fetchAllApiKeys } = useApiKeyStore()

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])
  useEffect(() => {
    if (providers.length > 0) fetchAllApiKeys(providers.map((p) => p.id))
  }, [providers, fetchAllApiKeys])

  const items = [
    {
      key: 'projects',
      label: t('common.projects') || '项目',
      children: <Projects defaultCliType={clientKind} />,
    },
    {
      key: 'instances',
      label: t('instances.title') || '实例',
      children: <Instances />,
    },
    {
      key: 'sessions',
      label: '会话',
      children: <Sessions />,
    },
    ...(clientKind === 'claude_code'
      ? [
          {
            key: 'global-config',
            label: '全局配置',
            children: <GlobalConfigModal embedded />,
          },
        ]
      : []),
  ]

  return (
    <div className={styles.container}>
      <Tabs defaultActiveKey='projects' items={items} className={styles.tabs} />
    </div>
  )
}
