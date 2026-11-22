import { create } from 'zustand'
import type {
  ClientKind,
  ClientProfile,
  CreateClientProfileInput,
  UpdateClientProfileInput,
} from '@shared/types'
import { getApi } from '../api'

interface ClientProfileState {
  profiles: ClientProfile[]
  loading: boolean
  error: string | null
  fetchProfiles: (clientKind?: ClientKind) => Promise<ClientProfile[]>
  createProfile: (input: CreateClientProfileInput) => Promise<ClientProfile>
  updateProfile: (input: UpdateClientProfileInput) => Promise<ClientProfile>
  deleteProfile: (id: string) => Promise<void>
  reorderProfiles: (clientKind: ClientKind, ids: string[]) => Promise<void>
}

export const useClientProfileStore = create<ClientProfileState>((set, get) => ({
  profiles: [],
  loading: false,
  error: null,

  fetchProfiles: async (clientKind) => {
    set({ loading: true, error: null })
    try {
      const list = await getApi().clientProfile.list(clientKind)
      if (!clientKind) {
        set({ profiles: list, loading: false })
      } else {
        set((state) => ({
          profiles: [...state.profiles.filter((p) => p.clientKind !== clientKind), ...list],
          loading: false,
        }))
      }
      return list
    } catch (error) {
      set({ loading: false, error: String(error) })
      throw error
    }
  },

  createProfile: async (input) => {
    const created = await getApi().clientProfile.create(input)
    set((state) => {
      const existing = created.isDefault
        ? state.profiles.map((p) =>
            p.clientKind === created.clientKind ? { ...p, isDefault: false } : p,
          )
        : state.profiles
      return { profiles: [...existing, created] }
    })
    return created
  },

  updateProfile: async (input) => {
    const updated = await getApi().clientProfile.update(input)
    set((state) => ({
      profiles: state.profiles.map((p) => {
        if (p.id === updated.id) return updated
        if (updated.isDefault && p.clientKind === updated.clientKind) {
          return { ...p, isDefault: false }
        }
        return p
      }),
    }))
    return updated
  },

  deleteProfile: async (id) => {
    await getApi().clientProfile.delete(id)
    set((state) => ({
      profiles: state.profiles.filter((p) => p.id !== id),
    }))
  },

  reorderProfiles: async (clientKind, ids) => {
    const previous = get().profiles
    const order = new Map(ids.map((id, idx) => [id, idx]))
    set((state) => ({
      profiles: state.profiles
        .map((p) =>
          p.clientKind === clientKind && order.has(p.id)
            ? { ...p, sortOrder: order.get(p.id)! }
            : p,
        )
        .sort((a, b) => a.sortOrder - b.sortOrder),
    }))
    try {
      await getApi().clientProfile.reorder(clientKind, ids)
    } catch (error) {
      set({ profiles: previous })
      throw error
    }
  },
}))
