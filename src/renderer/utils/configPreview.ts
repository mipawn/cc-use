/** Preview is read-only and must never expose proxy credentials in screenshots. */
export function redactConfigPreview(content: string): string {
  const secretKey = /api[_-]?key|token|secret|authorization|password/i
  const redact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redact)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          secretKey.test(key) ? '***' : redact(item),
        ]),
      )
    return value
  }
  let result: string
  try {
    result = JSON.stringify(redact(JSON.parse(content)), null, 2)
  } catch {
    // Codex's TOML credential assignments are line values. Mask sensitive
    // assignments (including multiline values) rather than parsing secrets.
    result = content.replace(
      /^(\s*[\w."'-]*(?:api[_-]?key|token|secret|authorization|password)[\w."'-]*\s*=\s*)(?:"""[\s\S]*?"""|'''[\s\S]*?'''|[^\r\n]*)/gim,
      '$1"***"',
    )
  }
  return result.replace(/\b(?:session-|sk-)[A-Za-z0-9_-]+/g, '***')
}
