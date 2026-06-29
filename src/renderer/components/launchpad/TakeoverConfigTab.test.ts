import { describe, expect, it } from 'vitest'
import { computeVisibleReorder, mergeVisibleOrder, moveItem } from './reorder'

describe('TakeoverConfigTab reorder helpers', () => {
  it('moves an item inside a list', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
  })

  it('merges reordered visible ids back into the full order', () => {
    expect(
      mergeVisibleOrder(
        ['provider-a', 'provider-hidden', 'provider-b', 'provider-c'],
        ['provider-a', 'provider-b', 'provider-c'],
        ['provider-c', 'provider-a', 'provider-b'],
      ),
    ).toEqual(['provider-c', 'provider-hidden', 'provider-a', 'provider-b'])
  })

  it('returns null when dragging outside the same visible set', () => {
    expect(computeVisibleReorder(['a', 'b', 'c'], ['a', 'b'], 'a', 'c')).toBeNull()
  })
})
