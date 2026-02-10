/**
 * Cost Calculator Service
 * Calculates API request costs based on token usage and model pricing
 */

import { eq } from 'drizzle-orm'
import { getDatabase } from '../database'
import { settings } from '../database/schema'

// Model pricing per million tokens (in USD)
export interface ModelPricing {
  input: number // Input tokens cost per million
  output: number // Output tokens cost per million
  cacheRead?: number // Cache read tokens cost per million
  cacheCreation?: number // Cache creation tokens cost per million
}

// Model pricing table - prices per million tokens
const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude 4.x models
  'claude-sonnet-4-20250514': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-sonnet-4-5-20250929': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-opus-4-20250514': { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-opus-4-0-20250514': { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4, cacheRead: 0.08, cacheCreation: 1 },
  // Claude 3.x models
  'claude-3-5-sonnet-20241022': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-3-5-sonnet-latest': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-3-5-sonnet-20240620': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-3-opus-20240229': { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-3-opus-latest': { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25, cacheRead: 0.03, cacheCreation: 0.3 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4, cacheRead: 0.08, cacheCreation: 1 },
  'claude-3-5-haiku-latest': { input: 0.8, output: 4, cacheRead: 0.08, cacheCreation: 1 },

  // OpenAI models
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-2024-11-20': { input: 2.5, output: 10 },
  'gpt-4o-2024-08-06': { input: 2.5, output: 10 },
  'gpt-4o-2024-05-13': { input: 5, output: 15 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o-mini-2024-07-18': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-4-turbo-2024-04-09': { input: 10, output: 30 },
  'gpt-4': { input: 30, output: 60 },
  'gpt-4-32k': { input: 60, output: 120 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'gpt-3.5-turbo-0125': { input: 0.5, output: 1.5 },
  o1: { input: 15, output: 60 },
  'o1-2024-12-17': { input: 15, output: 60 },
  'o1-preview': { input: 15, output: 60 },
  'o1-mini': { input: 3, output: 12 },
  'o1-mini-2024-09-12': { input: 3, output: 12 },
  'o3-mini': { input: 1.1, output: 4.4 },

  // DeepSeek models
  'deepseek-chat': { input: 0.14, output: 0.28, cacheRead: 0.014 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheRead: 0.055 },

  // Default fallback pricing (conservative estimate)
  default: { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
}

const SETTINGS_KEY = 'customModelPricing'

// In-memory cache for custom model pricing
let customPricingCache: Record<string, ModelPricing> | null = null

/**
 * Load custom model pricing from settings table (with in-memory cache)
 */
export async function loadCustomModelPricing(): Promise<Record<string, ModelPricing>> {
  if (customPricingCache !== null) {
    return customPricingCache
  }
  try {
    const db = getDatabase()
    const rows = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY))
    if (rows.length > 0 && rows[0].value) {
      customPricingCache = JSON.parse(rows[0].value) as Record<string, ModelPricing>
    } else {
      customPricingCache = {}
    }
  } catch {
    customPricingCache = {}
  }
  return customPricingCache
}

/**
 * Get custom model pricing (from cache or DB)
 */
export async function getCustomModelPricing(): Promise<Record<string, ModelPricing>> {
  return loadCustomModelPricing()
}

/**
 * Update custom model pricing in settings table and refresh cache
 */
export async function updateCustomModelPricing(
  pricing: Record<string, ModelPricing>,
): Promise<void> {
  const db = getDatabase()
  const value = JSON.stringify(pricing)
  const existing = await db.select().from(settings).where(eq(settings.key, SETTINGS_KEY))
  if (existing.length > 0) {
    await db.update(settings).set({ value }).where(eq(settings.key, SETTINGS_KEY))
  } else {
    await db.insert(settings).values({ key: SETTINGS_KEY, value })
  }
  customPricingCache = pricing
}

/**
 * Get default (hardcoded) model pricing table
 */
export function getDefaultModelPricing(): Record<string, ModelPricing> {
  return { ...MODEL_PRICING }
}

/**
 * Get all model pricing (custom merged over default, custom wins)
 */
export async function getAllModelPricing(): Promise<Record<string, ModelPricing>> {
  const custom = await loadCustomModelPricing()
  return { ...MODEL_PRICING, ...custom }
}

// Get pricing for a model (with fallback). Custom pricing takes priority.
export function getModelPricing(
  model: string,
  customPricing?: Record<string, ModelPricing>,
): ModelPricing {
  // Merge custom pricing over hardcoded
  const allPricing = customPricing ? { ...MODEL_PRICING, ...customPricing } : MODEL_PRICING

  // Try exact match first
  if (allPricing[model]) {
    return allPricing[model]
  }

  // Try prefix matching for versioned models
  const modelLower = model.toLowerCase()
  for (const [key, pricing] of Object.entries(allPricing)) {
    if (key === 'default') continue
    if (modelLower.startsWith(key.toLowerCase()) || key.toLowerCase().startsWith(modelLower)) {
      return pricing
    }
  }

  // Try keyword-based fuzzy matching for Claude models
  // Handles cases like transit stations returning non-standard model names
  const fuzzyMatch = fuzzyMatchClaudeModel(modelLower, allPricing)
  if (fuzzyMatch) {
    return fuzzyMatch
  }

  // Return default pricing
  return allPricing['default'] || MODEL_PRICING['default']
}

// Keyword-based fuzzy matching for Claude model variants
// e.g. "claude-opus-4-6" should match opus-4 pricing
function fuzzyMatchClaudeModel(
  model: string,
  allPricing: Record<string, ModelPricing>,
): ModelPricing | null {
  if (!model.includes('claude')) return null

  // Define keyword patterns in priority order (most specific first)
  const patterns: { keywords: string[]; candidates: string[] }[] = [
    { keywords: ['opus', '4'], candidates: ['claude-opus-4-20250514', 'claude-3-opus-20240229'] },
    { keywords: ['sonnet', '4'], candidates: ['claude-sonnet-4-20250514', 'claude-sonnet-4-5-20250929'] },
    { keywords: ['haiku', '4'], candidates: ['claude-haiku-4-5-20251001', 'claude-3-5-haiku-20241022'] },
    { keywords: ['opus', '3'], candidates: ['claude-3-opus-20240229'] },
    { keywords: ['sonnet', '3', '5'], candidates: ['claude-3-5-sonnet-20241022'] },
    { keywords: ['sonnet', '3'], candidates: ['claude-3-5-sonnet-20241022'] },
    { keywords: ['haiku', '3', '5'], candidates: ['claude-3-5-haiku-20241022'] },
    { keywords: ['haiku', '3'], candidates: ['claude-3-haiku-20240307'] },
    { keywords: ['opus'], candidates: ['claude-opus-4-20250514', 'claude-3-opus-20240229'] },
    { keywords: ['sonnet'], candidates: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022'] },
    { keywords: ['haiku'], candidates: ['claude-haiku-4-5-20251001', 'claude-3-5-haiku-20241022'] },
  ]

  for (const { keywords, candidates } of patterns) {
    if (keywords.every((kw) => model.includes(kw))) {
      for (const candidate of candidates) {
        if (allPricing[candidate]) {
          return allPricing[candidate]
        }
      }
    }
  }

  return null
}

// Token usage from API response
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

// Cost breakdown result
export interface CostBreakdown {
  inputCostUsd: number
  outputCostUsd: number
  cacheReadCostUsd: number
  cacheCreationCostUsd: number
  totalCostUsd: number
}

/**
 * Calculate cost for a request
 * @param model - Model name
 * @param usage - Token usage
 * @param costMultiplier - Key cost multiplier (default 1)
 * @param customPricing - Optional custom model pricing to merge over defaults
 * @returns Cost breakdown in USD
 */
export function calculateCost(
  model: string,
  usage: TokenUsage,
  costMultiplier: number = 1,
  customPricing?: Record<string, ModelPricing>,
): CostBreakdown {
  const pricing = getModelPricing(model, customPricing)

  // Calculate costs (price is per million tokens)
  const inputCostUsd = (usage.inputTokens / 1_000_000) * pricing.input * costMultiplier
  const outputCostUsd = (usage.outputTokens / 1_000_000) * pricing.output * costMultiplier
  const cacheReadCostUsd =
    ((usage.cacheReadTokens || 0) / 1_000_000) * (pricing.cacheRead || 0) * costMultiplier
  const cacheCreationCostUsd =
    ((usage.cacheCreationTokens || 0) / 1_000_000) * (pricing.cacheCreation || 0) * costMultiplier

  // Total cost
  const totalCostUsd = inputCostUsd + outputCostUsd + cacheReadCostUsd + cacheCreationCostUsd

  return {
    inputCostUsd: roundToSixDecimals(inputCostUsd),
    outputCostUsd: roundToSixDecimals(outputCostUsd),
    cacheReadCostUsd: roundToSixDecimals(cacheReadCostUsd),
    cacheCreationCostUsd: roundToSixDecimals(cacheCreationCostUsd),
    totalCostUsd: roundToSixDecimals(totalCostUsd),
  }
}

// Round to 6 decimal places to avoid floating point issues
function roundToSixDecimals(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

// Get all supported models
export function getSupportedModels(): string[] {
  return Object.keys(MODEL_PRICING).filter((k) => k !== 'default')
}

// Check if a model is supported
export function isModelSupported(model: string): boolean {
  return (
    model in MODEL_PRICING ||
    getSupportedModels().some((m) => model.toLowerCase().startsWith(m.toLowerCase()))
  )
}
