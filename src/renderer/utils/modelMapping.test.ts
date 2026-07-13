import { describe, expect, it } from 'vitest'
import { EMPTY_MODEL_MAPPING, parseModelMapping, serializeModelMapping } from './modelMapping'

describe('model mapping serialization', () => {
  it('parses Claude and Codex mappings from the same JSON value', () => {
    expect(
      parseModelMapping(
        JSON.stringify({
          haiku: 'claude-haiku-upstream',
          sonnet: 'claude-sonnet-upstream',
          codex: 'deepseek-chat',
        }),
      ),
    ).toEqual({
      ...EMPTY_MODEL_MAPPING,
      haiku: 'claude-haiku-upstream',
      sonnet: 'claude-sonnet-upstream',
      codex: 'deepseek-chat',
    })
  })

  it('serializes non-empty Claude and Codex mappings after trimming values', () => {
    expect(
      serializeModelMapping({
        ...EMPTY_MODEL_MAPPING,
        sonnet: ' claude-sonnet-upstream ',
        codex: ' deepseek-chat ',
      }),
    ).toBe('{"sonnet":"claude-sonnet-upstream","codex":"deepseek-chat"}')
  })

  it('returns an empty mapping for invalid JSON and omits all-empty mappings', () => {
    expect(parseModelMapping('{invalid')).toEqual(EMPTY_MODEL_MAPPING)
    expect(serializeModelMapping(EMPTY_MODEL_MAPPING)).toBeUndefined()
  })
})
