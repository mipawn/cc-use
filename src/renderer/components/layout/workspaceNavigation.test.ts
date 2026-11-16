import { describe, expect, it } from 'vitest'
import { legacyWorkspaceTarget } from './workspaceNavigation'

describe('legacy client navigation', () => {
  it.each([
    ['/claude-code', '/instances?client=claude_code'],
    ['/grok-build', '/instances?client=grok'],
    ['/codex', '/desktop?client=codex'],
    ['/claude-desktop', '/desktop?client=claude_desktop'],
  ])('redirects %s to the unified destination', (old, target) => {
    expect(legacyWorkspaceTarget(old)).toBe(target)
  })
  it('retains public context, drops credentials and does not retain a project-launch tab', () => {
    const target = legacyWorkspaceTarget(
      '/claude-code',
      '?providerId=p1&instanceId=i1&sessionToken=private&token=private&projectId=p2&tab=projects&view=sessions',
    )
    expect(target).toContain('providerId=p1')
    expect(target).toContain('instanceId=i1')
    expect(target).toContain('view=sessions')
    expect(target).not.toMatch(/private|projectId|tab=/)
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
      client: 'codex',
    })
  })
  it('does not invent Grok session history', () => {
    expect(legacyWorkspaceTarget('/grok-build', '?view=sessions')).toBe('/instances?client=grok')
  })
})
