import type { CliConfig } from '@shared/types'
import { CLAUDE_CODE_MODEL_ENV_KEYS } from './modelMapping'

export function readClaudeConfig(raw: string): { config: CliConfig; valid: boolean } {
  try {
    const config = JSON.parse(raw)
    return config && typeof config === 'object' && !Array.isArray(config)
      ? { config, valid: true }
      : { config: {}, valid: false }
  } catch {
    return { config: {}, valid: false }
  }
}

export function otherStartupConfig(raw: string): string {
  const { config } = readClaudeConfig(raw)
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(config).filter(
        ([key]) =>
          !CLAUDE_CODE_MODEL_ENV_KEYS.includes(key as (typeof CLAUDE_CODE_MODEL_ENV_KEYS)[number]),
      ),
    ),
    null,
    2,
  )
}

/** Other variables replace their own draft, while the model controls keep a
 * single authoritative copy. Full JSON pastes can update those controls too. */
export function mergeStartupConfig(current: string, draft: string): string | undefined {
  const parsed = readClaudeConfig(draft)
  if (!parsed.valid) return undefined
  const previous = readClaudeConfig(current).config
  const modelFields = Object.fromEntries(
    CLAUDE_CODE_MODEL_ENV_KEYS.filter((key) => key in previous).map((key) => [key, previous[key]]),
  )
  return JSON.stringify({ ...modelFields, ...parsed.config }, null, 2)
}
