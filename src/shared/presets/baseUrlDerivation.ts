/**
 * 一个供应商对多客户端派生默认 baseUrl。
 *
 * 规则对照 cc-switch `UniversalProvider::to_codex_provider`（v3.16.3，已核对）：
 * - 已以 `/v1` 结尾 → 原样保留
 * - 纯 origin（`scheme://host`，host 后无路径）→ 补 `/v1`
 * - 带自定义路径前缀（如 `host/openai`）→ 不强补
 *
 * Claude（Anthropic）入口按 cc-switch 的做法直接用 base，不强补 `/v1`
 * （Anthropic 约定 base 形如 `https://api.anthropic.com`）。
 *
 * 派生只用于「填默认值」，用户保存后是确定的 endpoint baseUrl，可被完整覆盖。
 */
export type DerivableClient = 'codex' | 'claude_code' | 'claude_desktop'

/** 去掉尾部斜杠；空白输入归一为空串。 */
export function normalizeBaseUrl(base: string): string {
  return base.trim().replace(/\/+$/, '')
}

/** 是否为纯 origin（scheme://host，host 之后无路径段）。 */
export function isOriginOnly(base: string): boolean {
  const trimmed = normalizeBaseUrl(base)
  const schemeSplit = trimmed.split('://')
  if (schemeSplit.length === 2) {
    return !schemeSplit[1].includes('/')
  }
  return !trimmed.includes('/')
}

/** Codex 默认 baseUrl：纯 origin 补 `/v1`，已有 `/v1` 或自定义前缀则原样。 */
export function deriveCodexBaseUrl(base: string): string {
  const trimmed = normalizeBaseUrl(base)
  if (!trimmed) return ''
  if (trimmed.endsWith('/v1')) return trimmed
  if (isOriginOnly(trimmed)) return `${trimmed}/v1`
  return trimmed
}

/** 按客户端类型派生默认 baseUrl。 */
export function deriveBaseUrl(base: string, client: DerivableClient): string {
  const trimmed = normalizeBaseUrl(base)
  if (!trimmed) return ''
  switch (client) {
    case 'codex':
      return deriveCodexBaseUrl(trimmed)
    case 'claude_code':
    case 'claude_desktop':
      // Anthropic 入口直接用 base，不强补 /v1（与 cc-switch to_claude_provider 一致）
      return trimmed
  }
}
