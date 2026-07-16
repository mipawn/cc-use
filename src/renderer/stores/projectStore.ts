import { getApi } from '../api'
import { create } from 'zustand'
import type { Project } from '@shared/types'

interface ProjectState {
  projects: Project[]
  loading: boolean
  error: string | null
  fetchProjects: () => Promise<void>
  createProject: (input: Parameters<typeof window.api.project.create>[0]) => Promise<Project>
  updateProject: (input: Parameters<typeof window.api.project.update>[0]) => Promise<Project>
  updateProjectBinding: (
    projectId: string,
    input: Parameters<typeof window.api.project.updateBinding>[1],
  ) => Promise<Project>
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
      const projects = await getApi().project.list()
      set({ projects, loading: false })
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch projects',
        loading: false,
      })
    }
  },

  createProject: async (input) => {
    const project = await getApi().project.create(input)
    set({ projects: [project, ...get().projects] })
    return project
  },

  updateProject: async (input) => {
    const project = await getApi().project.update(input)
    set({
      projects: get().projects.map((p) => (p.id === project.id ? project : p)),
    })
    return project
  },

  updateProjectBinding: async (projectId, input) => {
    const project = await getApi().project.updateBinding(projectId, input)
    set({
      projects: get().projects.map((item) => (item.id === project.id ? project : item)),
    })
    return project
  },

  deleteProject: async (id) => {
    await getApi().project.delete(id)
    set({ projects: get().projects.filter((p) => p.id !== id) })
  },

  getProjectByPath: async (path) => {
    return getApi().project.getByPath(path)
  },
}))
