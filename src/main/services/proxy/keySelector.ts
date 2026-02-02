import { getAvailableApiKeys, markKeyExhausted } from '../apiKeyService'
import type { ApiKey } from '@shared/types'

export interface KeySelectionResult {
  key: ApiKey | null
  remainingKeys: ApiKey[]
}

export async function selectKey(providerId: string): Promise<KeySelectionResult> {
  const keys = await getAvailableApiKeys(providerId)

  if (keys.length === 0) {
    return { key: null, remainingKeys: [] }
  }

  // Keys are already sorted by priority (ascending)
  const [selectedKey, ...remainingKeys] = keys

  return { key: selectedKey, remainingKeys }
}

export async function handleKeyFailure(
  keyId: string,
  providerId: string
): Promise<KeySelectionResult> {
  // Mark the current key as exhausted
  await markKeyExhausted(keyId)

  // Get the next available key
  return selectKey(providerId)
}

export function isRetryableError(statusCode: number): boolean {
  // 401 - Unauthorized (invalid key)
  // 402 - Payment Required (quota exceeded)
  // 429 - Too Many Requests (rate limited)
  return [401, 402, 429].includes(statusCode)
}
