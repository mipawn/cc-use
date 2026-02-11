/**
 * Request Log Service
 * Records and queries API request logs for cost tracking
 */

import { nanoid } from 'nanoid'
import { eq, sql, and, gte, lte, desc } from 'drizzle-orm'
import { getDatabase } from '../database'
import { requestLogs, apiKeys, providers, projects } from '../database/schema'
import type { CostBreakdown, TokenUsage, ModelPricing } from './costCalculator'
import { calculateCost, loadCustomModelPricing } from './costCalculator'
import type {
  StatsTimeRange,
  CostStatsSummary,
  TopKeyCostItem,
  TopProviderCostItem,
  TopProjectCostItem,
  TopModelCostItem,
  DailyCostTrendItem,
  RecentRequestLogDisplay,
  CostStatistics,
  DashboardCostStats,
} from '@shared/types'

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
  providerPricing?: Record<string, ModelPricing>
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

  // Load custom model pricing for accurate cost calculation
  const customPricing = await loadCustomModelPricing()

  // Merge pricing: hardcoded < global custom < provider synced
  const mergedPricing = input.providerPricing
    ? { ...customPricing, ...input.providerPricing }
    : customPricing

  // Calculate costs
  const costs: CostBreakdown = input.model
    ? calculateCost(input.model, input.usage, costMultiplier, mergedPricing)
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
  endDate?: string,
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
  endDate?: string,
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
  endDate?: string,
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
      date: sql<string>`DATE(${requestLogs.createdAt}, 'localtime')`,
      cost: sql<number>`COALESCE(SUM(${requestLogs.totalCostUsd}), 0)`,
      requests: sql<number>`COUNT(*)`,
    })
    .from(requestLogs)
    .where(gte(requestLogs.createdAt, startDate.toISOString()))
    .groupBy(sql`DATE(${requestLogs.createdAt}, 'localtime')`)
    .orderBy(sql`DATE(${requestLogs.createdAt}, 'localtime')`)

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

export async function getUsageSummary(startDate?: string, endDate?: string): Promise<UsageSummary> {
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

/**
 * Get date range from StatsTimeRange
 */
function getDateRange(timeRange: StatsTimeRange): {
  startDate: string | undefined
  endDate: string | undefined
} {
  const now = new Date()

  if (timeRange === 'all') {
    return { startDate: undefined, endDate: undefined }
  }

  let start: Date
  let end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)

  switch (timeRange) {
    case 'today':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
      break
    case 'yesterday':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0)
      end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59, 999)
      break
    case 'week':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0)
      break
    case 'month':
      start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
      break
    default:
      start = new Date(0)
      break
  }

  return { startDate: start.toISOString(), endDate: end.toISOString() }
}

/**
 * Get usage summary by time range
 */
export async function getUsageSummaryByTimeRange(
  timeRange: StatsTimeRange,
): Promise<CostStatsSummary> {
  const { startDate, endDate } = getDateRange(timeRange)
  return getUsageSummary(startDate, endDate)
}

/**
 * Get top keys by cost
 */
export async function getTopKeysByCost(
  timeRange: StatsTimeRange,
  limit: number = 10,
): Promise<TopKeyCostItem[]> {
  const db = getDatabase()
  const { startDate, endDate } = getDateRange(timeRange)

  const conditions = [sql`${requestLogs.apiKeyId} IS NOT NULL`]
  if (startDate) conditions.push(gte(requestLogs.createdAt, startDate))
  if (endDate) conditions.push(lte(requestLogs.createdAt, endDate))

  const result = await db
    .select({
      keyId: requestLogs.apiKeyId,
      keyAlias: apiKeys.alias,
      providerName: providers.name,
      totalCost: sql<number>`COALESCE(SUM(${requestLogs.totalCostUsd}), 0)`,
      totalRequests: sql<number>`COUNT(*)`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
    })
    .from(requestLogs)
    .leftJoin(apiKeys, eq(requestLogs.apiKeyId, apiKeys.id))
    .leftJoin(providers, eq(requestLogs.providerId, providers.id))
    .where(and(...conditions))
    .groupBy(requestLogs.apiKeyId)
    .orderBy(sql`SUM(${requestLogs.totalCostUsd}) DESC`)
    .limit(limit)

  return result.map((r) => ({
    keyId: r.keyId!,
    keyAlias: r.keyAlias || 'Unknown',
    providerName: r.providerName || 'Unknown',
    totalCost: r.totalCost,
    totalRequests: r.totalRequests,
    totalTokens: r.totalTokens,
  }))
}

