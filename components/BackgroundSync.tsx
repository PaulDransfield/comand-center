'use client'
// components/BackgroundSync.tsx
//
// Fires /api/sync/today on mount for the currently-selected business.
// Fire-and-forget — no UI, no error surface.
//
// Client-side throttle is critical for performance: AppShell remounts on
// every route change, so without this every page click would trigger a
// fresh fetch → Vercel function cold start → DB lookup even though the
// server would then reply "skipped: throttled". A 10-minute sessionStorage
// gate means at most ~6 background syncs per user per hour, not "one per
// navigation".
//
// Pairs with the 3×/day catchup-sync cron.

import { useEffect } from 'react'

const SESSION_KEY = 'cc_bg_sync_last_ms'
const THROTTLE_MS = 10 * 60 * 1000   // must match the server's THROTTLE_MS

export default function BackgroundSync() {
  useEffect(() => {
    if (typeof window === 'undefined') return
    let cancelled = false
    const t = setTimeout(() => {
      if (cancelled) return

      // Client-side throttle. Even though the server will also return
      // "skipped" after 10 minutes, the cold start + DB round-trip for
      // that skip is what was making navigation feel slow.
      const lastMs = Number(sessionStorage.getItem(SESSION_KEY) ?? '0')
      if (lastMs && Date.now() - lastMs < THROTTLE_MS) return

      const bizId = localStorage.getItem('cc_selected_biz')
      if (!bizId) return

      sessionStorage.setItem(SESSION_KEY, String(Date.now()))

      fetch(`/api/sync/today?business_id=${encodeURIComponent(bizId)}`, {
        method:      'POST',
        cache:       'no-store',
        credentials: 'same-origin',
      }).catch(() => { /* silent — never surface sync failures to the user */ })
    }, 1200)

    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [])

  return null
}
