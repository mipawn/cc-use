import { describe, expect, it } from 'vitest'
import { legacyWorkspaceTarget } from './workspaceNavigation'

describe('legacy client navigation', () => {
  it.each([
    ['/claude-code', '/clients/claude-code'],
    ['/grok-build', '/clients/grok'],
    ['/codex', '/clients/codex'],
    ['/claude-desktop', '/clients/claude-desktop'],
    ['/instances', '/clients/claude-code?tab=instances'],
    ['/desktop', '/clients/codex'],
  ])('redirects %s to the dedicated client workspace', (old, target) => {
    expect(legacyWorkspaceTarget(old)).toBe(target)
  })

  it('routes legacy /instances and /desktop query parameters to the matching client page', () => {
    expect(legacyWorkspaceTarget('/instances', '?client=grok')).toBe('/clients/grok?tab=instances')
    expect(legacyWorkspaceTarget('/instances', '?client=claude_code&view=sessions')).toBe(
      '/clients/claude-code?tab=sessions',
    )
    expect(legacyWorkspaceTarget('/desktop', '?client=claude_desktop')).toBe(
      '/clients/claude-desktop',
    )
  })

  it('retains public context, drops credentials and maps sessions view to tab=sessions', () => {
    const target = legacyWorkspaceTarget(
      '/claude-code',
      '?providerId=p1&instanceId=i1&sessionToken=private&token=private&projectId=p2&tab=projects&view=sessions',
    )
    expect(target).toContain('providerId=p1')
    expect(target).toContain('instanceId=i1')
    expect(target).toContain('tab=sessions')
    expect(target).not.toMatch(/private|projectId|tab=projects/)
  })

  it('retains canonical observation dates and pagination without forwarding credentials', () => {
    const target = legacyWorkspaceTarget(
      '/codex',
      '?requestId=r1&requestDate=2026-11-15&timeRange=custom%3A2026-11-01%3A2026-11-15&page=3&pageSize=20&session_id=secret',
    )
    const query = new URLSearchParams(target.split('?')[1])
    expect(Object.fromEntries(query)).toEqual({
      requestId: 'r1',
      requestDate: '2026-11-15',
      timeRange: 'custom:2026-11-01:2026-11-15',
      page: '3',
      pageSize: '20',
    })
  })

  it('does not invent Grok session history', () => {
    expect(legacyWorkspaceTarget('/grok-build', '?view=sessions')).toBe('/clients/grok')
  })
})
