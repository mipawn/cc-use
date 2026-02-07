/**
 * Request Log Service
 * Records and queries API request logs for cost tracking
 */

import { nanoid } from 'nanoid'
import { eq, sql, and, gte, lte, desc } from 'drizzle-orm'
import { getDatabase } from '../database'
import { requestLogs } from '../database/schema'
import type { CostBreakdown, TokenUsage } from './costCalculator'
import { calculateCost } from './costCalculator'

export interface CreateRequestLogInput {
  providerId: string | null
  apiKeyId: string | null
  projectId?: string | null
  sessionId?: string | null
  model: string | null
  requestModel?: string | null
  usage: TokenUsage
  costMultiplier?: number
  latencyMs?: number
  firstTokenMs?: number
  statusCode?: number
  errorMessage?: string | null
  isStreaming?: boolean
}

export interface RequestLog {
  id: string
  providerId: string | null
  apiKeyId: string | null
  projectId: string | null
  sessionId: string | null
  model: string | null
  requestModel: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  inputCostUsd: number
  outputCostUsd: number
  cacheReadCostUsd: number
  cacheCreationCostUsd: number
  totalCostUsd: number
  costMultiplier: number
  latencyMs: number | null
  firstTokenMs: number | null
  statusCode: number | null
  errorMessage: string | null
  isStreaming: boolean
  createdAt: string
}

/**
 * Create a new request log entry
 */
export async function createRequestLog(input: CreateRequestLogInput): Promise<RequestLog> {
  const db = getDatabase()
  const id = nanoid()
  const now = new Date().toISOString()
  const costMultiplier = input.costMultiplier || 1

  // Calculate costs
  const costs: CostBreakdown = input.model
    ? calculateCost(input.model, input.usage, costMultiplier)
    : {
        inputCostUsd: 0,
        outputCostUsd: 0,
        cacheReadCostUsd: 0,
        cacheCreationCostUsd: 0,
        totalCostUsd: 0,
      }

  const logData = {
    id,
    providerId: input.providerId,
    apiKeyId: input.apiKeyId,
    projectId: input.projectId || null,
    sessionId: input.sessionId || null,
    model: input.model,
    requestModel: input.requestModel || input.model,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cacheReadTokens: input.usage.cacheReadTokens || 0,
    cacheCreationTokens: input.usage.cacheCreationTokens || 0,
    inputCostUsd: costs.inputCostUsd,
    outputCostUsd: costs.outputCostUsd,
    cacheReadCostUsd: costs.cacheReadCostUsd,
    cacheCreationCostUsd: costs.cacheCreationCostUsd,
    totalCostUsd: costs.totalCostUsd,
    costMultiplier,
    latencyMs: input.latencyMs || null,
    firstTokenMs: input.firstTokenMs || null,
    statusCode: input.statusCode || null,
    errorMessage: input.errorMessage || null,
    isStreaming: input.isStreaming || false,
    createdAt: now,
  }

  await db.insert(requestLogs).values(logData)

  return logData
}

/**
 * Get cost statistics
 */
export interface CostStats {
  todayCost: number
  totalBalance: number // This will be calculated from providers
}

export async function getTodayCost(): Promise<number> {
  const db = getDatabase()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = today.toISOString()

  const result = await db
    .select({
      total: sql<number>`COALESCE(SUM(${requestLogs.totalCostUsd}), 0)`,
    })
    .from(requestLogs)
    .where(gte(requestLogs.createdAt, todayStr))

  return result[0]?.total || 0
}

export async function getTotalCost(): Promise<number> {
  const db = getDatabase()

  const result = await db
    .select({
      total: sql<number>`COALESCE(SUM(${requestLogs.totalCostUsd}), 0)`,
    })
    .from(requestLogs)

  return result[0]?.total || 0
}

/**
 * Get cost by API key
 */
export async function getCostByKey(
  keyId: string,
  startDate?: string,
  endDate?: string
): Promise<number> {
  const db = getDatabase()

  const conditions = [eq(requestLogs.apiKeyId, keyId)]

  if (startDate) {
    conditions.push(gte(requestLogs.createdAt, startDate))
  }

  if (endDate) {
    conditions.push(lte(requestLogs.createdAt, endDate))
  }

  const result = await db
    .select({
      total: sql<number>`COALESCE(SUM(${requestLogs.totalCostUsd}), 0)`,
    })
    .from(requestLogs)
    .where(and(...conditions))

  return result[0]?.total || 0
}

/**
 * Get cost by provider
 */
export async function getCostByProvider(
  providerId: string,
  startDate?: string,
  endDate?: string
): Promise<number> {
  const db = getDatabase()

  const conditions = [eq(requestLogs.providerId, providerId)]

  if (startDate) {
    conditions.push(gte(requestLogs.createdAt, startDate))
  }

  if (endDate) {
    conditions.push(lte(requestLogs.createdAt, endDate))
  }

  const result = await db
    .select({
      total: sql<number>`COALESCE(SUM(${requestLogs.totalCostUsd}), 0)`,
    })
    .from(requestLogs)
    .where(and(...conditions))

  return result[0]?.total || 0
}

