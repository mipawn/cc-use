/**
 * Shared provider-icon resolver.
 *
 * The same `PRESET_ICON_MAP` was copy-pasted across Keys.tsx, Projects.tsx,
 * ProviderCard.tsx, ProviderModal.tsx, and QuickAddModal.tsx. Centralizing it
 * here so QuickAddModal (and any future caller) can resolve a preset `icon`
 * string to an actual imported asset without re-declaring the imports.
 *
 * Note: existing call sites still keep their own copies to avoid a large
 * no-op refactor in this pass; new code should import from here.
 */
import claudeIcon from '../../assets/provider-icons/claude.svg'
import openaiIcon from '../../assets/provider-icons/openai.svg'
import deepseekIcon from '../../assets/provider-icons/deepseek.svg'
import newapiIcon from '../../assets/provider-icons/newapi.svg'

/** Map of preset icon key -> imported asset URL. */
export const PRESET_ICON_MAP: Record<string, string> = {
  claude: claudeIcon,
  codex: openaiIcon,
  openai: openaiIcon,
  deepseek: deepseekIcon,
  newapi: newapiIcon,
  // 'custom' and unmapped keys fall back to the Claude icon below.
}

/**
 * Resolve a preset `icon` key (as stored on Provider / ProviderPreset) to an
 * `<img src>`-ready asset. Falls back to the Claude icon when the key is
 * unknown or the special 'custom' value, matching existing on-screen behavior.
 */
export function resolvePresetIcon(icon: string | null | undefined): string {
  if (icon && PRESET_ICON_MAP[icon]) {
    return PRESET_ICON_MAP[icon]
  }
  return PRESET_ICON_MAP.claude
}