/**
 * Get top providers by cost
 */
export async function getTopProvidersByCost(
  timeRange: StatsTimeRange,
  limit: number = 10,
): Promise<TopProviderCostItem[]> {
  const db = getDatabase()
  const { startDate, endDate } = getDateRange(timeRange)

  const conditions = [sql`${requestLogs.providerId} IS NOT NULL`]
  if (startDate) conditions.push(gte(requestLogs.createdAt, startDate))
  if (endDate) conditions.push(lte(requestLogs.createdAt, endDate))

  const result = await db
    .select({
      providerId: requestLogs.providerId,
      providerName: providers.name,
      totalCost: sql<number>`COALESCE(SUM(${requestLogs.totalCostUsd}), 0)`,
      totalRequests: sql<number>`COUNT(*)`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
    })
    .from(requestLogs)
    .leftJoin(providers, eq(requestLogs.providerId, providers.id))
    .where(and(...conditions))
    .groupBy(requestLogs.providerId)
    .orderBy(sql`SUM(${requestLogs.totalCostUsd}) DESC`)
    .limit(limit)

  return result.map((r) => ({
    providerId: r.providerId!,
    providerName: r.providerName || 'Unknown',
    totalCost: r.totalCost,
    totalRequests: r.totalRequests,
    totalTokens: r.totalTokens,
  }))
}

/**
 * Get top projects by cost
 */
export async function getTopProjectsByCost(
  timeRange: StatsTimeRange,
  limit: number = 10,
): Promise<TopProjectCostItem[]> {
  const db = getDatabase()
  const { startDate, endDate } = getDateRange(timeRange)

  const conditions = [sql`${requestLogs.projectId} IS NOT NULL`]
  if (startDate) conditions.push(gte(requestLogs.createdAt, startDate))
  if (endDate) conditions.push(lte(requestLogs.createdAt, endDate))

  const result = await db
    .select({
      projectId: requestLogs.projectId,
      projectName: projects.name,
      totalCost: sql<number>`COALESCE(SUM(${requestLogs.totalCostUsd}), 0)`,
      totalRequests: sql<number>`COUNT(*)`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
    })
    .from(requestLogs)
    .leftJoin(projects, eq(requestLogs.projectId, projects.id))
    .where(and(...conditions))
    .groupBy(requestLogs.projectId)
    .orderBy(sql`SUM(${requestLogs.totalCostUsd}) DESC`)
    .limit(limit)

  return result.map((r) => ({
    projectId: r.projectId!,
    projectName: r.projectName || 'Unknown',
    totalCost: r.totalCost,
    totalRequests: r.totalRequests,
    totalTokens: r.totalTokens,
  }))
}

/**
 * Get top models by cost
 */
export async function getTopModelsByCost(
  timeRange: StatsTimeRange,
  limit: number = 10,
): Promise<TopModelCostItem[]> {
  const db = getDatabase()
  const { startDate, endDate } = getDateRange(timeRange)

  const conditions = [sql`${requestLogs.model} IS NOT NULL`]
  if (startDate) conditions.push(gte(requestLogs.createdAt, startDate))
  if (endDate) conditions.push(lte(requestLogs.createdAt, endDate))

  const result = await db
    .select({
      model: requestLogs.model,
      totalCost: sql<number>`COALESCE(SUM(${requestLogs.totalCostUsd}), 0)`,
      totalRequests: sql<number>`COUNT(*)`,
      totalTokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
    })
    .from(requestLogs)
    .where(and(...conditions))
    .groupBy(requestLogs.model)
    .orderBy(sql`SUM(${requestLogs.totalCostUsd}) DESC`)
    .limit(limit)

  return result.map((r) => ({
    model: r.model || 'Unknown',
    totalCost: r.totalCost,
    totalRequests: r.totalRequests,
    totalTokens: r.totalTokens,
  }))
}

/**
 * Get daily cost trend by time range
 */
