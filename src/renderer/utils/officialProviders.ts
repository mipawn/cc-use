import type { Provider } from '@shared/types'

const DEEPSEEK_API_HOST = 'api.deepseek.com'

export function isOfficialDeepSeekProvider(provider: Provider | null | undefined): boolean {
  if (!provider) return false

  try {
    return new URL(provider.baseUrl).hostname === DEEPSEEK_API_HOST
  } catch {
    return false
  }
}
