import type { Provider, ProviderPreset } from '@shared/types'

/** The two columns the daemon dispatches an account query on. */
type AccountStorage = Pick<Provider, 'walletBalanceType' | 'usageType'>

/**
 * How a provider answers "how much of this account is left".
 *
 * One question, one request, whichever service is behind it: DeepSeek reads a
 * balance, New API reads a quota, OpenCode Go reads metering periods. They are
 * the same shape of query, so they are one setting rather than two — which is
 * why `usageType` has no separate control in the editor.
 */
export const ACCOUNT_RULES = ['none', 'newapi', 'deepseek', 'opencode-go', 'custom'] as const
export type AccountRule = (typeof ACCOUNT_RULES)[number]

/** The request a rule sends when the provider has not written its own. */
export interface QueryRequestDefault {
  url: string
  headers: string
  path: string
}

const EMPTY: QueryRequestDefault = { url: '', headers: '', path: '' }

/**
 * A starting point for a hand-written account query.
 *
 * A template rather than a vendor default — there is no default to know — but
 * not blank either: it names the variables and the shape so the grammar is
 * visible without reading about it first.
 */
const CUSTOM_ACCOUNT_TEMPLATE: QueryRequestDefault = {
  url: '{baseUrl}/api/user/balance',
  headers: '{"Authorization": "Bearer {key}"}',
  path: 'data.balance',
}

/**
 * Which stored columns the rule and its request belong in.
 *
 * The two mechanisms predate this dialog and are still what the daemon
 * dispatches on, so the single choice is mapped onto them rather than
 * re-modelled underneath.
 */
export function accountStorageForRule(rule: AccountRule): AccountStorage {
  switch (rule) {
    case 'opencode-go':
      return { walletBalanceType: 'none', usageType: 'opencode-go' }
    case 'custom':
      return { walletBalanceType: 'custom', usageType: 'none' }
    case 'newapi':
    case 'deepseek':
      return { walletBalanceType: rule, usageType: 'none' }
    default:
      return { walletBalanceType: 'none', usageType: 'none' }
  }
}

/**
 * Which columns hold the rule's request.
 *
 * OpenCode Go's account query has always lived in the usage columns, and moving
 * it would rewrite stored rows for no gain the user can see.
 */
export function requestSlotForRule(rule: AccountRule): 'balance' | 'usage' {
  return rule === 'opencode-go' ? 'usage' : 'balance'
}

/**
 * The rule a stored provider — or a preset — was configured with.
 *
 * Both carry the same two columns, so the same reading serves the edit dialog
 * and the catalogue it seeds from.
 */
export function accountRuleOf(source: { walletBalanceType: string; usageType: string }): AccountRule {
  const balance = source.walletBalanceType as AccountRule
  if (balance !== 'none' && ACCOUNT_RULES.includes(balance)) {
    return balance
  }
  return source.usageType === 'opencode-go' ? 'opencode-go' : 'none'
}

/** The request a preset's own account query carries. */
export function accountRequestForPreset(preset: ProviderPreset): QueryRequestDefault {
  const rule = accountRuleOf(preset)
  if (rule === 'none') return EMPTY
  return requestSlotForRule(rule) === 'usage'
    ? { url: preset.usageUrl ?? '', headers: preset.usageHeaders ?? '', path: '' }
    : { url: preset.walletBalanceUrl ?? '', headers: preset.walletBalanceHeaders ?? '', path: '' }
}

/**
 * The request a rule sends by default.
 *
 * Read from the catalogue rather than re-typed here: a preset that queries
 * already carries its whole request, so the dialog and the daemon agree by
 * construction instead of by two lists staying in step.
 */
export function accountRequestForRule(
  rule: AccountRule,
  presets: ProviderPreset[],
): QueryRequestDefault {
  if (rule === 'none') return EMPTY
  if (rule === 'custom') return CUSTOM_ACCOUNT_TEMPLATE

  // A rule is named by whichever column its service uses: the balance columns
  // for a balance service, the usage columns for the one that reports periods.
  const preset = presets.find(
    (item) => item.walletBalanceType === rule || item.usageType === rule,
  )
  if (!preset) return EMPTY

  return requestSlotForRule(rule) === 'usage'
    ? { url: preset.usageUrl ?? '', headers: preset.usageHeaders ?? '', path: '' }
    : { url: preset.walletBalanceUrl ?? '', headers: preset.walletBalanceHeaders ?? '', path: '' }
}

/** Rules that answer without sending a request of their own. */
export function ruleHasNoRequest(rule: string): boolean {
  return rule === 'none'
}
