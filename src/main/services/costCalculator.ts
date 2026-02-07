/**
 * Cost Calculator Service
 * Calculates API request costs based on token usage and model pricing
 */

// Model pricing per million tokens (in USD)
export interface ModelPricing {
  input: number          // Input tokens cost per million
  output: number         // Output tokens cost per million
  cacheRead?: number     // Cache read tokens cost per million
  cacheCreation?: number // Cache creation tokens cost per million
}

// Model pricing table - prices per million tokens
const MODEL_PRICING: Record<string, ModelPricing> = {
  // Claude models
  'claude-sonnet-4-20250514': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-3-5-sonnet-20241022': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-3-5-sonnet-latest': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-3-5-sonnet-20240620': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-3-opus-20240229': { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-3-opus-latest': { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25, cacheRead: 0.03, cacheCreation: 0.3 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4, cacheRead: 0.08, cacheCreation: 1 },
  'claude-3-5-haiku-latest': { input: 0.8, output: 4, cacheRead: 0.08, cacheCreation: 1 },
  'claude-opus-4-20250514': { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-opus-4-0-20250514': { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },

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
  'o1': { input: 15, output: 60 },
  'o1-2024-12-17': { input: 15, output: 60 },
  'o1-preview': { input: 15, output: 60 },
  'o1-mini': { input: 3, output: 12 },
  'o1-mini-2024-09-12': { input: 3, output: 12 },
  'o3-mini': { input: 1.1, output: 4.4 },

  // DeepSeek models
  'deepseek-chat': { input: 0.14, output: 0.28, cacheRead: 0.014 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheRead: 0.055 },

  // Default fallback pricing (conservative estimate)
  'default': { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
}

// Get pricing for a model (with fallback)
export function getModelPricing(model: string): ModelPricing {
  // Try exact match first
  if (MODEL_PRICING[model]) {
    return MODEL_PRICING[model]
  }

  // Try prefix matching for versioned models
  const modelLower = model.toLowerCase()
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (modelLower.startsWith(key.toLowerCase()) || key.toLowerCase().startsWith(modelLower)) {
      return pricing
    }
  }

  // Return default pricing
  return MODEL_PRICING['default']
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
 * @param costMultiplier - Provider cost multiplier (default 1)
 * @returns Cost breakdown in USD
 */
export function calculateCost(
  model: string,
  usage: TokenUsage,
  costMultiplier: number = 1
): CostBreakdown {
  const pricing = getModelPricing(model)

  // Calculate costs (price is per million tokens)
  const inputCostUsd = (usage.inputTokens / 1_000_000) * pricing.input * costMultiplier
  const outputCostUsd = (usage.outputTokens / 1_000_000) * pricing.output * costMultiplier
  const cacheReadCostUsd = ((usage.cacheReadTokens || 0) / 1_000_000) * (pricing.cacheRead || 0) * costMultiplier
  const cacheCreationCostUsd = ((usage.cacheCreationTokens || 0) / 1_000_000) * (pricing.cacheCreation || 0) * costMultiplier

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
  return Object.keys(MODEL_PRICING).filter(k => k !== 'default')
}

// Check if a model is supported
export function isModelSupported(model: string): boolean {
  return model in MODEL_PRICING || getSupportedModels().some(m =>
    model.toLowerCase().startsWith(m.toLowerCase())
  )
}
