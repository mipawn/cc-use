import { eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDatabase } from '../database'
import { providers } from '../database/schema'
import type {
  Provider,
  CreateProviderInput,
  UpdateProviderInput,
} from '@shared/types'

export async function listProviders(): Promise<Provider[]> {
  const db = getDatabase()
  const rows = await db.select().from(providers)
  return rows.map(mapRowToProvider)
}

export async function getProvider(id: string): Promise<Provider | null> {
  const db = getDatabase()
  const rows = await db.select().from(providers).where(eq(providers.id, id))
  return rows.length > 0 ? mapRowToProvider(rows[0]) : null
}

export async function createProvider(
  input: CreateProviderInput
): Promise<Provider> {
  const db = getDatabase()
  const id = nanoid()

  await db.insert(providers).values({
    id,
    name: input.name,
    baseUrl: input.baseUrl,
    walletBalanceType: input.walletBalanceType ?? 'none',
    walletBalanceUrl: input.walletBalanceUrl ?? null,
    walletBalancePath: input.walletBalancePath ?? null,
    walletBalanceHeaders: input.walletBalanceHeaders ?? null,
    cachedWalletBalance: null,
    lastBalanceCheckedAt: null,
    isActive: true,
  })

  const provider = await getProvider(id)
  if (!provider) {
    throw new Error('Failed to create provider')
  }
  return provider
}

export async function updateProvider(
  input: UpdateProviderInput
): Promise<Provider> {
  const db = getDatabase()

  const updateData: Record<string, unknown> = {}
  if (input.name !== undefined) updateData.name = input.name
  if (input.baseUrl !== undefined) updateData.baseUrl = input.baseUrl
  if (input.walletBalanceType !== undefined)
    updateData.walletBalanceType = input.walletBalanceType
  if (input.walletBalanceUrl !== undefined)
    updateData.walletBalanceUrl = input.walletBalanceUrl
  if (input.walletBalancePath !== undefined)
    updateData.walletBalancePath = input.walletBalancePath
  if (input.walletBalanceHeaders !== undefined)
    updateData.walletBalanceHeaders = input.walletBalanceHeaders
  if (input.isActive !== undefined) updateData.isActive = input.isActive

  await db.update(providers).set(updateData).where(eq(providers.id, input.id))

  const provider = await getProvider(input.id)
  if (!provider) {
    throw new Error('Provider not found')
  }
  return provider
}

export async function deleteProvider(id: string): Promise<void> {
  const db = getDatabase()
  await db.delete(providers).where(eq(providers.id, id))
}

function mapRowToProvider(row: typeof providers.$inferSelect): Provider {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    walletBalanceType: (row.walletBalanceType as Provider['walletBalanceType']) ?? 'none',
    walletBalanceUrl: row.walletBalanceUrl,
    walletBalancePath: row.walletBalancePath,
    walletBalanceHeaders: row.walletBalanceHeaders,
    cachedWalletBalance: row.cachedWalletBalance,
    lastBalanceCheckedAt: row.lastBalanceCheckedAt,
    isActive: row.isActive ?? true,
  }
}
