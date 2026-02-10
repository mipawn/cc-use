import { eq, gte, and, sql, desc } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDatabase } from '../database'
import { usageLogs, projects, providers, apiKeys } from '../database/schema'
import type { UsageLog, UsageStats, StatsTimeRange, ProviderType } from '@shared/types'

// Create a new usage log entry
export async function createUsageLog(
  projectId: string,
  providerId: string,
  apiKeyId: string,
  keyType: ProviderType = 'claude',
): Promise<UsageLog> {
  const db = getDatabase()
  const id = nanoid()
  const launchedAt = new Date().toISOString()

  // Get project, provider, and key details for denormalization
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
  const [provider] = await db.select().from(providers).where(eq(providers.id, providerId))
  const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.id, apiKeyId))

  await db.insert(usageLogs).values({
    id,
    projectId,
    projectName: project?.name || 'Unknown',
    providerId,
    providerName: provider?.name || null,
    apiKeyId,
    apiKeyAlias: apiKey?.alias || `Key ${(apiKey?.priority || 0) + 1}`,
    keyType,
    launchedAt,
    duration: null,
  })

  return {
    id,
    projectId,
    projectName: project?.name || 'Unknown',
    providerId,
    providerName: provider?.name || null,
    apiKeyId,
    apiKeyAlias: apiKey?.alias || null,
    keyType,
    launchedAt,
    duration: null,
  }
}

// Get date range based on time range
function getDateRange(timeRange: StatsTimeRange): { start: Date; end: Date } {
  const now = new Date()
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
  let start: Date

  switch (timeRange) {
    case 'today':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
      break
    case 'yesterday':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0)
      end.setDate(end.getDate() - 1)
      break
    case 'week':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0)
      break
    case 'month':
      start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
      break
    case 'all':
    default:
      start = new Date(0) // Beginning of time
      break
  }

  return { start, end }
}

// Get usage statistics for a time range
export async function getUsageStats(timeRange: StatsTimeRange): Promise<UsageStats> {
  const db = getDatabase()
  const { start, end } = getDateRange(timeRange)

  // Build the where condition
  const whereCondition =
    timeRange === 'all'
      ? undefined
      : and(
          gte(usageLogs.launchedAt, start.toISOString()),
          sql`${usageLogs.launchedAt} <= ${end.toISOString()}`,
        )

  // Get all logs in range
  const logs = whereCondition
    ? await db.select().from(usageLogs).where(whereCondition).orderBy(desc(usageLogs.launchedAt))
    : await db.select().from(usageLogs).orderBy(desc(usageLogs.launchedAt))

  // Calculate statistics
  const totalLaunches = logs.length
  const uniqueProjects = new Set(logs.map((l) => l.projectId).filter(Boolean)).size
  const uniqueKeys = new Set(logs.map((l) => l.apiKeyId).filter(Boolean)).size

  // Group by project
  const projectCounts = new Map<string, { projectName: string; count: number }>()
  logs.forEach((log) => {
    if (log.projectId) {
      const existing = projectCounts.get(log.projectId)
      if (existing) {
        existing.count++
      } else {
        projectCounts.set(log.projectId, { projectName: log.projectName, count: 1 })
      }
    }
  })
  const byProject = Array.from(projectCounts.entries())
    .map(([projectId, { projectName, count }]) => ({ projectId, projectName, count }))
    .sort((a, b) => b.count - a.count)

  // Group by key
  const keyCounts = new Map<
    string,
    { keyAlias: string; providerName: string; keyType: ProviderType; count: number }
  >()
  logs.forEach((log) => {
    if (log.apiKeyId) {
      const existing = keyCounts.get(log.apiKeyId)
      if (existing) {
        existing.count++
      } else {
        keyCounts.set(log.apiKeyId, {
          keyAlias: log.apiKeyAlias || 'Unknown',
          providerName: log.providerName || 'Unknown',
          keyType: (log.keyType as ProviderType) || 'claude',
          count: 1,
        })
      }
    }
  })
  const byKey = Array.from(keyCounts.entries())
    .map(([keyId, data]) => ({ keyId, ...data }))
    .sort((a, b) => b.count - a.count)

  // Group by date
  const dateCounts = new Map<string, number>()
  logs.forEach((log) => {
    const date = log.launchedAt.split('T')[0]
    dateCounts.set(date, (dateCounts.get(date) || 0) + 1)
  })
  const byDate = Array.from(dateCounts.entries())
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => b.date.localeCompare(a.date))

  return {
    totalLaunches,
    uniqueProjects,
    uniqueKeys,
    byProject,
    byKey,
    byDate,
  }
}

// Get recent usage logs
export async function getRecentUsageLogs(limit: number = 20): Promise<UsageLog[]> {
  const db = getDatabase()
  const logs = await db.select().from(usageLogs).orderBy(desc(usageLogs.launchedAt)).limit(limit)

  return logs.map((log) => ({
    id: log.id,
    projectId: log.projectId,
    projectName: log.projectName,
    providerId: log.providerId,
    providerName: log.providerName,
    apiKeyId: log.apiKeyId,
    apiKeyAlias: log.apiKeyAlias,
    keyType: log.keyType as ProviderType | null,
    launchedAt: log.launchedAt,
    duration: log.duration,
  }))
}

// Get today's quick stats for dashboard
export async function getTodayQuickStats(): Promise<{
  launches: number
  uniqueProjects: number
  uniqueKeys: number
}> {
  const stats = await getUsageStats('today')
  return {
    launches: stats.totalLaunches,
    uniqueProjects: stats.uniqueProjects,
    uniqueKeys: stats.uniqueKeys,
  }
}
