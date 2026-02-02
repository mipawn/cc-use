import { eq, desc } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDatabase } from '../database'
import { projects } from '../database/schema'
import type { Project, CreateProjectInput, UpdateProjectInput } from '@shared/types'

export async function listProjects(): Promise<Project[]> {
  const db = getDatabase()
  const rows = await db
    .select()
    .from(projects)
    .orderBy(desc(projects.lastOpenedAt))
  return rows.map(mapRowToProject)
}

export async function getProject(id: string): Promise<Project | null> {
  const db = getDatabase()
  const rows = await db.select().from(projects).where(eq(projects.id, id))
  return rows.length > 0 ? mapRowToProject(rows[0]) : null
}

export async function getProjectByPath(path: string): Promise<Project | null> {
  const db = getDatabase()
  const rows = await db.select().from(projects).where(eq(projects.path, path))
  return rows.length > 0 ? mapRowToProject(rows[0]) : null
}

export async function createProject(
  input: CreateProjectInput
): Promise<Project> {
  const db = getDatabase()
  const id = nanoid()
  const now = new Date().toISOString()

  await db.insert(projects).values({
    id,
    name: input.name,
    path: input.path,
    providerId: input.providerId ?? null,
    lastOpenedAt: now,
  })

  const project = await getProject(id)
  if (!project) {
    throw new Error('Failed to create project')
  }
  return project
}

export async function updateProject(
  input: UpdateProjectInput
): Promise<Project> {
  const db = getDatabase()

  const updateData: Record<string, unknown> = {}
  if (input.name !== undefined) updateData.name = input.name
  if (input.providerId !== undefined) updateData.providerId = input.providerId

  await db.update(projects).set(updateData).where(eq(projects.id, input.id))

  const project = await getProject(input.id)
  if (!project) {
    throw new Error('Project not found')
  }
  return project
}

export async function deleteProject(id: string): Promise<void> {
  const db = getDatabase()
  await db.delete(projects).where(eq(projects.id, id))
}

export async function updateProjectLastOpened(id: string): Promise<void> {
  const db = getDatabase()
  const now = new Date().toISOString()
  await db.update(projects).set({ lastOpenedAt: now }).where(eq(projects.id, id))
}

function mapRowToProject(row: typeof projects.$inferSelect): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    providerId: row.providerId,
    lastOpenedAt: row.lastOpenedAt,
  }
}
