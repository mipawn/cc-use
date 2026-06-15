/**
 * 国内/主流 Claude Code & Codex 中转站与官方 API 预设（精简版）。
 *
 * v3.2.0 精简到 5 个核心预设，每个都包含格式转换配置。
 */
import type { ProviderType } from '../types'

export interface ProviderPreset {
  /** 稳定唯一 id，用于 keying 和 i18n 引用。 */
  id: string
  /** 默认显示名（用户可改）。 */
  name: string
  /** 默认 Base URL（用户可改）。 */
  baseUrl: string
  /** 该供应商最常见的主类型。 */
  providerType: ProviderType
  /** API 格式：'auto' | 'anthropic_messages' | 'openai_chat' | 'codex_responses' */
  apiFormat: string
  /** 是否默认启用格式转换 */
  transformEnabled: boolean
  /** 对应 assets/provider-icons/ 中的图标 key。 */
  icon: string
  /** 官网/控制台链接（用于"访问官网"按钮）。 */
  website?: string
  /** 简短说明（显示在预设卡片下方）。 */
  note?: string
  /** 赠送/优惠码（如有）。 */
  discountCode?: string
  /** 优惠说明。 */
  discountNote?: string
}

/**
 * 预设清单（精简到 5 个核心）。
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    providerType: 'codex',
    apiFormat: 'openai_chat',
    transformEnabled: true,
    icon: 'deepseek',
    website: 'https://platform.deepseek.com',
    note: 'DeepSeek-V3 / R1，支持推理链，已自动配置格式转换',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    providerType: 'codex',
    apiFormat: 'openai_chat',
    transformEnabled: true,
    icon: 'minimax',
    website: 'https://platform.minimaxi.com',
    note: 'MiniMax-M 系列，已自动配置格式转换',
  },
  {
    id: 'newapi',
    name: 'NewAPI',
    baseUrl: 'http://localhost:3000/v1',
    providerType: 'claude',
    apiFormat: 'auto',
    transformEnabled: false,
    icon: 'newapi',
    website: 'https://github.com/Calcium-Ion/new-api',
    note: '自建中转网关，请根据实际配置手动选择 API 格式',
  },
  {
    id: 'sub2api',
    name: 'Sub2API',
    baseUrl: 'https://api.sub2api.com/v1',
    providerType: 'claude',
    apiFormat: 'anthropic_messages',
    transformEnabled: false,
    icon: 'sub2api',
    website: 'https://sub2api.com',
    note: 'Claude / Codex 原生兼容，无需格式转换',
  },
  {
    id: 'anyrouter',
    name: 'AnyRouter',
    baseUrl: 'https://api.anyrouter.ai/v1',
    providerType: 'codex',
    apiFormat: 'openai_chat',
    transformEnabled: true,
    icon: 'custom',
    website: 'https://anyrouter.ai',
    note: '多模型聚合路由，已自动配置格式转换',
  },
]

/**
 * 按 id 查找预设。返回 undefined 时调用方应回退到手动表单。
 */
export function findPresetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id)
}

