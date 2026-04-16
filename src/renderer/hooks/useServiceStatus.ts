import { useCallback, useEffect, useState } from 'react'
import { getApi } from '../api'
import type { ProxyStatus } from '@shared/types'

const DEFAULT_STATUS: ProxyStatus = {
  isRunning: false,
  port: 12345,
  requestCount: 0,
  lastError: null,
}

export function useServiceStatus() {
  const [status, setStatus] = useState<ProxyStatus>(DEFAULT_STATUS)
  const [loading, setLoading] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const s = await getApi().proxy.status()
      setStatus(s)
    } catch (error) {
      console.error('Failed to fetch service status:', error)
      setStatus(DEFAULT_STATUS)
    }
  }, [])

  const restart = useCallback(async () => {
    setLoading(true)
    try {
      await getApi().proxy.restart()
      await fetchStatus()
    } finally {
      setLoading(false)
    }
  }, [fetchStatus])

  useEffect(() => {
    fetchStatus()

    const unsubscribe = getApi().proxy.onStatusChanged((data) => {
      setStatus((prev) => ({
        ...prev,
        isRunning: data.isRunning,
        port: data.port,
      }))
    })

    return () => {
      unsubscribe()
    }
  }, [fetchStatus])

  return { status, loading, restart, fetchStatus }
}
