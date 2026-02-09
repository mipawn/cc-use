import { eq } from 'drizzle-orm'
import { getDatabase } from '../database'
import { settings } from '../database/schema'
import type { GlobalSettings, CliConfig } from '@shared/types'

const DEFAULT_SETTINGS: GlobalSettings = {
  defaultProviderType: 'claude',
  proxyPort: 12345,
  autoStartProxy: true,
  defaultTerminalType: 'iterm2',
  closeToTray: true,
}

export async function getGlobalSettings(): Promise<GlobalSettings> {
  const db = getDatabase()
  const rows = await db.select().from(settings)

  const result: GlobalSettings = { ...DEFAULT_SETTINGS }

  for (const row of rows) {
    if (row.key === 'defaultProviderType' && row.value) {
      result.defaultProviderType = row.value as GlobalSettings['defaultProviderType']
    } else if (row.key === 'proxyPort' && row.value) {
      result.proxyPort = parseInt(row.value, 10)
    } else if (row.key === 'autoStartProxy' && row.value) {
      result.autoStartProxy = row.value === 'true'
    } else if (row.key === 'defaultTerminalType' && row.value) {
      result.defaultTerminalType = row.value as GlobalSettings['defaultTerminalType']
    } else if (row.key === 'closeToTray' && row.value) {
      result.closeToTray = row.value === 'true'
    } else if (row.key === 'claudeConfig' && row.value) {
      try {
        result.claudeConfig = JSON.parse(row.value) as CliConfig
      } catch {
        result.claudeConfig = {}
      }
    } else if (row.key === 'codexConfig' && row.value) {
      try {
        result.codexConfig = JSON.parse(row.value) as CliConfig
      } catch {
        result.codexConfig = {}
      }
    }
  }

  return result
}

export async function updateGlobalSettings(
  updates: Partial<GlobalSettings>,
): Promise<GlobalSettings> {
  const db = getDatabase()

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue

    // JSON stringify for object values (claudeConfig, codexConfig)
    let stringValue: string
    if (typeof value === 'object' && value !== null) {
      stringValue = JSON.stringify(value)
    } else {
      stringValue = String(value)
    }

    const existing = await db.select().from(settings).where(eq(settings.key, key))

    if (existing.length > 0) {
      await db.update(settings).set({ value: stringValue }).where(eq(settings.key, key))
    } else {
      await db.insert(settings).values({ key, value: stringValue })
    }
  }

  return getGlobalSettings()
}
