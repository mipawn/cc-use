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

type PricingParseResult = {
  pricing: Record<string, ModelPricing>
  numericKeyTotal: number
  unresolvedNumericKeys: string[]

  // diagnostics
  totalItems?: number
  parsedItems?: number
  skippedNoName?: number
  skippedNoPricing?: number
  skippedNoPricingSamples?: string[]
}

// new-api QUOTA_PER_UNIT = 500000 (each $1 = 500000 quota)
const QUOTA_PER_UNIT = 500000

const DASH_LIKE = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE63\uFF0D]/g

export function normalizeNewApiModelName(name: unknown): string {
  let n = String(name ?? '').trim()
  if (!n) return n

  // Canonicalize unicode (important for dash-like characters)
  try {
    n = n.normalize('NFKC')
  } catch {
    // ignore
  }

  // Normalize separators early
  n = n.replace(DASH_LIKE, '-')

  // Common: namespace wrappers
  // e.g. "openai/gpt-4o" → "gpt-4o"
  if (n.includes('/')) n = n.split('/').pop() || n
  // e.g. "openai:gpt-4o" → "gpt-4o"
  if (n.includes(':')) n = n.split(':').pop() || n

  // Common: suffixes/annotations
  // e.g. "gpt-4o@2024" → "gpt-4o"
  if (n.includes('@')) n = n.split('@')[0] || n
  // e.g. "gpt-4o (vision)" → "gpt-4o"
  n = n.replace(/\s*\(.*?\)\s*/g, ' ').trim()
  if (n.includes(' ')) n = n.split(' ')[0] || n

  // Normalize separators/case
  n = n.toLowerCase().replace(/_/g, '-').replace(DASH_LIKE, '-').trim()

  // A few common aliases
  if (n === 'gpt4o') n = 'gpt-4o'
  if (n === 'gpt4o-mini') n = 'gpt-4o-mini'
  if (n === 'o1preview') n = 'o1-preview'

  return n
}

export function isModelAllowedForPricingSync(modelName: string): boolean {
  const m = normalizeNewApiModelName(modelName)
  const isClaude = m.startsWith('claude-')
  const isGpt = m.startsWith('gpt-')
  const isOFamily = /^o\d/.test(m) || m === 'o1' || m.startsWith('o1-') || m.startsWith('o3-')

  // App currently only cares about Claude + Codex(OpenAI) families.
  return isClaude || isGpt || isOFamily
}

/**
 * Sync model pricing from provider's /api/pricing endpoint
 */
