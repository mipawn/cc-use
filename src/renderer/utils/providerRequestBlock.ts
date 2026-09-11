/**
 * The editable "request block" shown in a provider's balance settings.
 *
 * The block is the request itself — method, URL and headers — and it is
 * authoritative: whatever it says is what gets sent. What it deliberately does
 * NOT carry is the parse rule, because that is a different fact: the same
 * request can be read as New API quota, as a DeepSeek balance object, or as a
 * bare number. Keeping them apart is what lets the URL be edited without
 * silently changing how the answer is interpreted.
 *
 * Grammar (one per line):
 *
 *     GET <url>
 *     <Header-Name>: <value>
 *     <Header-Name>: <value>
 *     取值: <json path>
 *
 * The method is informational — every query here is a GET — but it is shown
 * because that is what the request actually is. `取值` is where the number is
 * read from in the response; it is a line here rather than a separate field
 * because it is the other half of the same instruction. A blank line is
 * ignored, so it cannot become an empty header.
 */

export interface ProviderRequest {
  url: string
  /** Ordered so the block round-trips without reshuffling what the user typed. */
  headers: { name: string; value: string }[]
  /** JSON path to the value, for a rule that reads one. Empty when it does not. */
  path: string
}

/** The keyword that introduces the value path. */
const PATH_KEY = '取值'

/**
 * Words that introduce a URL rather than a header.
 *
 * Restricted to the real methods so a header written with a space instead of a
 * colon reports "unreadable" rather than being mistaken for a verb.
 */
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

export type ParseResult =
  | { ok: true; request: ProviderRequest }
  | { ok: false; error: string }

const HEADER_LINE = /^([^:\s][^:]*):\s*(.*)$/

/** Render a request as the editable block. */
export function formatRequestBlock(request: ProviderRequest): string {
  const lines: string[] = []
  if (request.url.trim()) {
    lines.push(`GET ${request.url.trim()}`)
  }
  for (const header of request.headers) {
    if (!header.name.trim()) continue
    lines.push(`${header.name.trim()}: ${header.value.trim()}`)
  }
  if (request.path.trim()) {
    lines.push(`${PATH_KEY}: ${request.path.trim()}`)
  }
  return lines.join('\n')
}

/**
 * Read a block back. Everything here is user input, so a malformed line is
 * reported with its line number rather than dropped — silently ignoring a line
 * the user typed would leave them believing a header was sent.
 */
export function parseRequestBlock(text: string): ParseResult {
  const headers: { name: string; value: string }[] = []
  let url = ''
  let path = ''

  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!line) continue
    const lineNumber = index + 1

    const pathMatch = new RegExp(`^${PATH_KEY}\\s*[:：]\\s*(.*)$`).exec(line)
    if (pathMatch) {
      if (path) return { ok: false, error: `第 ${lineNumber} 行：只能有一个取值路径` }
      path = pathMatch[1].trim()
      continue
    }

    const methodMatch = /^([A-Za-z]+)\s+(\S.*)$/.exec(line)
    if (methodMatch && HTTP_METHODS.includes(methodMatch[1].toUpperCase())) {
      const method = methodMatch[1].toUpperCase()
      if (method !== 'GET') {
        return { ok: false, error: `第 ${lineNumber} 行：只支持 GET，写的是 ${method}` }
      }
      if (url) return { ok: false, error: `第 ${lineNumber} 行：只能有一个 URL` }
      // The rest is taken as written. A default request is templated, so it
      // carries no scheme of its own — `{baseUrl}/api/user/self` — and
      // demanding one here would reject the very request the dialog wrote.
      url = methodMatch[2].trim()
      continue
    }

    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(line)) {
      // A bare URL with no method, which the block writer never emits but a
      // person editing by hand naturally writes.
      if (url) return { ok: false, error: `第 ${lineNumber} 行：只能有一个 URL` }
      url = line
      continue
    }

    const headerMatch = HEADER_LINE.exec(line)
    if (headerMatch) {
      const name = headerMatch[1].trim()
      if (name.toUpperCase() === 'GET') {
        return { ok: false, error: `第 ${lineNumber} 行：URL 写成了 header，应写成 GET <url>` }
      }
      headers.push({ name, value: headerMatch[2].trim() })
      continue
    }

    return {
      ok: false,
      error: `第 ${lineNumber} 行无法识别：应写成 GET <url> 或 名称: 值`,
    }
  }

  return { ok: true, request: { url, headers, path } }
}

/** The request block as the stored `headers` column: a JSON object, or empty. */
export function headersToStoredValue(headers: { name: string; value: string }[]): string {
  const carried = headers.filter((header) => header.name.trim())
  if (carried.length === 0) return ''
  const object: Record<string, string> = {}
  for (const header of carried) {
    object[header.name.trim()] = header.value
  }
  return JSON.stringify(object, null, 2)
}

/**
 * Read the stored `headers` column back into ordered pairs.
 *
 * A non-empty value that yields no pairs is unreadable — written by hand, or
 * by a build that stored something other than JSON. The caller shows that
 * rather than treating it as "no headers": silently rendering it empty would
 * let the next save erase it.
 */
export function storedValueToHeaders(raw: string | null | undefined): {
  name: string
  value: string
}[] {
  const text = raw?.trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    return Object.entries(parsed as Record<string, unknown>).map(([name, value]) => ({
      name,
      value: typeof value === 'string' ? value : JSON.stringify(value),
    }))
  } catch {
    return []
  }
}

/** Whether a stored headers value exists but could not be read back. */
export function isStoredHeadersUnreadable(raw: string | null | undefined): boolean {
  return Boolean(raw?.trim()) && storedValueToHeaders(raw).length === 0
}
