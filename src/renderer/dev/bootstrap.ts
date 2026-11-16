import { installDevFixtureApi } from '../api'
import { createFixtureApi } from './fixtureApi'
import { createDiagnostics, parseScenario } from './fixtureSupport'
import { installIsolation } from './isolation'
import { isFixtureMode } from './mode'

/** No stores/components are imported here; bootstrap must finish before their evaluation. */
export function installFixturePreview() {
  if (!isFixtureMode) throw new Error('Fixture preview requires DEV and VITE_CC_USE_FIXTURE=1')
  const badge = document.createElement('aside')
  badge.id = 'cc-use-fixture-status'
  badge.setAttribute('role', 'status')
  badge.style.cssText =
    'position:fixed;right:8px;bottom:4px;z-index:10000;font:11px monospace;background:#193c2a;color:white;padding:3px 8px;border-radius:4px;max-width:80vw;pointer-events:none'
  badge.textContent = 'FIXTURE · 内存演示 / memory only'
  document.body.append(badge)
  const diagnostics = createDiagnostics((message) => {
    badge.setAttribute('role', 'alert')
    badge.style.background = '#a8071a'
    badge.textContent = message
  })
  installIsolation(window, diagnostics)
  const fixture = createFixtureApi({ scenario: parseScenario(window.location.search), diagnostics })
  installDevFixtureApi(fixture.api)
  Object.defineProperty(window, '__CC_USE_FIXTURE__', {
    configurable: true,
    value: {
      scenario: fixture.scenario,
      get violations() {
        return [...diagnostics.violations]
      },
      get calls() {
        return [...diagnostics.calls]
      },
      emit: fixture.emit,
    },
  })
  return fixture
}
