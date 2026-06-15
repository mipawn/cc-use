/**
 * 国内/主流 Claude Code & Codex 中转站与官方 API 预设。
 *
 * 设计要点：
 * - 纯静态数据，无后端依赖；QuickAddModal 直接消费。
 * - `icon` 字段对应 `PresetIcon` 的子集；缺失图标时落到 `custom`。
 * - `providerType` 是该供应商最常见的主类型（多数中转站同时兼容两者，
 *   但选一个默认值能减少用户操作）。
 * - `discountCode` / `discountNote` 可选，用于展示中转站赠送/优惠信息，
 *   实际使用由用户在对应平台自助操作。
 * - 新增预设只需追加一项；社区 PR 请同步更新 docs/PROVIDER-PRESETS.md。
 *
 * Base URL 的选择原则：
 * 1. 官方文档明确给出的 Claude/Codex 兼容入口优先。
 * 2. 多数中转站使用 `/v1` 前缀（OpenAI 风格）；Claude 原生中转使用根域。
 * 3. 如果不确定，留 `/v1` —— 用户可在表单里直接改。
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
 * 预设清单。顺序即 UI 显示顺序。
 * 官方入口放最前，国内中转站其次，通用聚合器最后。
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ── 官方入口 ──
  {
    id: 'anthropic-official',
    name: 'Anthropic 官方',
    baseUrl: 'https://api.anthropic.com',
    providerType: 'claude',
    icon: 'claude',
    website: 'https://www.anthropic.com',
    note: 'Claude 官方 API，需海外网络',
  },
  {
    id: 'openai-official',
    name: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    providerType: 'codex',
    icon: 'openai',
    website: 'https://platform.openai.com',
    note: 'OpenAI 官方 API，用于 Codex',
  },
  // ── 国内官方厂商 ──
  {
    id: 'zhipu-glm',
    name: '智谱 GLM (z.ai)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    providerType: 'claude',
    icon: 'zhipu',
    website: 'https://z.ai',
    note: 'GLM-4.6 / GLM-4.5，Claude 兼容入口',
    discountCode: 'cc-use',
    discountNote: '注册可获赠额度',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    providerType: 'codex',
    icon: 'deepseek',
    website: 'https://platform.deepseek.com',
    note: 'DeepSeek-V3 / R1，OpenAI 兼容',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    providerType: 'codex',
    icon: 'minimax',
    website: 'https://platform.minimaxi.com',
    note: 'MiniMax-M 系列，OpenAI 兼容',
  },
  // ── 国内聚合/中转平台 ──
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    providerType: 'codex',
    icon: 'siliconflow',
    website: 'https://siliconflow.cn',
    note: '多模型聚合，OpenAI 兼容',
    discountCode: 'cc-use',
    discountNote: '新用户赠送 14 元额度',
  },
  {
    id: 'newapi',
    name: 'NewAPI / OneAPI',
    baseUrl: 'http://localhost:3000/v1',
    providerType: 'claude',
    icon: 'newapi',
    website: 'https://github.com/Calcium-Ion/new-api',
    note: '自建中转网关，请替换为你的部署地址',
  },
  {
    id: 'sub2api',
    name: 'Sub2API',
    baseUrl: 'https://api.sub2api.com/v1',
    providerType: 'claude',
    icon: 'sub2api',
    website: 'https://sub2api.com',
    note: 'Claude / Codex 双兼容中转',
  },
  // ── 其它常见中转站（占位，用户可按需补充） ──
  {
    id: 'aihubmix',
    name: 'AiHubMix',
    baseUrl: 'https://aihubmix.com/v1',
    providerType: 'claude',
    icon: 'custom',
    website: 'https://aihubmix.com',
    note: '多模型聚合中转',
  },
  {
    id: 'dmxapi',
    name: 'DMXAPI',
    baseUrl: 'https://www.dmxapi.cn/v1',
    providerType: 'claude',
    icon: 'custom',
    website: 'https://www.dmxapi.cn',
    note: '多模型聚合中转',
  },
  {
    id: 'volcengine-doubao',
    name: '火山方舟 (豆包)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    providerType: 'codex',
    icon: 'custom',
    website: 'https://www.volcengine.com/product/ark',
    note: '豆包系列，OpenAI 兼容',
  },
  {
    id: 'bailian',
    name: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    providerType: 'codex',
    icon: 'custom',
    website: 'https://bailian.console.aliyun.com',
    note: '通义系列，OpenAI 兼容入口',
  },
]

/**
 * 按 id 查找预设。返回 undefined 时调用方应回退到手动表单。
 */
export function findPresetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.id === id)
}
