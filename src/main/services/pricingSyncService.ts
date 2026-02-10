import { eq } from 'drizzle-orm'
import { getDatabase } from '../database'
import { providers } from '../database/schema'
import { getProvider } from './providerService'
import { getAvailableApiKeys } from './apiKeyService'
import type { ModelPricing } from './costCalculator'

interface PricingSyncResult {
  count: number
  error: string | null
}

// new-api QUOTA_PER_UNIT = 500000 (each $1 = 500000 quota)
const QUOTA_PER_UNIT = 500000

/**
 * Sync model pricing from provider's /api/pricing endpoint
 */
export async function syncProviderPricing(providerId: string): Promise<PricingSyncResult> {
  const provider = await getProvider(providerId)
  if (!provider) {
    return { count: 0, error: 'Provider not found' }
  }

  const baseUrl = provider.baseUrl.replace(/\/$/, '')

  // Determine auth token: prefer provider.token, fallback to first API key
  let authToken: string | null = provider.token
  if (!authToken) {
    const apiKeys = await getAvailableApiKeys(providerId)
    if (apiKeys.length > 0) {
      authToken = apiKeys[0].value
    }
  }

  if (!authToken) {
    return { count: 0, error: 'No authentication token available' }
  }

  try {
    const url = `${baseUrl}/api/pricing`
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
    })

    if (!resp.ok) {
      return { count: 0, error: `HTTP ${resp.status}: ${resp.statusText}` }
    }

    const data = await resp.json()
    console.log('[PricingSync] Response received, parsing pricing data...')

    const pricingMap = parsePricingResponse(data)
    const count = Object.keys(pricingMap).length

    if (count === 0) {
      return { count: 0, error: 'No pricing data found in response' }
    }

    // Save to database
    const db = getDatabase()
    const now = new Date().toISOString()
    await db
      .update(providers)
      .set({
        cachedModelPricing: JSON.stringify(pricingMap),
        lastPricingSyncedAt: now,
      })
      .where(eq(providers.id, providerId))

    console.log(`[PricingSync] Synced ${count} model prices for provider ${provider.name}`)
    return { count, error: null }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error('[PricingSync] Failed:', errorMessage)
    return { count: 0, error: errorMessage }
  }
}

/**
 * Parse pricing response from new-api /api/pricing endpoint
 * Handles both ratio-based (quota_type=0) and price-based (quota_type=1) models
 */
function parsePricingResponse(data: unknown): Record<string, ModelPricing> {
  const result: Record<string, ModelPricing> = {}

  // The response is typically { data: { model_name: { ... }, ... } }
  // or directly { model_name: { ... }, ... }
  let models: Record<string, unknown> = {}

  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
      models = obj.data as Record<string, unknown>
    } else if (!obj.success && !obj.message) {
      // Direct model map
      models = obj as Record<string, unknown>
    } else if (obj.success && obj.data && typeof obj.data === 'object') {
      models = obj.data as Record<string, unknown>
    }
  }

  for (const [modelName, modelData] of Object.entries(models)) {
    if (!modelData || typeof modelData !== 'object') continue

    const m = modelData as Record<string, unknown>
    const pricing = convertModelPricing(m)
    if (pricing) {
      result[modelName] = pricing
    }
  }

  return result
}

/**
 * Convert a single model's pricing data to ModelPricing (USD per million tokens)
 *
 * ratio-based (quota_type=0):
 *   input = model_ratio × 2 (USD/M tokens)
 *   output = model_ratio × completion_ratio × 2 (USD/M tokens)
 *
 * price-based (quota_type=1):
 *   model_price is quota per 1K tokens
 *   price_per_million = model_price × 1000 / QUOTA_PER_UNIT
 */
function convertModelPricing(m: Record<string, unknown>): ModelPricing | null {
  const quotaType = typeof m.quota_type === 'number' ? m.quota_type : 0

  if (quotaType === 1) {
    // Price-based
    const modelPrice = toNumber(m.model_price)
    const completionPrice = toNumber(m.completion_price)

    if (modelPrice === null) return null

    const inputPerMillion = (modelPrice * 1000) / QUOTA_PER_UNIT
    const outputPerMillion = completionPrice !== null
      ? (completionPrice * 1000) / QUOTA_PER_UNIT
      : inputPerMillion

    const pricing: ModelPricing = {
      input: roundTo6(inputPerMillion),
      output: roundTo6(outputPerMillion),
    }

    // Cache pricing if available
    const cachePrice = toNumber(m.cache_price)
    if (cachePrice !== null) {
      pricing.cacheRead = roundTo6((cachePrice * 1000) / QUOTA_PER_UNIT)
    }

    return pricing
  } else {
    // Ratio-based (default)
    const modelRatio = toNumber(m.model_ratio)
    if (modelRatio === null) return null

    const completionRatio = toNumber(m.completion_ratio) ?? 1

    // ratio=1 → $2/M tokens (since QUOTA_PER_UNIT=500000, 1M tokens × ratio / QUOTA_PER_UNIT × 1000 = ratio × 2)
    const inputPerMillion = modelRatio * 2
    const outputPerMillion = modelRatio * completionRatio * 2

    const pricing: ModelPricing = {
      input: roundTo6(inputPerMillion),
      output: roundTo6(outputPerMillion),
    }

    return pricing
  }
}

function toNumber(val: unknown): number | null {
  if (typeof val === 'number' && !isNaN(val)) return val
  if (typeof val === 'string') {
    const n = parseFloat(val)
    if (!isNaN(n)) return n
  }
  return null
}

function roundTo6(val: number): number {
  return Math.round(val * 1_000_000) / 1_000_000
}
