export interface ModelMappingFields {
  haiku: string
  sonnet: string
  opus: string
  default: string
  codex: string
}

export const EMPTY_MODEL_MAPPING: ModelMappingFields = {
  haiku: '',
  sonnet: '',
  opus: '',
  default: '',
  codex: '',
}

export function parseModelMapping(value?: string | null): ModelMappingFields {
  if (!value) return { ...EMPTY_MODEL_MAPPING }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return {
      haiku: typeof parsed.haiku === 'string' ? parsed.haiku : '',
      sonnet: typeof parsed.sonnet === 'string' ? parsed.sonnet : '',
      opus: typeof parsed.opus === 'string' ? parsed.opus : '',
      default: typeof parsed.default === 'string' ? parsed.default : '',
      codex: typeof parsed.codex === 'string' ? parsed.codex : '',
    }
  } catch {
    return { ...EMPTY_MODEL_MAPPING }
  }
}

export function serializeModelMapping(fields: ModelMappingFields): string | undefined {
  const mapping: Record<string, string> = {}

  for (const key of ['haiku', 'sonnet', 'opus', 'default', 'codex'] as const) {
    const value = fields[key].trim()
    if (value) mapping[key] = value
  }

  return Object.keys(mapping).length > 0 ? JSON.stringify(mapping) : undefined
}