export async function getDailyCostTrendByTimeRange(
  timeRange: StatsTimeRange,
): Promise<DailyCostTrendItem[]> {
  const { startDate } = getDateRange(timeRange)

  const db = getDatabase()
  const conditions = []
  if (startDate) {
    conditions.push(gte(requestLogs.createdAt, startDate))
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  const result = await db
    .select({
      date: sql<string>`DATE(${requestLogs.createdAt}, 'localtime')`,
      cost: sql<number>`COALESCE(SUM(${requestLogs.totalCostUsd}), 0)`,
      requests: sql<number>`COUNT(*)`,
    })
    .from(requestLogs)
    .where(whereClause)
    .groupBy(sql`DATE(${requestLogs.createdAt}, 'localtime')`)
    .orderBy(sql`DATE(${requestLogs.createdAt}, 'localtime')`)

  return result.map((r) => ({
    date: r.date,
    cost: r.cost,
    requests: r.requests,
  }))
}

/**
 * Get recent request logs with readable names
 */
export async function getRecentRequestLogsWithNames(
  limit: number = 20,
): Promise<RecentRequestLogDisplay[]> {
  const db = getDatabase()

  const result = await db
    .select({
      id: requestLogs.id,
      model: requestLogs.model,
      keyAlias: apiKeys.alias,
      providerName: providers.name,
      projectName: projects.name,
      totalCostUsd: requestLogs.totalCostUsd,
      inputTokens: requestLogs.inputTokens,
      outputTokens: requestLogs.outputTokens,
      latencyMs: requestLogs.latencyMs,
      statusCode: requestLogs.statusCode,
      createdAt: requestLogs.createdAt,
    })
    .from(requestLogs)
    .leftJoin(apiKeys, eq(requestLogs.apiKeyId, apiKeys.id))
    .leftJoin(providers, eq(requestLogs.providerId, providers.id))
    .leftJoin(projects, eq(requestLogs.projectId, projects.id))
    .orderBy(desc(requestLogs.createdAt))
    .limit(limit)

  return result.map((r) => ({
    id: r.id,
    model: r.model,
    keyAlias: r.keyAlias || null,
    providerName: r.providerName || null,
    projectName: r.projectName || null,
    totalCostUsd: r.totalCostUsd || 0,
    inputTokens: r.inputTokens || 0,
    outputTokens: r.outputTokens || 0,
    latencyMs: r.latencyMs,
    statusCode: r.statusCode,
    createdAt: r.createdAt,
  }))
}

/**
 * Get cost statistics for Statistics page (aggregated)
 */
export async function getCostStatistics(timeRange: StatsTimeRange): Promise<CostStatistics> {
  const [summary, topKeys, topProviders, topProjects, topModels, dailyTrend, recentRequests] =
    await Promise.all([
      getUsageSummaryByTimeRange(timeRange),
      getTopKeysByCost(timeRange, 10),
      getTopProvidersByCost(timeRange, 10),
      getTopProjectsByCost(timeRange, 10),
      getTopModelsByCost(timeRange, 10),
      getDailyCostTrendByTimeRange(timeRange),
      getRecentRequestLogsWithNames(20),
    ])

  return {
    summary,
    topKeys,
    topProviders,
    topProjects,
    topModels,
    dailyTrend,
    recentRequests,
  }
}

/**
 * Get dashboard cost stats (aggregated)
 */
export async function getDashboardCostStats(): Promise<DashboardCostStats> {
  const todayCost = await getTodayCost()
  const totalCost = await getTotalCost()

  // Today's requests and tokens
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = today.toISOString()

  const db = getDatabase()
  const todayResult = await db
    .select({
      requests: sql<number>`COUNT(*)`,
      tokens: sql<number>`COALESCE(SUM(${requestLogs.inputTokens} + ${requestLogs.outputTokens}), 0)`,
    })
    .from(requestLogs)
    .where(gte(requestLogs.createdAt, todayStr))

  const todayRequests = todayResult[0]?.requests || 0
  const todayTokens = todayResult[0]?.tokens || 0

  const [weeklyTrend, topKeys, topProjects] = await Promise.all([
    getDailyCostTrend(7),
    getTopKeysByCost('week', 3),
    getTopProjectsByCost('week', 3),
  ])

  return {
    todayCost,
    totalCost,
    todayRequests,
    todayTokens,
    weeklyTrend,
    topKeys,
    topProjects,
  }
}
