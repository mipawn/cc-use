import { get } from 'lodash-es'
import { eq } from 'drizzle-orm'
import { getDatabase } from '../database'
import { providers } from '../database/schema'
import { getProvider } from './providerService'
import { getAvailableApiKeys } from './apiKeyService'
import type { Provider, UsageData } from '@shared/types'

interface UsageResult {
  usage: UsageData | null
  error: string | null
}

export async function refreshUsage(providerId: string): Promise<UsageResult> {
  const provider = await getProvider(providerId)
  if (!provider) {
    return { usage: null, error: 'Provider not found' }
  }

  if (provider.usageType === 'none') {
    return { usage: null, error: 'Usage checking not configured' }
  }

  try {
    let usage: UsageData | null = null

    if (provider.usageType === 'newapi') {
      usage = await fetchNewApiUsage(provider)
    } else if (provider.usageType === 'custom') {
      usage = await fetchCustomUsage(provider)
    }

    if (usage !== null) {
      const db = getDatabase()
      const now = new Date().toISOString()
      await db
        .update(providers)
        .set({
          cachedUsage: JSON.stringify(usage),
          lastUsageCheckedAt: now,
        })
        .where(eq(providers.id, providerId))
    }

    return { usage, error: null }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { usage: null, error: errorMessage }
  }
}

async function fetchNewApiUsage(provider: Provider): Promise<UsageData | null> {
  const apiKeys = await getAvailableApiKeys(provider.id)
  const token = provider.token || (apiKeys.length > 0 ? apiKeys[0].value : null)

  if (!token) {
    throw new Error('No available token for usage query')
  }

  // NewAPI usage endpoint: /api/usage/token
  const url = `${provider.baseUrl.replace(/\/$/, '')}/api/usage/token`

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const data = await response.json()

  // NewAPI response format:
  // {
  //   "success": true,
  //   "data": {
  //     "total_granted": 100.00,
  //     "total_used": 30.50,
  //     "total_available": 69.50,
  //     "is_unlimited": false,
  //     "expire_time": 1735689600
  //   }
  // }
  const usageData = data.data || data

  const usage: UsageData = {
    total: usageData.total_granted ?? usageData.total,
    used: usageData.total_used ?? usageData.used,
    remaining: usageData.total_available ?? usageData.remaining ?? usageData.available,
    unit: usageData.unit ?? 'USD',
    isUnlimited: usageData.is_unlimited ?? usageData.isUnlimited ?? false,
  }

  if (usageData.expire_time) {
    usage.expireAt = new Date(usageData.expire_time * 1000).toISOString()
  } else if (usageData.expireAt) {
    usage.expireAt = usageData.expireAt
  }

  return usage
}

async function fetchCustomUsage(provider: Provider): Promise<UsageData | null> {
  if (!provider.usageUrl) {
    throw new Error('Custom usage URL not configured')
  }

  if (!provider.usagePath) {
    throw new Error('Custom usage path not configured')
  }

  let headers: Record<string, string> = {}
  if (provider.usageHeaders) {
    try {
      headers = JSON.parse(provider.usageHeaders)
    } catch {
      throw new Error('Invalid headers JSON format')
    }
  }

  const response = await fetch(provider.usageUrl, {
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
  const usageData = get(data, provider.usagePath)

  if (!usageData || typeof usageData !== 'object') {
    throw new Error(`Invalid usage data at path: ${provider.usagePath}`)
  }

  const usage: UsageData = {
    total: usageData.total ?? usageData.total_granted,
    used: usageData.used ?? usageData.total_used,
    remaining: usageData.remaining ?? usageData.total_available ?? usageData.available,
    unit: usageData.unit ?? 'USD',
    isUnlimited: usageData.is_unlimited ?? usageData.isUnlimited ?? false,
  }

  if (usageData.expire_time) {
    usage.expireAt = new Date(usageData.expire_time * 1000).toISOString()
  } else if (usageData.expireAt || usageData.expire_at) {
    usage.expireAt = usageData.expireAt || usageData.expire_at
  }

  return usage
}
