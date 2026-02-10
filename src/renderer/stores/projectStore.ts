import { create } from 'zustand'
import type { Project } from '@shared/types'

interface ProjectState {
  projects: Project[]
  loading: boolean
  error: string | null
  fetchProjects: () => Promise<void>
  createProject: (input: Parameters<typeof window.api.project.create>[0]) => Promise<Project>
  updateProject: (input: Parameters<typeof window.api.project.update>[0]) => Promise<Project>
  deleteProject: (id: string) => Promise<void>
  getProjectByPath: (path: string) => Promise<Project | null>
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  loading: false,
  error: null,

  fetchProjects: async () => {
    set({ loading: true, error: null })
    try {
      const projects = await window.api.project.list()
      set({ projects, loading: false })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch projects',
        loading: false,
      })
    }
  },

  createProject: async (input) => {
    const project = await window.api.project.create(input)
    set({ projects: [project, ...get().projects] })
    return project
  },

  updateProject: async (input) => {
    const project = await window.api.project.update(input)
    set({
      projects: get().projects.map((p) => (p.id === project.id ? project : p)),
    })
    return project
  },

  deleteProject: async (id) => {
    await window.api.project.delete(id)
    set({ projects: get().projects.filter((p) => p.id !== id) })
  },

  getProjectByPath: async (path) => {
    return window.api.project.getByPath(path)
  },
}))
