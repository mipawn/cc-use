import { expect, it } from 'vitest'
import { getRouteModelLabel } from './RoutePickerModal'

it('shows models and forwarding for the selected launchpad only', () => {
  const key = {
    config: { ANTHROPIC_MODEL: 'code-real' },
    modelMapping: JSON.stringify({
      version: 2,
      clients: {
        claude_code: { upstream: { mode: 'fixed', model: 'code-target' } },
        claude_desktop: {
          catalog: {
            mode: 'custom',
            models: [{ id: 'desktop-real', displayName: 'Desktop model' }],
          },
          upstream: { mode: 'fixed', model: 'desktop-target' },
        },
      },
    }),
  }
  expect(getRouteModelLabel(key, 'claude_code')).toBe('code-real → code-target')
  expect(getRouteModelLabel(key, 'claude_desktop')).toBe('Desktop model → desktop-target')
  expect(getRouteModelLabel(key, 'codex')).toBe('跟随供应商')
})
