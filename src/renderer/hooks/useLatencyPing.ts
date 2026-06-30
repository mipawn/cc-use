import { useEffect, useRef, useState } from 'react'
import { getApi } from '../api'
import type { LatencyReport } from '../../shared/types'

const PING_INTERVAL_MS = 60_000

/// Polls daemon + upstream latency: probes once on mount, then every 60s,
/// and stops when the component unmounts or the tab is hidden (resuming on
/// re-show). `upstreamBaseUrl` may change as the user switches the active
/// provider — the next tick picks up the new value.
export function useLatencyPing(upstreamBaseUrl: string | undefined) {
  const [report, setReport] = useState<LatencyReport | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Hold the latest base URL so the interval callback always probes the
  // current provider without resubscribing the timer on every change.
  const urlRef = useRef(upstreamBaseUrl)
  urlRef.current = upstreamBaseUrl

  useEffect(() => {
    let cancelled = false

    const probe = async () => {
      try {
        const result = await getApi().proxy.latencyProbe(urlRef.current)
        if (!cancelled) setReport(result)
      } catch (e) {
        // Keep the previous report on transient failures; retry next tick.
        console.error('Latency probe failed:', e)
      }
    }

    const start = () => {
      if (timerRef.current) return
      void probe()
      timerRef.current = setInterval(probe, PING_INTERVAL_MS)
    }

    const stop = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }

    const onVisibility = () => {
      if (document.hidden) stop()
      else start()
    }

    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return report
}
