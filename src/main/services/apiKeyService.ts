import { eq, asc } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDatabase } from '../database'
import { apiKeys } from '../database/schema'
import type { ApiKey, CreateApiKeyInput, UpdateApiKeyInput } from '@shared/types'

export async function listApiKeys(providerId: string): Promise<ApiKey[]> {
  const db = getDatabase()
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.providerId, providerId))
    .orderBy(asc(apiKeys.priority))
  return rows.map(mapRowToApiKey)
}

export async function getApiKey(id: string): Promise<ApiKey | null> {
  const db = getDatabase()
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.id, id))
  return rows.length > 0 ? mapRowToApiKey(rows[0]) : null
}

export async function createApiKey(input: CreateApiKeyInput): Promise<ApiKey> {
  const db = getDatabase()
  const id = nanoid()

  // Get max priority for this provider
  const existingKeys = await listApiKeys(input.providerId)
  const maxPriority = existingKeys.reduce(
    (max, key) => Math.max(max, key.priority),
    -1
  )

  await db.insert(apiKeys).values({
    id,
    providerId: input.providerId,
    alias: input.alias ?? null,
    value: input.value,
    priority: input.priority ?? maxPriority + 1,
    isExhausted: false,
  })

  const apiKey = await getApiKey(id)
  if (!apiKey) {
    throw new Error('Failed to create API key')
  }
  return apiKey
}

export async function updateApiKey(input: UpdateApiKeyInput): Promise<ApiKey> {
  const db = getDatabase()

  const updateData: Record<string, unknown> = {}
  if (input.alias !== undefined) updateData.alias = input.alias
  if (input.value !== undefined) updateData.value = input.value
  if (input.priority !== undefined) updateData.priority = input.priority
  if (input.isExhausted !== undefined) updateData.isExhausted = input.isExhausted

  await db.update(apiKeys).set(updateData).where(eq(apiKeys.id, input.id))

  const apiKey = await getApiKey(input.id)
  if (!apiKey) {
    throw new Error('API key not found')
  }
  return apiKey
}

export async function deleteApiKey(id: string): Promise<void> {
  const db = getDatabase()
  await db.delete(apiKeys).where(eq(apiKeys.id, id))
}

export async function reorderApiKeys(
  providerId: string,
  keyIds: string[]
): Promise<ApiKey[]> {
  const db = getDatabase()

  for (let i = 0; i < keyIds.length; i++) {
    await db
      .update(apiKeys)
      .set({ priority: i })
      .where(eq(apiKeys.id, keyIds[i]))
  }

  return listApiKeys(providerId)
}

export async function getAvailableApiKeys(providerId: string): Promise<ApiKey[]> {
  const db = getDatabase()
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.providerId, providerId))
    .orderBy(asc(apiKeys.priority))

  return rows
    .filter((row) => !row.isExhausted)
    .map(mapRowToApiKey)
}

export async function markKeyExhausted(id: string): Promise<void> {
  const db = getDatabase()
  await db.update(apiKeys).set({ isExhausted: true }).where(eq(apiKeys.id, id))
}

export async function resetAllKeysForProvider(providerId: string): Promise<void> {
  const db = getDatabase()
  await db
    .update(apiKeys)
    .set({ isExhausted: false })
    .where(eq(apiKeys.providerId, providerId))
}

function mapRowToApiKey(row: typeof apiKeys.$inferSelect): ApiKey {
  return {
    id: row.id,
    providerId: row.providerId ?? '',
    alias: row.alias,
    value: row.value,
    priority: row.priority ?? 0,
    isExhausted: row.isExhausted ?? false,
  }
}
