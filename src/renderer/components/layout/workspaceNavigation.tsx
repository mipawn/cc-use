import type { ReactNode } from 'react'
import type { ClientKind } from '@shared/types'
import ClientIcon from '../common/ClientIcon'

const SAFE_OBSERVATION_PARAMS = [
  'providerId',
  'apiKeyId',
  'instanceId',
  'startDate',
  'endDate',
  'outcome',
  'population',
  'requestId',
  'requestDate',
  'timeRange',
  'page',
  'pageSize',
] as const

export function legacyWorkspaceTarget(pathname: string, search = ''): string {
  const source = new URLSearchParams(search)
  const params = new URLSearchParams()
  for (const key of SAFE_OBSERVATION_PARAMS) {
    const value = source.get(key)
    if (value) params.set(key, value)
  }

  let destination: string | null = null
  if (pathname === '/claude-code') {
    destination = '/clients/claude-code'
    if (source.get('view') === 'sessions') params.set('tab', 'sessions')
    else if (source.get('view') === 'history') params.set('tab', 'instances')
  } else if (pathname === '/grok-build') {
    destination = '/clients/grok'
    if (source.get('view') === 'history') params.set('tab', 'instances')
  } else if (pathname === '/codex') {
    destination = '/clients/codex'
  } else if (pathname === '/claude-desktop') {
    destination = '/clients/claude-desktop'
  } else if (pathname === '/instances') {
    const client = source.get('client')
    destination = client === 'grok' ? '/clients/grok' : '/clients/claude-code'
    params.set('tab', source.get('view') === 'sessions' && client !== 'grok' ? 'sessions' : 'instances')
  } else if (pathname === '/desktop') {
    destination =
      source.get('client') === 'claude_desktop' ? '/clients/claude-desktop' : '/clients/codex'
  }

  if (!destination) return '/'
  const qs = params.toString()
  return qs ? `${destination}?${qs}` : destination
}

export const clientWorkspaces = [
  {
    path: '/clients/claude-code',
    kind: 'claude_code',
    name: 'Claude Code',
    icon: <ClientIcon kind='claude_code' />,
    description: 'workspace.claudeCodeDescription',
  },
  {
    path: '/clients/codex',
    kind: 'codex',
    name: 'Codex Desktop',
    icon: <ClientIcon kind='codex' />,
    description: 'workspace.codexDescription',
  },
  {
    path: '/clients/claude-desktop',
    kind: 'claude_desktop',
    name: 'Claude Desktop',
    icon: <ClientIcon kind='claude_desktop' />,
    description: 'workspace.desktopDescription',
  },
  {
    path: '/clients/grok',
    kind: 'grok',
    name: 'Grok Build',
    icon: <ClientIcon kind='grok' />,
    description: 'workspace.grokDescription',
  },
] satisfies {
  path: string
  kind: ClientKind
  name: string
  icon: ReactNode
  description: string
}[]
