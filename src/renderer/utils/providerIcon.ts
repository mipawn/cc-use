import claudeIcon from '../assets/provider-icons/claude.svg'
import openaiIcon from '../assets/provider-icons/openai.svg'
import deepseekIcon from '../assets/provider-icons/deepseek.svg'
import newapiIcon from '../assets/provider-icons/newapi.svg'

/**
 * Every icon a stored `providers.icon` value can name, and where it lives.
 *
 * `codex`, `claude_code` and `claude_desktop` are aliases: rows written by
 * earlier versions store those labels, and they name a client rather than a
 * vendor, so they borrow that client's vendor mark.
 */
const ICON_SOURCES: Record<string, string> = {
  claude: claudeIcon,
  claude_code: claudeIcon,
  claude_desktop: claudeIcon,
  codex: openaiIcon,
  openai: openaiIcon,
  deepseek: deepseekIcon,
  newapi: newapiIcon,
}

/** The marks a user can choose in the editor, in display order. */
export const PROVIDER_ICON_CHOICES: { key: string; label: string; src: string }[] = [
  { key: 'claude', label: 'Claude', src: claudeIcon },
  { key: 'openai', label: 'OpenAI', src: openaiIcon },
  { key: 'deepseek', label: 'DeepSeek', src: deepseekIcon },
  { key: 'newapi', label: 'NewAPI', src: newapiIcon },
]

/**
 * Where to load a provider's mark from, or `null` when it has none.
 *
 * `null` is a real state, not a failure. A provider created from the blank
 * template stores the literal `custom`, which means "no mark chosen" — reading
 * it as a path produced a `file://custom` image that never loaded, which looks
 * like a broken app rather than an unmade choice.
 */
export function providerIconSrc(icon: string | null | undefined): string | null {
  const value = icon?.trim()
  if (!value) return null
  const known = ICON_SOURCES[value]
  if (known) return known
  if (value === 'custom') return null
  // Anything else came back from the icon uploader as a filesystem path.
  return value.startsWith('file://') ? value : `file://${value}`
}
