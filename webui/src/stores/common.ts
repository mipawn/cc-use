import { create } from 'zustand';
import type { Common } from '../api/client';
import { getCommon, setCommonForType } from '../api/client';

interface CommonState {
  common: Common;
  loading: boolean;
  error: string | null;

  // Actions
  fetchCommon: () => Promise<void>;
  updateCommon: (type: string, values: Record<string, string>) => Promise<void>;
}

export const useCommonStore = create<CommonState>((set) => ({
  common: {},
  loading: false,
  error: null,

  fetchCommon: async () => {
    set({ loading: true, error: null });
    try {
      const common = await getCommon();
      set({ common, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to fetch common config',
        loading: false,
      });
    }
  },

  updateCommon: async (type: string, values: Record<string, string>) => {
    set({ loading: true, error: null });
    try {
      await setCommonForType(type, values);
      // 重新获取完整的 common 配置
      const common = await getCommon();
      set({ common, loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to update common config',
        loading: false,
      });
      throw err;
    }
  },
}));

// 兼容性导出
export const useDefaultsStore = useCommonStore;
