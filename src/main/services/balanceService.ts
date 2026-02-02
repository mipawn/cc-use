import { get } from 'lodash-es'
import { eq } from 'drizzle-orm'
import { getDatabase } from '../database'
import { providers } from '../database/schema'
import { getProvider } from './providerService'
import { getAvailableApiKeys } from './apiKeyService'
import type { Provider } from '@shared/types'

interface BalanceResult {
  balance: number | null
  error: string | null
}

export async function refreshBalance(providerId: string): Promise<BalanceResult> {
  const provider = await getProvider(providerId)
  if (!provider) {
    return { balance: null, error: 'Provider not found' }
  }

  if (provider.walletBalanceType === 'none') {
    return { balance: null, error: 'Balance checking not configured' }
  }

  try {
    let balance: number | null = null

    if (provider.walletBalanceType === 'newapi') {
      balance = await fetchNewApiBalance(provider)
    } else if (provider.walletBalanceType === 'custom') {
      balance = await fetchCustomBalance(provider)
    }

    if (balance !== null) {
      const db = getDatabase()
      const now = new Date().toISOString()
      await db
        .update(providers)
        .set({
          cachedWalletBalance: balance,
          lastBalanceCheckedAt: now,
        })
        .where(eq(providers.id, providerId))
    }

    return { balance, error: null }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { balance: null, error: errorMessage }
  }
}

async function fetchNewApiBalance(provider: Provider): Promise<number | null> {
  const apiKeys = await getAvailableApiKeys(provider.id)
  if (apiKeys.length === 0) {
    throw new Error('No available API keys')
  }

  const firstKey = apiKeys[0]
  const url = `${provider.baseUrl.replace(/\/$/, '')}/dashboard/billing/usage`

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${firstKey.value}`,
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const data = await response.json()

  // NewAPI typically returns balance in data.total_available or similar
  // Adjust based on actual API response structure
  const balance = data.total_available ?? data.balance ?? data.data?.balance

  if (typeof balance !== 'number') {
    throw new Error('Invalid balance response format')
  }

  return balance
}

async function fetchCustomBalance(provider: Provider): Promise<number | null> {
  if (!provider.walletBalanceUrl) {
    throw new Error('Custom balance URL not configured')
  }

  if (!provider.walletBalancePath) {
    throw new Error('Custom balance path not configured')
  }

  let headers: Record<string, string> = {}
  if (provider.walletBalanceHeaders) {
    try {
      headers = JSON.parse(provider.walletBalanceHeaders)
    } catch {
      throw new Error('Invalid headers JSON format')
    }
  }

  const response = await fetch(provider.walletBalanceUrl, {
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
  const balance = get(data, provider.walletBalancePath)

  if (typeof balance !== 'number') {
    throw new Error(`Invalid balance value at path: ${provider.walletBalancePath}`)
  }

  return balance
}