export async function syncProviderPricing(providerId: string): Promise<PricingSyncResult> {
  const provider = await getProvider(providerId)
  if (!provider) {
    return { count: 0, error: 'Provider not found' }
  }

  console.log('[PricingSync] VERSION=2026-02-11-2')

  const isNewApiProvider = provider.walletBalanceType === 'newapi' || provider.usageType === 'newapi'
  if (!isNewApiProvider) {
    return { count: 0, error: 'Pricing sync is only supported for NewAPI providers' }
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
    console.log(`[PricingSync] Fetching: ${url} (provider=${provider.name})`)
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
    const topType = Array.isArray((data as any)?.data) ? 'data=array'
      : (data && typeof data === 'object' && (data as any).data && typeof (data as any).data === 'object')
        ? 'data=object'
        : typeof data
    console.log(`[PricingSync] Response received (${topType}), parsing pricing data...`)

    // Minimal debug for array responses (avoid dumping full payload)
    if (Array.isArray((data as any)?.data)) {
      const arr = (data as any).data as unknown[]
      const first = arr[0]
      if (first && typeof first === 'object') {
        const f = first as Record<string, unknown>
        const modelObj = (f as any).model
        const modelObjKeys = modelObj && typeof modelObj === 'object' && !Array.isArray(modelObj)
          ? Object.keys(modelObj as Record<string, unknown>).slice(0, 20)
          : []
        console.log(
          '[PricingSync] data[0] keys:',
          Object.keys(f).slice(0, 30),
          'model.keys:',
          modelObjKeys,
          'quota_type:',
          (f as any).quota_type,
        )
      } else {
        console.log('[PricingSync] data is array, first item is not an object')
      }
    }

    const parsed = parsePricingResponse(data)

    console.log(
      `[PricingSync] Parse stats: totalItems=${parsed.totalItems ?? 'n/a'}, parsedItems=${parsed.parsedItems ?? Object.keys(parsed.pricing).length}, skippedNoName=${parsed.skippedNoName ?? 0}, skippedNoPricing=${parsed.skippedNoPricing ?? 0}`,
    )
    if (parsed.skippedNoPricingSamples && parsed.skippedNoPricingSamples.length > 0) {
      console.log(
        `[PricingSync] Skipped (no pricing) sample: ${parsed.skippedNoPricingSamples.join(', ')}`,
      )
    }

    const normalizeModelName = normalizeNewApiModelName
    const isModelAllowed = isModelAllowedForPricingSync

    const rawEntries = Object.entries(parsed.pricing)
    const rawCount = rawEntries.length

    // quick visibility: show a few raw->normalized and whether they are allowed for this provider type
    const samplePairs = rawEntries
      .slice(0, 15)
      .map(([k]) => {
        const normalized = normalizeModelName(k)
        const allowed = normalized ? isModelAllowed(normalized) : false
        return normalized && normalized !== k
          ? `${k} -> ${normalized} (${allowed ? 'allowed' : 'blocked'})`
          : `${k} (${allowed ? 'allowed' : 'blocked'})`
      })
    if (samplePairs.length > 0) {
      console.log(`[PricingSync] Raw model sample: ${samplePairs.join(' | ')}`)
    }

    const supportedOnly: Record<string, ModelPricing> = {}
    for (const [modelName, p] of rawEntries) {
      const normalized = normalizeModelName(modelName)
      if (!normalized) continue
      if (isModelAllowed(normalized)) {
        supportedOnly[normalized] = p
      }
    }

    const pricingMap = supportedOnly
    const count = Object.keys(pricingMap).length

    if (parsed.unresolvedNumericKeys.length > 0) {
      console.warn(
        `[PricingSync] Warning: ${parsed.unresolvedNumericKeys.length}/${parsed.numericKeyTotal} numeric model ids could not be resolved to names (example: ${parsed.unresolvedNumericKeys
          .slice(0, 5)
          .join(', ')}).`,
      )
    }

    if (count === 0) {
      if (rawCount > 0) {
        const sample = rawEntries.slice(0, 10)
          .map(([k]) => {
            const normalized = normalizeModelName(k)
            const allowed = normalized ? isModelAllowed(normalized) : false
            const shown = normalized && normalized !== k ? `${k} -> ${normalized}` : String(k)
            return `${shown} (${allowed ? 'allowed' : 'blocked'})`
          })
          .join(', ')
        return {
          count: 0,
          error: `No allowed models found in pricing response (after normalization). Sample models: ${sample}`,
        }
      }
      if (parsed.numericKeyTotal > 0) {
        return {
          count: 0,
          error:
            'Pricing response did not include model names (only numeric ids). Sync aborted to avoid writing numeric model names.',
        }
      }
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

    const savedModels = Object.keys(pricingMap)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 20)
    console.log(
      `[PricingSync] Saved models (first ${savedModels.length}): ${savedModels.join(', ')}`,
    )
    console.log(
      `[PricingSync] Synced ${count}/${rawCount} allowed model prices for provider ${provider.name}`,
    )
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
function parsePricingResponse(data: unknown): PricingParseResult {
  const pricing: Record<string, ModelPricing> = {}
  let numericKeyTotal = 0
  const unresolvedNumericKeys: string[] = []

  let totalItems: number | undefined
  let parsedItems = 0
  let skippedNoName = 0
  let skippedNoPricing = 0
  const skippedNoPricingSamples: string[] = []

  const buildIdNameMap = (root: unknown): Record<string, string> => {
    const map: Record<string, string> = {}

    const tryConsumeModelsArray = (arr: unknown) => {
      if (!Array.isArray(arr)) return
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue
        const m = item as Record<string, unknown>
        const idVal = m.id ?? (m as any).model_id ?? (m as any).modelId
        const nameVal = m.model_name ?? (m as any).modelName ?? m.name ?? m.model
        if (idVal === undefined || idVal === null) continue
        if (typeof nameVal !== 'string') continue
        const name = nameVal.trim()
        if (!name) continue
        map[String(idVal)] = name
      }
    }

    const tryConsumeStringMap = (obj: unknown) => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) map[String(k)] = v.trim()
      }
    }

    if (root && typeof root === 'object') {
      const r = root as Record<string, unknown>

      // common: { models: [...] } or { data: { models: [...] } }
      tryConsumeModelsArray((r as any).models)
      tryConsumeModelsArray((r as any).model_list)
      tryConsumeModelsArray((r as any).modelList)

      const d = (r as any).data
      if (d && typeof d === 'object') {
        tryConsumeModelsArray((d as any).models)
        tryConsumeModelsArray((d as any).model_list)
        tryConsumeModelsArray((d as any).modelList)
        // sometimes nested: { data: { data: {...}, models: [...] } }
        const dd = (d as any).data
        if (dd && typeof dd === 'object') {
          tryConsumeModelsArray((dd as any).models)
          tryConsumeModelsArray((dd as any).model_list)
          tryConsumeModelsArray((dd as any).modelList)
        }
      }

      // common: { model_map: { "1": "gpt-4o", ... } }
      tryConsumeStringMap((r as any).model_map)
      tryConsumeStringMap((r as any).modelMap)
      if (d && typeof d === 'object') {
        tryConsumeStringMap((d as any).model_map)
        tryConsumeStringMap((d as any).modelMap)
      }
    }

    return map
  }

  const extractNameFromModel = (m: Record<string, unknown>): string | null => {
    const pick = (val: unknown): string | null => {
      if (typeof val === 'string') {
        const s = val.trim()
        return s ? s : null
      }
      return null
    }

    return (
      pick(m.model_name) ||
      pick((m as any).modelName) ||
      pick(m.display_name) ||
      pick((m as any).displayName) ||
      pick(m.name) ||
      pick(m.model) ||
      (() => {
        const modelObj = m.model
        if (!modelObj || typeof modelObj !== 'object') return null
        const o = modelObj as Record<string, unknown>
        return (
          pick(o.model_name) ||
          pick((o as any).modelName) ||
          pick(o.display_name) ||
          pick((o as any).displayName) ||
          pick(o.name) ||
          pick(o.model)
        )
      })() ||
      (() => {
        const infoObj = (m as any).info
        if (!infoObj || typeof infoObj !== 'object') return null
        const o = infoObj as Record<string, unknown>
        return pick(o.model_name) || pick(o.name) || pick(o.model)
      })()
    )
  }

  // new-api responses vary:
  // - { data: { "gpt-4o": {...}, ... } }
  // - { success: true, data: { ... } }
  // - { success: true, data: [ { model_name: "gpt-4o", ... }, ... ] }
  // - sometimes direct map
  let models: unknown = null
  const idNameMap = buildIdNameMap(data)
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    const maybeData = obj.data

    if (Array.isArray(maybeData)) {
      models = maybeData
    } else if (maybeData && typeof maybeData === 'object') {
      // sometimes { data: { data: [...] } }
      const nested = (maybeData as Record<string, unknown>).data
      if (Array.isArray(nested)) {
        models = nested
      } else {
        models = maybeData
      }
    } else if (!('success' in obj) && !('message' in obj)) {
      models = obj
    }
  }

  if (Array.isArray(models)) {
    totalItems = models.length
    for (const item of models) {
      if (!item || typeof item !== 'object') continue
      const m = item as Record<string, unknown>
      let modelName = extractNameFromModel(m)
      const idVal = (m as any).id ?? (m as any).model_id ?? (m as any).modelId

      if (!modelName && idVal !== undefined && idVal !== null) {
        const idStr = String(idVal)
        if (/^\d+$/.test(idStr)) numericKeyTotal += 1
        modelName = idNameMap[idStr] ?? null
        if (!modelName && /^\d+$/.test(idStr)) unresolvedNumericKeys.push(idStr)
      }
      if (!modelName) {
        skippedNoName += 1
        continue
      }
      if (/^\d+$/.test(modelName)) continue
      const p = convertModelPricing(m)
      if (p) {
        pricing[modelName] = p
        parsedItems += 1
      } else {
        skippedNoPricing += 1
        if (skippedNoPricingSamples.length < 10) skippedNoPricingSamples.push(modelName)
      }
    }
    return {
      pricing,
      numericKeyTotal,
      unresolvedNumericKeys,
      totalItems,
      parsedItems,
      skippedNoName,
      skippedNoPricing,
      skippedNoPricingSamples,
    }
  }

  if (models && typeof models === 'object') {
    for (const [rawKey, modelData] of Object.entries(models as Record<string, unknown>)) {
      if (!modelData || typeof modelData !== 'object') continue
      const m = modelData as Record<string, unknown>

      const keyIsNumeric = /^\d+$/.test(rawKey)
      const extracted = extractNameFromModel(m)
      let modelName: string | null = null
      if (keyIsNumeric) {
        numericKeyTotal += 1
        modelName = extracted ?? idNameMap[rawKey] ?? null
        if (!modelName) {
          const idVal = (m as any).id ?? (m as any).model_id ?? (m as any).modelId ?? (m as any).model
          if (idVal !== undefined && idVal !== null) modelName = idNameMap[String(idVal)] ?? null
        }
      } else {
        modelName = extracted ?? rawKey
      }

      // If we still can't resolve a non-numeric model name, skip.
      if (!modelName) {
        if (keyIsNumeric) unresolvedNumericKeys.push(rawKey)
        continue
      }
      if (/^\d+$/.test(modelName)) continue

      const p = convertModelPricing(m)
      if (p && modelName) {
        pricing[modelName] = p
        parsedItems += 1
      } else {
        skippedNoPricing += 1
        if (skippedNoPricingSamples.length < 10) skippedNoPricingSamples.push(modelName)
      }
    }
  }

  return {
    pricing,
    numericKeyTotal,
    unresolvedNumericKeys,
    parsedItems,
    skippedNoName,
    skippedNoPricing,
    skippedNoPricingSamples,
  }
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
  const quotaType =
    toNumber((m as any).quota_type) ??
    toNumber((m as any).quotaType) ??
    toNumber(((m as any).model as any)?.quota_type) ??
    toNumber(((m as any).model as any)?.quotaType) ??
    0

  const modelObj = (m as any).model
  const pricingObj = (m as any).pricing ?? (m as any).prices ?? (m as any).price

  const pickNumber = (...vals: unknown[]): number | null => {
    for (const v of vals) {
      const n = toNumber(v)
      if (n !== null) return n
    }
    return null
  }

  // Heuristic: NewAPI variants return either
  // - quota per 1K tokens (needs QUOTA_PER_UNIT conversion)
  // - USD per 1K tokens
  // - USD per 1M tokens
  const interpretPricePerMillion = (v: number): number => {
    if (!isFinite(v) || v < 0) return v
    if (v <= 1) return v * 1000 // assume USD per 1K
    if (v <= 200) return v // assume USD per 1M
    return (v * 1000) / QUOTA_PER_UNIT // assume quota per 1K
  }

  if (quotaType === 1) {
    // Price-based
    // new-api variants may use: model_price/prompt_price/input_price, completion_price/output_price
    const modelPrice = pickNumber(
      m.model_price,
      (m as any).prompt_price,
      (m as any).promptPrice,
      (m as any).input_price,
      (m as any).inputPrice,
      (m as any).price,
      pricingObj?.model_price,
      pricingObj?.prompt_price,
      pricingObj?.input_price,
      pricingObj?.price,
      modelObj?.model_price,
      modelObj?.prompt_price,
      modelObj?.input_price,
    )
    const completionPrice = pickNumber(
      m.completion_price,
      (m as any).completionPrice,
      (m as any).output_price,
      (m as any).outputPrice,
      pricingObj?.completion_price,
      pricingObj?.output_price,
      modelObj?.completion_price,
      modelObj?.output_price,
    )

    if (modelPrice === null) return null

    const inputPerMillion = interpretPricePerMillion(modelPrice)
    const outputPerMillion = completionPrice !== null
      ? interpretPricePerMillion(completionPrice)
      : inputPerMillion

    const pricing: ModelPricing = {
      input: roundTo6(inputPerMillion),
      output: roundTo6(outputPerMillion),
    }

    // Cache pricing if available
    const cachePrice = pickNumber(
      m.cache_price,
      (m as any).cache_read_price,
      (m as any).cacheReadPrice,
      (m as any).cache_price_read,
      (m as any).cachePrice,
      pricingObj?.cache_price,
      pricingObj?.cache_read_price,
      modelObj?.cache_price,
      modelObj?.cache_read_price,
    )
    if (cachePrice !== null) {
      pricing.cacheRead = roundTo6(interpretPricePerMillion(cachePrice))
    }

    return pricing
  } else {
    // Ratio-based (default)
    const modelRatio = pickNumber(
      m.model_ratio,
      (m as any).prompt_ratio,
      (m as any).promptRatio,
      (m as any).input_ratio,
      (m as any).inputRatio,
      (m as any).ratio,
      pricingObj?.model_ratio,
      pricingObj?.prompt_ratio,
      pricingObj?.input_ratio,
      pricingObj?.ratio,
      modelObj?.model_ratio,
      modelObj?.prompt_ratio,
      modelObj?.input_ratio,
    )
    if (modelRatio === null) return null

    const completionRatio = pickNumber(
      m.completion_ratio,
      (m as any).completionRatio,
      (m as any).output_ratio,
      (m as any).outputRatio,
      pricingObj?.completion_ratio,
      pricingObj?.output_ratio,
      modelObj?.completion_ratio,
      modelObj?.output_ratio,
    ) ?? 1

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
