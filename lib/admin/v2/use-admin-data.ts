// lib/admin/v2/use-admin-data.ts
//
// Vanilla useEffect hook over adminFetch. Handles loading/error/data
// states + a manual refetch trigger. NOT SWR — per the plan, SWR is its
// own decision and shouldn't sneak into the codebase via the admin build.
//
// Usage:
//   const { data, error, loading, refetch } = useAdminData<MyShape>('/api/admin/v2/incidents')
//
// Dependencies trigger a refetch (same useEffect dep semantics).

'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { adminFetch, type AdminFetchOptions } from './api-client'

export interface UseAdminDataResult<T> {
  data:    T | null
  error:   string | null
  loading: boolean
  refetch: () => Promise<void>
}

/**
 * Hook that fetches an admin endpoint and exposes the standard
 * loading/error/data tuple. Pass `null` URL to skip the fetch (useful
 * when waiting for a route param to be ready).
 */
export function useAdminData<T = any>(
  url:  string | null,
  opts: AdminFetchOptions = {},
): UseAdminDataResult<T> {
  const [data,    setData]    = useState<T | null>(null)
  const [error,   setError]   = useState<string | null>(null)
  const [loading, setLoading] = useState<boolean>(url !== null)
  // Hold the latest opts so callers can pass inline options without
  // re-running the fetch on every render. Refetch always uses the latest.
  const optsRef = useRef(opts)
  optsRef.current = opts

  const refetch = useCallback(async () => {
    if (!url) return
    setLoading(true)
    setError(null)
    try {
      const j = await adminFetch<T>(url, optsRef.current)
      setData(j)
    } catch (e: any) {
      setError(e?.message ?? 'Request failed')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [url])

  useEffect(() => {
    if (!url) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setError(null)
    adminFetch<T>(url, optsRef.current)
      .then(j => { if (!cancelled) setData(j) })
      .catch(e => { if (!cancelled) { setError(e?.message ?? 'Request failed'); setData(null) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [url])

  return { data, error, loading, refetch }
}
