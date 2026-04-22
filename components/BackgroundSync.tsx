'use client'
// components/BackgroundSync.tsx
//
// Fires /api/sync/today on mount for the currently-selected business.
// Fire-and-forget — no UI, no error surface. The API route is throttled
// server-side to 10 min per integration, so repeated navigation between
// pages (which remounts AppShell → remounts this component) is cheap:
// subsequent calls return "skipped: throttled" without doing real work.
//
// Pairs with the 3×/day catchup-sync cron. Crons cover the baseline
// (10/14/18 UTC); this covers active users who want to see up-to-date
// numbers the moment they open the app after, say, a busy lunch service.
//
// Intentionally does nothing for the first ~1s — lets the page finish
// hydrating and the heavy API calls (KPIs, chart) go out first. Sync
// work is background; it should not compete with the data the user is
// actually waiting to see.

import { useEffect } from 'react'

export default function BackgroundSync() {
  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      if (cancelled) return
      const bizId = typeof window !== 'undefined' ? localStorage.getItem('cc_selected_biz') : null
      if (!bizId) return

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