/**
 * Get cost by project
 */
export async function getCostByProject(
  projectId: string,
  startDate?: string,
  endDate?: string
): Promise<number> {
  const db = getDatabase()

  const conditions = [eq(requestLogs.projectId, projectId)]

  if (startDate) {
    conditions.push(gte(requestLogs.createdAt, startDate))
  }

  if (endDate) {
    conditions.push(lte(requestLogs.createdAt, endDate))
  }

  const result = await db
    .select({
      total: sql<number>`COALESCE(SUM(${requestLogs.totalCostUsd}), 0)`,
    })
    .from(requestLogs)
    .where(and(...conditions))

  return result[0]?.total || 0
}

/**
 * Get today's cost by key (for display in key cards)
 */
export async function getTodayCostByKey(keyId: string): Promise<number> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return getCostByKey(keyId, today.toISOString())
}

/**
 * Get total cost by key (all time)
 */
export async function getTotalCostByKey(keyId: string): Promise<number> {
  return getCostByKey(keyId)
}

/**
 * Get cost statistics for all keys
 */
export interface KeyCostStats {
  keyId: string
  todayCost: number
  totalCost: number
}

export async function getAllKeysCostStats(): Promise<KeyCostStats[]> {
  const db = getDatabase()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = today.toISOString()

  // Get all unique key IDs with their costs
  const result = await db
    .select({
      keyId: requestLogs.apiKeyId,
      todayCost: sql<number>`COALESCE(SUM(CASE WHEN ${requestLogs.createdAt} >= ${todayStr} THEN ${requestLogs.totalCostUsd} ELSE 0 END), 0)`,
      totalCost: sql<number>`COALESCE(SUM(${requestLogs.totalCostUsd}), 0)`,
    })
    .from(requestLogs)
    .where(sql`${requestLogs.apiKeyId} IS NOT NULL`)
    .groupBy(requestLogs.apiKeyId)

  return result.map((r) => ({
    keyId: r.keyId!,
    todayCost: r.todayCost,
    totalCost: r.totalCost,
  }))
}

/**
 * Get recent request logs
 */
export async function getRecentRequestLogs(limit: number = 50): Promise<RequestLog[]> {
  const db = getDatabase()

  const result = await db
    .select()
    .from(requestLogs)
    .orderBy(desc(requestLogs.createdAt))
    .limit(limit)

  return result as RequestLog[]
}

/**
 * Get daily cost trend
 */
export interface DailyCost {
  date: string
  cost: number
  requests: number
}

export async function getDailyCostTrend(days: number = 7): Promise<DailyCost[]> {
  const db = getDatabase()
  const startDate = new Date()
  startDate.setDate(startDate.getDate() - days)
  startDate.setHours(0, 0, 0, 0)

  const result = await db
    .select({
      date: sql<string>`DATE(${requestLogs.createdAt})`,
      cost: sql<number>`COALESCE(SUM(${requestLogs.totalCostUsd}), 0)`,
      requests: sql<number>`COUNT(*)`,
    })
    .from(requestLogs)
    .where(gte(requestLogs.createdAt, startDate.toISOString()))
    .groupBy(sql`DATE(${requestLogs.createdAt})`)
    .orderBy(sql`DATE(${requestLogs.createdAt})`)

  return result.map((r) => ({
    date: r.date,
    cost: r.cost,
    requests: r.requests,
  }))
}

/**
 * Get usage summary
 */
export interface UsageSummary {
  totalRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  totalCostUsd: number
  avgLatencyMs: number | null
}

export async function getUsageSummary(
  startDate?: string,
  endDate?: string
): Promise<UsageSummary> {
  const db = getDatabase()

  const conditions = []
  if (startDate) {
    conditions.push(gte(requestLogs.createdAt, startDate))
  }
  if (endDate) {
    conditions.push(lte(requestLogs.createdAt, endDate))
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  const result = await db
    .select({
      totalRequests: sql<number>`COUNT(*)`,
      totalInputTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens}), 0)`,
      totalOutputTokens: sql<number>`COALESCE(SUM(${requestLogs.outputTokens}), 0)`,
      totalCacheReadTokens: sql<number>`COALESCE(SUM(${requestLogs.cacheReadTokens}), 0)`,
      totalCacheCreationTokens: sql<number>`COALESCE(SUM(${requestLogs.cacheCreationTokens}), 0)`,
      totalCostUsd: sql<number>`COALESCE(SUM(${requestLogs.totalCostUsd}), 0)`,
      avgLatencyMs: sql<number | null>`AVG(${requestLogs.latencyMs})`,
    })
    .from(requestLogs)
    .where(whereClause)

  const r = result[0]
  return {
    totalRequests: r?.totalRequests || 0,
    totalInputTokens: r?.totalInputTokens || 0,
    totalOutputTokens: r?.totalOutputTokens || 0,
    totalCacheReadTokens: r?.totalCacheReadTokens || 0,
    totalCacheCreationTokens: r?.totalCacheCreationTokens || 0,
    totalCostUsd: r?.totalCostUsd || 0,
    avgLatencyMs: r?.avgLatencyMs || null,
  }
}
