import type { ReactNode } from 'react'
import type { ClientKind } from '@shared/types'
import ClientIcon from '../common/ClientIcon'

// Shared by the sidebar and home page: each entry opens its own workspace.
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
