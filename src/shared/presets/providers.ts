/**
 * 国内/主流 Claude Code & Codex 中转站与官方 API 预设。
 *
 * v3.2.0 内置预设只保留 DeepSeek、NewAPI；Custom 为手动入口，无需预设条目。
 * MiniMax、Sub2API、AnyRouter 等不再作为内置预设，用户可通过 Custom 手动配置。
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
 * 预设清单（v3.2.0 内置：DeepSeek、NewAPI）。
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
]

/**
 * 按 id 查找预设。返回 undefined 时调用方应回退到手动表单。
 */
export function findPresetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id)
}
