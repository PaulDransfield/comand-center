'use client'
// components/BackgroundSync.tsx
//
// Fires /api/sync/today on mount for the currently-selected business.
// If the sync fetched new data (synced > 0), reloads the page so the
// dashboard/staff/revenue pages show fresh numbers without the user
// having to manually refresh.
//
// Client-side throttle: AppShell remounts on every route change.
// A 10-minute sessionStorage gate means at most ~6 background syncs
// per user per hour. The server has a matching throttle on /api/sync/today.

import { useEffect } from 'react'

const SESSION_KEY = 'cc_bg_sync_last_ms'
const THROTTLE_MS = 10 * 60 * 1000

export default function BackgroundSync() {
  useEffect(() => {
    if (typeof window === 'undefined') return
    let cancelled = false
    const t = setTimeout(async () => {
      if (cancelled) return

      const lastMs = Number(sessionStorage.getItem(SESSION_KEY) ?? '0')
      if (lastMs && Date.now() - lastMs < THROTTLE_MS) return

      const bizId = localStorage.getItem('cc_selected_biz')
      if (!bizId) return

      sessionStorage.setItem(SESSION_KEY, String(Date.now()))

      try {
        const res = await fetch(`/api/sync/today?business_id=${encodeURIComponent(bizId)}`, {
          method:      'POST',
          cache:       'no-store',
          credentials: 'same-origin',
        })
        if (res.ok) {
          const j = await res.json().catch(() => ({}))
          // Reload if the sync actually wrote new rows so the dashboard
          // picks up fresh daily_metrics without a manual refresh.
          if (j.synced > 0 && j.errors === 0 && !cancelled) {
            window.location.reload()
          }
        }
      } catch {
        // Never surface sync errors — this is background-only
      }
    }, 1200)

    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [])

  return null
}
