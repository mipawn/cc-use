import { get } from 'lodash-es'
import { eq } from 'drizzle-orm'
import { getDatabase } from '../database'
import { apiKeys } from '../database/schema'
import { getApiKey } from './apiKeyService'
import { getProvider } from './providerService'
import type { UsageData } from '@shared/types'

interface KeyUsageResult {
  usage: UsageData | null
  error: string | null
}

export async function refreshKeyUsage(keyId: string): Promise<KeyUsageResult> {
  const key = await getApiKey(keyId)
  if (!key) {
    return { usage: null, error: 'API key not found' }
  }

  const usageType = key.usageType || 'none'
  if (usageType === 'none') {
    return { usage: null, error: 'Usage checking not configured' }
  }

  const provider = await getProvider(key.providerId)
  if (!provider) {
    return { usage: null, error: 'Provider not found' }
  }

  try {
    let usage: UsageData | null = null

    if (usageType === 'newapi') {
      usage = await fetchNewApiKeyUsage(provider.baseUrl, key.value)
    } else if (usageType === 'custom') {
      usage = await fetchCustomKeyUsage(key, provider.baseUrl)
    }

    if (usage) {
      const db = getDatabase()
      const now = new Date().toISOString()
      await db
        .update(apiKeys)
        .set({
          cachedUsage: JSON.stringify(usage),
          lastUsageCheckedAt: now,
        })
        .where(eq(apiKeys.id, keyId))
    }

    return { usage, error: null }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { usage: null, error: errorMessage }
  }
}

async function fetchNewApiKeyUsage(baseUrl: string, keyValue: string): Promise<UsageData> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/usage/token/`

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${keyValue}`,
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const json = await response.json()
  console.log('[KeyUsage] /api/usage/token/ response:', JSON.stringify(json))

  const data = json.data ?? json

  const totalGranted = data.total_granted !== undefined ? parseFloat(String(data.total_granted)) : undefined
  const totalUsed = data.total_used !== undefined ? parseFloat(String(data.total_used)) : undefined
  const totalAvailable = data.total_available !== undefined ? parseFloat(String(data.total_available)) : undefined
  const isUnlimited = data.unlimited_quota === true
  const expireAt = data.expires_at
    ? new Date(data.expires_at * 1000).toISOString()
    : undefined

  console.log(`[KeyUsage] granted=${totalGranted}, used=${totalUsed}, available=${totalAvailable}, unlimited=${isUnlimited}`)

  return {
    total: totalGranted,
    used: totalUsed,
    remaining: totalAvailable,
    unit: 'USD',
    isUnlimited,
    expireAt,
  }
}

async function fetchCustomKeyUsage(
  key: { value: string; usageUrl: string | null; usagePath: string | null; usageHeaders: string | null },
  baseUrl: string
): Promise<UsageData> {
  if (!key.usageUrl) {
    throw new Error('Custom usage URL not configured')
  }
  if (!key.usagePath) {
    throw new Error('Custom usage path not configured')
  }

  // Variable substitution in URL
  const resolvedUrl = key.usageUrl
    .replace(/\{baseUrl\}/g, baseUrl.replace(/\/$/, ''))
    .replace(/\{key\}/g, key.value)

  // Variable substitution in headers
  let headers: Record<string, string> = {}
  if (key.usageHeaders) {
    try {
      const rawHeaders = key.usageHeaders
        .replace(/\{key\}/g, key.value)
        .replace(/\{baseUrl\}/g, baseUrl.replace(/\/$/, ''))
      headers = JSON.parse(rawHeaders)
    } catch {
      throw new Error('Invalid headers JSON format')
    }
  }

  const response = await fetch(resolvedUrl, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const data = await response.json()
  const value = get(data, key.usagePath)

  if (value === undefined || value === null) {
    throw new Error(`No value found at path: ${key.usagePath}`)
  }

  const numValue = parseFloat(String(value))
  return {
    remaining: isNaN(numValue) ? undefined : numValue,
    unit: 'USD',
  }
}
