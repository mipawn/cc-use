import { useEffect, useRef } from 'react'
import { registerPageRefresh, type PageRefreshHandler } from '../api/pageRefresh'

/**
 * Register `handler` as the refresh routine for the page currently mounted.
 *
 * The latest handler is always used, so a refresh re-reads with the filters and
 * pagination the user has right now rather than the ones captured at mount.
 */
export function usePageRefresh(handler: PageRefreshHandler) {
  const handlerRef = useRef(handler)

  useEffect(() => {
    handlerRef.current = handler
  })

  useEffect(() => registerPageRefresh(() => handlerRef.current()), [])
}
