import type { ReactNode } from 'react'
import type { ClientKind } from '@shared/types'
import ClientIcon from '../common/ClientIcon'

// Kept as client metadata for secondary identities, not as top-level navigation.
export function legacyWorkspaceTarget(pathname: string, search = ''): string {
  const target: Record<string, [string, ClientKind]> = {
    '/claude-code': ['/instances', 'claude_code'],
    '/grok-build': ['/instances', 'grok'],
    '/codex': ['/desktop', 'codex'],
    '/claude-desktop': ['/desktop', 'claude_desktop'],
  }
  const entry = target[pathname]
  if (!entry) return '/'
  const source = new URLSearchParams(search)
  const params = new URLSearchParams()
  // Only public observation context survives. Never forward credentials or
  // obsolete project-launch parameters from a legacy URL.
  for (const key of [
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
  ]) {
    const value = source.get(key)
    if (value) params.set(key, value)
  }
  if (entry[1] === 'claude_code' && source.get('view') === 'sessions')
    params.set('view', 'sessions')
  if (entry[0] === '/instances' && source.get('view') === 'history') params.set('view', 'history')
  params.set('client', entry[1])
  return `${entry[0]}?${params}`
}

export const clientWorkspaces = [
  {
    path: '/claude-code',
    kind: 'claude_code',
    name: 'Claude Code',
    icon: <ClientIcon kind='claude_code' />,
    description: 'workspace.claudeCodeDescription',
  },
  {
    path: '/grok-build',
    kind: 'grok',
    name: 'Grok Build',
    icon: <ClientIcon kind='grok' />,
    description: 'workspace.grokDescription',
  },
  {
    path: '/codex',
    kind: 'codex',
    name: 'Codex Desktop',
    icon: <ClientIcon kind='codex' />,
    description: 'workspace.codexDescription',
  },
  {
    path: '/claude-desktop',
    kind: 'claude_desktop',
    name: 'Claude Desktop',
    icon: <ClientIcon kind='claude_desktop' />,
    description: 'workspace.desktopDescription',
  },
] satisfies {
  path: string
  kind: ClientKind
  name: string
  icon: ReactNode
  description: string
}[]
