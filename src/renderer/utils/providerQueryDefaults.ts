import type { ProviderPreset } from '@shared/types'

/** The request a parse rule sends when the provider has not written its own. */
export interface QueryRequestDefault {
  url: string
  headers: string
  path: string
}

const EMPTY: QueryRequestDefault = { url: '', headers: '', path: '' }

/**
 * The request a balance rule sends by default.
 *
 * Read from the catalogue rather than re-typed here: a preset that queries
 * already carries its whole request, so the dialog and the daemon agree by
 * construction instead of by two lists staying in step.
 *
 * `none` and `custom` have no default to offer — one sends nothing, the other
 * is the user's own definition — so they yield an empty request.
 */
export function balanceRequestForRule(
  rule: string,
  presets: ProviderPreset[],
): QueryRequestDefault {
  const preset = presets.find((item) => item.walletBalanceType === rule)
  if (!preset) return EMPTY
  return {
    url: preset.walletBalanceUrl ?? '',
    headers: preset.walletBalanceHeaders ?? '',
    path: '',
  }
}

/** The request a usage rule sends by default. */
export function usageRequestForRule(rule: string, presets: ProviderPreset[]): QueryRequestDefault {
  const preset = presets.find((item) => item.usageType === rule)
  if (!preset) return EMPTY
  return {
    url: preset.usageUrl ?? '',
    headers: preset.usageHeaders ?? '',
    path: '',
  }
}

/** Rules that answer without sending a request of their own. */
export function ruleHasNoRequest(rule: string): boolean {
  return rule === 'none' || rule === 'opencode-go'
}
