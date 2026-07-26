export interface ExactModelMapping {
  source: string
  target: string
}

export interface ModelMappingFields {
  haiku: string
  sonnet: string
  opus: string
  modelOverrides: ExactModelMapping[]
  codex: string
  grok: string
}

export const EMPTY_MODEL_MAPPING: ModelMappingFields = {
  haiku: '',
  sonnet: '',
  opus: '',
  modelOverrides: [],
  codex: '',
  grok: '',
}

export function parseModelMapping(value?: string | null): ModelMappingFields {
  if (!value) return { ...EMPTY_MODEL_MAPPING, modelOverrides: [] }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    const modelOverrides =
      parsed.modelOverrides &&
      typeof parsed.modelOverrides === 'object' &&
      !Array.isArray(parsed.modelOverrides)
        ? Object.entries(parsed.modelOverrides as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            .map(([source, target]) => ({ source, target }))
        : []

    return {
      haiku: typeof parsed.haiku === 'string' ? parsed.haiku : '',
      sonnet: typeof parsed.sonnet === 'string' ? parsed.sonnet : '',
      opus: typeof parsed.opus === 'string' ? parsed.opus : '',
      modelOverrides,
      codex: typeof parsed.codex === 'string' ? parsed.codex : '',
      grok: typeof parsed.grok === 'string' ? parsed.grok : '',
    }
  } catch {
    return { ...EMPTY_MODEL_MAPPING, modelOverrides: [] }
  }
}

export function serializeModelMapping(fields: ModelMappingFields): string | undefined {
  const mapping: Record<string, unknown> = {}

  for (const key of ['haiku', 'sonnet', 'opus'] as const) {
    const value = fields[key].trim()
    if (value) mapping[key] = value
  }

  const modelOverrides: Record<string, string> = {}
  for (const entry of fields.modelOverrides) {
    const source = entry.source.trim()
    const target = entry.target.trim()
    if (source && target) modelOverrides[source] = target
  }
  if (Object.keys(modelOverrides).length > 0) mapping.modelOverrides = modelOverrides

  for (const key of ['codex', 'grok'] as const) {
    const value = fields[key].trim()
    if (value) mapping[key] = value
  }

  return Object.keys(mapping).length > 0 ? JSON.stringify(mapping) : undefined
}

export function modelMappingValueForSave(
  fields: ModelMappingFields,
  isEditing: boolean,
): string | undefined {
  return serializeModelMapping(fields) ?? (isEditing ? '' : undefined)
}
