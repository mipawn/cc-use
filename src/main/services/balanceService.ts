import { get } from 'lodash-es'
import { eq } from 'drizzle-orm'
import { getDatabase } from '../database'
import { providers } from '../database/schema'
import { getProvider } from './providerService'
import { getAvailableApiKeys } from './apiKeyService'
import type { Provider } from '@shared/types'

interface BalanceResult {
  balance: number | null
  total: number | null
  used: number | null
  unlimited: boolean
  error: string | null
}

const UNLIMITED_THRESHOLD = 99999999

export async function refreshBalance(providerId: string): Promise<BalanceResult> {
  const provider = await getProvider(providerId)
  if (!provider) {
    return { balance: null, total: null, used: null, unlimited: false, error: 'Provider not found' }
  }

  if (provider.walletBalanceType === 'none') {
    return { balance: null, total: null, used: null, unlimited: false, error: 'Balance checking not configured' }
  }

  try {
    let result: BalanceResult = { balance: null, total: null, used: null, unlimited: false, error: null }

    if (provider.walletBalanceType === 'newapi') {
      result = await fetchNewApiBalance(provider)
    } else if (provider.walletBalanceType === 'custom') {
      const balance = await fetchCustomBalance(provider)
      result = { balance, total: null, used: null, unlimited: false, error: null }
    }

    if (result.balance !== null) {
      const db = getDatabase()
      const now = new Date().toISOString()
      await db
        .update(providers)
        .set({
          cachedWalletBalance: result.balance,
          lastBalanceCheckedAt: now,
        })
        .where(eq(providers.id, providerId))
    }

    return result
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return { balance: null, total: null, used: null, unlimited: false, error: errorMessage }
  }
}

async function fetchNewApiBalance(provider: Provider): Promise<BalanceResult> {
  const baseUrl = provider.baseUrl.replace(/\/$/, '')

  // Strategy 1: If provider has access token + userId, use /api/user/self for account-level balance
  if (provider.token && provider.walletBalanceUserId) {
    console.log('[Balance] Trying /api/user/self with access token and userId=%s...', provider.walletBalanceUserId)
    try {
      const result = await fetchNewApiBalanceViaUserApi(baseUrl, provider.token, provider.walletBalanceUserId)
      if (result) return result
      console.log('[Balance] /api/user/self returned null, falling back to billing API')
    } catch (e) {
      console.log('[Balance] /api/user/self failed, falling back to billing API:', e)
    }
  }

  // Strategy 2: Fall back to /dashboard/billing/* endpoints using API key
  const apiKeys = await getAvailableApiKeys(provider.id)
  if (apiKeys.length === 0) {
    throw new Error('No available API keys')
  }

  const firstKey = apiKeys[0]
  return fetchNewApiBalanceViaBillingApi(baseUrl, firstKey.value)
}

async function fetchNewApiBalanceViaUserApi(baseUrl: string, accessToken: string, userId: string): Promise<BalanceResult | null> {
  const url = `${baseUrl}/api/user/self`
  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `${accessToken}`,
      'New-Api-User': userId,
      'Content-Type': 'application/json',
    },
  })

  console.log('[Balance] /api/user/self status:', resp.status)
  if (!resp.ok) return null

  const data = await resp.json()
  if (!data.success || !data.data) return null

  const user = data.data
  console.log('[Balance] /api/user/self response: quota=%d, used_quota=%d', user.quota, user.used_quota)

  const remainQuota = typeof user.quota === 'number' ? user.quota : 0
  const usedQuota = typeof user.used_quota === 'number' ? user.used_quota : 0
  const totalQuota = remainQuota + usedQuota

  // NewAPI default QuotaPerUnit = 500000 (quota points per $1 USD)
  const QUOTA_PER_UNIT = 500000
  const remaining = remainQuota / QUOTA_PER_UNIT
  const used = usedQuota / QUOTA_PER_UNIT
  const total = totalQuota / QUOTA_PER_UNIT

  console.log(`[Balance] remaining=$${remaining.toFixed(2)}, used=$${used.toFixed(2)}, total=$${total.toFixed(2)}`)

  return {
    balance: Math.round(remaining * 100) / 100,
    total: Math.round(total * 100) / 100,
    used: Math.round(used * 100) / 100,
    unlimited: false,
    error: null,
  }
}

async function fetchNewApiBalanceViaBillingApi(baseUrl: string, apiKey: string): Promise<BalanceResult> {
  const authHeaders = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }

  const subscriptionUrl = `${baseUrl}/dashboard/billing/subscription`
  const subscriptionResp = await fetch(subscriptionUrl, { method: 'GET', headers: authHeaders })

  if (!subscriptionResp.ok) {
    throw new Error(`Subscription HTTP ${subscriptionResp.status}: ${subscriptionResp.statusText}`)
  }

  const subscriptionData = await subscriptionResp.json()
  console.log('[Balance] subscription response:', JSON.stringify(subscriptionData))

  const hardLimit = parseFloat(String(
    subscriptionData.hard_limit_usd ?? subscriptionData.system_hard_limit_usd ?? 0
  ))

  const usageUrl = `${baseUrl}/dashboard/billing/usage`
  const usageResp = await fetch(usageUrl, { method: 'GET', headers: authHeaders })

  if (!usageResp.ok) {
    throw new Error(`Usage HTTP ${usageResp.status}: ${usageResp.statusText}`)
  }

  const usageData = await usageResp.json()
  console.log('[Balance] usage response:', JSON.stringify(usageData))

  const rawUsage = parseFloat(String(usageData.total_usage ?? 0))

  // Detect unit: if total_usage > hardLimit and hardLimit is a reasonable value,
  // then total_usage is likely in cents (OpenAI standard). Otherwise it's already in dollars.
  const totalUsage = (hardLimit > 0 && hardLimit < UNLIMITED_THRESHOLD && rawUsage > hardLimit * 2)
    ? rawUsage / 100
    : rawUsage

  const unlimited = hardLimit >= UNLIMITED_THRESHOLD

  let balance: number
  let total: number | null
  if (unlimited) {
    balance = totalUsage
    total = null
  } else {
    balance = hardLimit - totalUsage
    total = Math.round(hardLimit * 100) / 100
  }

  console.log(`[Balance] hardLimit=$${hardLimit}, totalUsage=$${totalUsage}, unlimited=${unlimited}, balance=$${balance}`)

  if (isNaN(balance)) {
    throw new Error('Invalid balance response format')
  }

  return {
    balance: Math.round(balance * 100) / 100,
    total,
    used: Math.round(totalUsage * 100) / 100,
    unlimited,
    error: null,
  }
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
  const rawBalance = get(data, provider.walletBalancePath)

  const balance = typeof rawBalance === 'number' ? rawBalance : parseFloat(String(rawBalance))
  if (isNaN(balance)) {
    throw new Error(`Invalid balance value at path: ${provider.walletBalancePath}`)
  }

  return balance
}
