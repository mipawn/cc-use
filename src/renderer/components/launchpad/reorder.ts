export function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  const next = [...items]
  const [item] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, item)
  return next
}

export function mergeVisibleOrder(
  allIds: string[],
  visibleIds: string[],
  nextVisibleIds: string[],
) {
  const visibleSet = new Set(visibleIds)
  let visibleIndex = 0
  return allIds.map((id) => {
    if (!visibleSet.has(id)) return id
    const nextId = nextVisibleIds[visibleIndex]
    visibleIndex += 1
    return nextId
  })
}

export function computeVisibleReorder(
  allIds: string[],
  visibleIds: string[],
  activeId: string,
  overId: string,
): string[] | null {
  const fromIndex = visibleIds.indexOf(activeId)
  const toIndex = visibleIds.indexOf(overId)
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null
  return mergeVisibleOrder(allIds, visibleIds, moveItem(visibleIds, fromIndex, toIndex))
}
