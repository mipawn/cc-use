/**
 * 客户端支持工具函数
 *
 * 3.2.0 以后客户端归属由密钥决定；供应商只提供 endpoint 等基础信息。
 */
import type { Provider, ApiKey, ClientKind } from '@shared/types'
import { normalizeClientKind } from '@shared/types'
import { isBuiltinDeepSeekProvider } from './builtinProviders'

export function getKeyClientTypes(apiKey: ApiKey): ClientKind[] {
  const normalized = (apiKey.types?.length ? apiKey.types : ['claude_code']).map((type) =>
    normalizeClientKind(type),
  )
  return Array.from(new Set(normalized))
}

export function getEffectiveKeyClients(provider: Provider, apiKey: ApiKey): ClientKind[] {
  const clientKinds = getKeyClientTypes(apiKey)
  return isBuiltinDeepSeekProvider(provider)
    ? clientKinds.filter((clientKind) => clientKind !== 'grok')
    : clientKinds
}

export function supportsKeyClient(
  provider: Provider,
  apiKey: ApiKey,
  clientKind: ClientKind,
): boolean {
  return getEffectiveKeyClients(provider, apiKey).includes(clientKind)
}
