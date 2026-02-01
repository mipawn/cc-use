import { create } from 'zustand';
import type { Provider, CLIType } from '../api/client';
import {
  getProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  duplicateProvider,
  reorderProviders,
} from '../api/client';

interface ProvidersState {
  providers: Provider[];
  loading: boolean;
  error: string | null;

  // Actions
  fetchProviders: (type?: CLIType) => Promise<void>;
  createProvider: (provider: Partial<Provider>) => Promise<Provider>;
  updateProvider: (id: string, provider: Partial<Provider>) => Promise<Provider>;
  deleteProvider: (id: string) => Promise<void>;
  duplicateProvider: (id: string, newName: string) => Promise<Provider>;
  reorderProviders: (orderedIds: string[]) => Promise<void>;
}

export const useProvidersStore = create<ProvidersState>((set, get) => ({
  providers: [],
  loading: false,
  error: null,

  fetchProviders: async (type?: CLIType) => {
    set({ loading: true, error: null });
    try {
      const providers = await getProviders(type);
      set({ providers, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to fetch providers',
        loading: false,
      });
    }
  },

  createProvider: async (provider: Partial<Provider>) => {
    set({ loading: true, error: null });
    try {
      const newProvider = await createProvider(provider);
      set((state) => ({
        providers: [...state.providers, newProvider],
        loading: false,
      }));
      return newProvider;
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to create provider',
        loading: false,
      });
      throw err;
    }
  },

  updateProvider: async (id: string, provider: Partial<Provider>) => {
    set({ loading: true, error: null });
    try {
      const updatedProvider = await updateProvider(id, provider);
      set((state) => ({
        providers: state.providers.map((p) =>
          p.id === id ? updatedProvider : p
        ),
        loading: false,
      }));
      return updatedProvider;
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to update provider',
        loading: false,
      });
      throw err;
    }
  },

  deleteProvider: async (id: string) => {
    set({ loading: true, error: null });
    try {
      await deleteProvider(id);
      set((state) => ({
        providers: state.providers.filter((p) => p.id !== id),
        loading: false,
      }));
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to delete provider',
        loading: false,
      });
      throw err;
    }
  },

  duplicateProvider: async (id: string, newName: string) => {
    set({ loading: true, error: null });
    try {
      const duplicated = await duplicateProvider(id, newName);
      set((state) => ({
        providers: [...state.providers, duplicated],
        loading: false,
      }));
      return duplicated;
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to duplicate provider',
        loading: false,
      });
      throw err;
    }
  },

  reorderProviders: async (orderedIds: string[]) => {
    // 乐观更新
    const currentProviders = get().providers;
    const orderedIdSet = new Set(orderedIds);

    // 找出未被排序的 providers（不在 orderedIds 中的）
    const unorderedProviders = currentProviders.filter((p) => !orderedIdSet.has(p.id));

    // 被排序的 providers 使用新的 order
    const reorderedProviders = orderedIds
      .map((id, index) => {
        const provider = currentProviders.find((p) => p.id === id);
        return provider ? { ...provider, order: index } : null;
      })
      .filter((p): p is Provider => p !== null);

    // 未被排序的 providers 的 order 需要调整到排序后的后面
    const maxNewOrder = orderedIds.length;
    const adjustedUnorderedProviders = unorderedProviders
      .sort((a, b) => a.order - b.order)
      .map((p, index) => ({ ...p, order: maxNewOrder + index }));

    // 合并并按 order 排序
    const allProviders = [...reorderedProviders, ...adjustedUnorderedProviders].sort(
      (a, b) => a.order - b.order
    );

    set({ providers: allProviders });

    // 发送所有 providers 的 IDs 到后端
    const allOrderedIds = allProviders.map((p) => p.id);

    try {
      await reorderProviders(allOrderedIds);
    } catch (err) {
      // 回滚
      set({ providers: currentProviders });
      throw err;
    }
  },
}));

// 兼容性导出
export const useProfilesStore = useProvidersStore;
