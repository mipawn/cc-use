import { eq } from 'drizzle-orm'
import { getDatabase } from '../database'
import { providers } from '../database/schema'
import { listProviders, createProvider } from './providerService'
import { listApiKeys, createApiKey } from './apiKeyService'
import type {
  ExportData,
  ExportProvider,
  ExportApiKey,
  ImportOptions,
  ImportResult,
} from '@shared/types'

const EXPORT_VERSION = '1.0'

export async function exportProviders(): Promise<ExportData> {
  const allProviders = await listProviders()
  const exportProviders: ExportProvider[] = []

  for (const provider of allProviders) {
    const keys = await listApiKeys(provider.id)
    const exportKeys: ExportApiKey[] = keys.map((key) => ({
      alias: key.alias ?? undefined,
      value: key.value,
      priority: key.priority,
    }))

    exportProviders.push({
      name: provider.name,
      type: provider.type ?? 'claude',
      baseUrl: provider.baseUrl,
      website: provider.website ?? undefined,
      remark: provider.remark ?? undefined,
      icon: provider.icon ?? undefined,
      walletBalanceType: provider.walletBalanceType,
      walletBalanceUrl: provider.walletBalanceUrl ?? undefined,
      walletBalancePath: provider.walletBalancePath ?? undefined,
      walletBalanceHeaders: provider.walletBalanceHeaders ?? undefined,
      usageType: provider.usageType,
      usageUrl: provider.usageUrl ?? undefined,
      usagePath: provider.usagePath ?? undefined,
      usageHeaders: provider.usageHeaders ?? undefined,
      apiKeys: exportKeys,
    })
  }

  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    providers: exportProviders,
  }
}

export async function importProviders(
  data: ExportData,
  options: ImportOptions = { overwrite: false },
): Promise<ImportResult> {
  const result: ImportResult = {
    imported: 0,
    skipped: 0,
    errors: [],
  }

  if (!data.providers || !Array.isArray(data.providers)) {
    result.errors.push('Invalid import data: providers array not found')
    return result
  }

  const existingProviders = await listProviders()
  const existingNameMap = new Map(existingProviders.map((p) => [p.name, p]))

  for (const exportProvider of data.providers) {
    try {
      const existing = existingNameMap.get(exportProvider.name)

      if (existing) {
        if (options.overwrite) {
          // Delete existing provider and recreate
          const db = getDatabase()
          await db.delete(providers).where(eq(providers.id, existing.id))
        } else {
          result.skipped++
          continue
        }
      }

      // Create provider
      const newProvider = await createProvider({
        name: exportProvider.name,
        type: exportProvider.type,
        baseUrl: exportProvider.baseUrl,
        website: exportProvider.website,
        remark: exportProvider.remark,
        icon: exportProvider.icon,
        walletBalanceType: exportProvider.walletBalanceType,
        walletBalanceUrl: exportProvider.walletBalanceUrl,
        walletBalancePath: exportProvider.walletBalancePath,
        walletBalanceHeaders: exportProvider.walletBalanceHeaders,
        usageType: exportProvider.usageType,
        usageUrl: exportProvider.usageUrl,
        usagePath: exportProvider.usagePath,
        usageHeaders: exportProvider.usageHeaders,
      })

      // Create API keys
      if (exportProvider.apiKeys && Array.isArray(exportProvider.apiKeys)) {
        for (const exportKey of exportProvider.apiKeys) {
          await createApiKey({
            providerId: newProvider.id,
            alias: exportKey.alias,
            value: exportKey.value,
            priority: exportKey.priority,
          })
        }
      }

      result.imported++
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      result.errors.push(`Failed to import provider "${exportProvider.name}": ${errorMessage}`)
    }
  }

  return result
}

export function validateExportData(data: unknown): data is ExportData {
  if (!data || typeof data !== 'object') {
    return false
  }

  const obj = data as Record<string, unknown>

  if (typeof obj.version !== 'string') {
    return false
  }

  if (!Array.isArray(obj.providers)) {
    return false
  }

  for (const provider of obj.providers) {
    if (!provider || typeof provider !== 'object') {
      return false
    }

    const p = provider as Record<string, unknown>
    if (typeof p.name !== 'string' || typeof p.baseUrl !== 'string') {
      return false
    }
  }

  return true
}
