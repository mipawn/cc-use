import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ConsoleEvent, ConsoleLogPage } from '@shared/types'
import { getApi } from '../api'
import {
  consoleEventLocalDay,
  getConsoleClearRevision,
  getConsoleHistoryMeta,
  getConsoleRetentionStartDate,
  isConsoleHistoryClearing,
  mergeConsoleEventList,
  subscribeConsoleStore,
} from '../api/consoleStore'

const getGeneration = () => getConsoleHistoryMeta().generation
const empty: ConsoleEvent[] = []

/** A read-only projection: never seed this result into the bounded global stream. */
export function useConsoleRequestProjection(requestId?: string) {
  const clearRevision = useSyncExternalStore(subscribeConsoleStore, getConsoleClearRevision)
  const generation = useSyncExternalStore(subscribeConsoleStore, getGeneration)
  const revision = useRef(0)
  const identity = `${requestId ?? ''}:${clearRevision}:${generation ?? ''}`
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const [state, setState] = useState<{
    identity: string
    page: ConsoleLogPage | null
    loading: boolean
    failed: boolean
  }>({ identity: '', page: null, loading: false, failed: false })
  const [cutoff, setCutoff] = useState(getConsoleRetentionStartDate)

  const refresh = useCallback(async () => {
    const requestRevision = ++revision.current
    if (!requestId || isConsoleHistoryClearing()) {
      setState({ identity, page: null, loading: false, failed: false })
      return
    }
    setState({ identity, page: null, loading: true, failed: false })
    try {
      const page = await getApi().console.readRequest(requestId, 500)
      if (
        revision.current !== requestRevision ||
        currentIdentity.current !== identity ||
        getConsoleClearRevision() !== clearRevision ||
        isConsoleHistoryClearing()
      )
        return
      const activeGeneration = getGeneration()
      // A newer global clear snapshot must never be populated by an older lookup.
      if (activeGeneration !== null && page.generation !== activeGeneration) {
        setState({ identity, page: null, loading: false, failed: true })
        return
      }
      setState({ identity, page, loading: false, failed: false })
    } catch {
      if (
        revision.current === requestRevision &&
        currentIdentity.current === identity &&
        getConsoleClearRevision() === clearRevision
      ) {
        setState({ identity, page: null, loading: false, failed: true })
      }
    }
  }, [requestId, identity, clearRevision])

  useEffect(() => {
    void refresh()
    return () => {
      revision.current += 1
    }
  }, [refresh])

  useEffect(() => {
    const check = () => setCutoff(getConsoleRetentionStartDate())
    const timer = window.setInterval(check, 25_000)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [])

  const active = state.identity === identity && !isConsoleHistoryClearing() ? state : null
  const events =
    active?.page?.records.reduce<ConsoleEvent[]>((rows, record) => {
      const event = record.event
      const day = consoleEventLocalDay(event.timestamp)
      if (
        event.category !== 'request' ||
        event.requestId !== requestId ||
        day === null ||
        day < cutoff
      )
        return rows
      return mergeConsoleEventList(rows, event)
    }, []) ?? empty

  return {
    events,
    page: active?.page ?? null,
    loading: Boolean(requestId) && (active?.loading ?? !isConsoleHistoryClearing()),
    failed: active?.failed ?? false,
    cutoff,
    refresh,
  }
}
