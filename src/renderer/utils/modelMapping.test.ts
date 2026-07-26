import { describe, expect, it } from 'vitest'
import {
  EMPTY_MODEL_MAPPING,
  modelMappingValueForSave,
  parseModelMapping,
  serializeModelMapping,
} from './modelMapping'

describe('model mapping serialization', () => {
  it('parses Claude and Codex mappings from the same JSON value', () => {
    expect(
      parseModelMapping(
        JSON.stringify({
          haiku: 'claude-haiku-upstream',
          sonnet: 'claude-sonnet-upstream',
          default: 'legacy-fallback',
          modelOverrides: {
            'claude-opus-4-8': 'claude-opus-4-6',
          },
          codex: 'deepseek-chat',
          grok: 'grok-build-0.1',
        }),
      ),
    ).toEqual({
      ...EMPTY_MODEL_MAPPING,
      haiku: 'claude-haiku-upstream',
      sonnet: 'claude-sonnet-upstream',
      modelOverrides: [
        {
          source: 'claude-opus-4-8',
          target: 'claude-opus-4-6',
        },
      ],
      codex: 'deepseek-chat',
      grok: 'grok-build-0.1',
    })
  })

  it('serializes non-empty Claude and Codex mappings after trimming values', () => {
    expect(
      serializeModelMapping({
        ...EMPTY_MODEL_MAPPING,
        sonnet: ' claude-sonnet-upstream ',
        modelOverrides: [
          {
            source: ' claude-opus-4-8 ',
            target: ' claude-opus-4-6 ',
          },
        ],
        codex: ' deepseek-chat ',
        grok: ' grok-build-0.1 ',
      }),
    ).toBe(
      '{"sonnet":"claude-sonnet-upstream","modelOverrides":{"claude-opus-4-8":"claude-opus-4-6"},"codex":"deepseek-chat","grok":"grok-build-0.1"}',
    )
  })

  it('ignores the legacy default fallback and omits all-empty mappings', () => {
    expect(parseModelMapping('{"default":"legacy-fallback"}')).toEqual(EMPTY_MODEL_MAPPING)
    expect(parseModelMapping('{invalid')).toEqual(EMPTY_MODEL_MAPPING)
    expect(serializeModelMapping(EMPTY_MODEL_MAPPING)).toBeUndefined()
  })

  it('drops incomplete exact mappings and lets the last duplicate win', () => {
    expect(
      serializeModelMapping({
        ...EMPTY_MODEL_MAPPING,
        modelOverrides: [
          { source: 'claude-opus-4-8', target: '' },
          { source: '', target: 'unused' },
          { source: 'claude-opus-4-8', target: 'first-target' },
          { source: 'claude-opus-4-8', target: 'final-target' },
        ],
      }),
    ).toBe('{"modelOverrides":{"claude-opus-4-8":"final-target"}}')
  })

  it('sends an explicit clear signal only when editing an existing key', () => {
    expect(modelMappingValueForSave(EMPTY_MODEL_MAPPING, true)).toBe('')
    expect(modelMappingValueForSave(EMPTY_MODEL_MAPPING, false)).toBeUndefined()
  })
})
