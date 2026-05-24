'use client'
// components/BrokenIntegrationBanner.tsx
//
// Sticky red banner shown at the top of every authenticated page when
// the current org has any integration in status needs_reauth/error.
// Owners shouldn't have to navigate to /integrations to discover that
// their data is stale.
//
// Lazy: only fetches once per page load. Hides itself when no broken
// integrations. Dismissable per-session so it doesn't block the UI
// (but it'll reappear on next page load until the owner reconnects).

import { useCallback, useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'

interface Broken {
  id:            string
  business_id:   string
  business_name: string
  provider:      string
  status:        string
  last_error:    string | null
}

const SESSION_DISMISS_KEY = 'cc_broken_integration_dismissed_until'

export default function BrokenIntegrationBanner() {
  const router   = useRouter()
  const pathname = usePathname()
  const [broken,    setBroken]    = useState<Broken[]>([])
  const [dismissed, setDismissed] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/me/broken-integrations', { cache: 'no-store' })
      if (!r.ok) return
      const j = await r.json()
      setBroken(j.broken ?? [])
    } catch { /* swallow */ }
  }, [])

  useEffect(() => {
    // Hide on auth / settings pages where it'd be noisy
    if (!pathname) return
    if (/^\/(login|signup|reset-password|onboarding|integrations)\b/.test(pathname)) return
    load()
  }, [pathname, load])

  useEffect(() => {
    // Per-session dismissal — re-shows on next browser tab
    try {
      const until = Number(sessionStorage.getItem(SESSION_DISMISS_KEY) ?? '0')
      if (until > Date.now()) setDismissed(true)
    } catch { /* swallow */ }
  }, [])

  if (dismissed || broken.length === 0) return null

  // Most owners have ONE broken integration at a time. Show the first
  // with a count badge if there are more.
  const primary = broken[0]
  const extraCount = broken.length - 1

  function dismiss() {
    try {
      // Dismiss for 4 hours so it doesn't nag every page load
      sessionStorage.setItem(SESSION_DISMISS_KEY, String(Date.now() + 4 * 60 * 60 * 1000))
    } catch { /* swallow */ }
    setDismissed(true)
  }

  function reconnect() {
    router.push('/integrations')
  }

  return (
    <div role="alert" style={{
      position:   'sticky' as const, top: 0, zIndex: 90,
      background: '#fef2f2',
      borderBottom: '0.5px solid #fca5a5',
      padding:    '8px 16px',
      display:    'flex', alignItems: 'center', gap: 12,
      fontSize:   12, color: '#7f1d1d',
    }}>
      <div style={{ flex: 1, lineHeight: 1.4 }}>
        <strong>{primary.provider.toUpperCase()} connection broken</strong>
        {' '}for <strong>{primary.business_name}</strong>.
        {extraCount > 0 && (
          <span style={{ marginLeft: 6, fontSize: 11, color: '#a16207' }}>
            +{extraCount} other broken integration{extraCount > 1 ? 's' : ''}
          </span>
        )}
        <span style={{ marginLeft: 8, color: '#a16207', fontSize: 11 }}>
          Sync paused — reconnect to restore.
        </span>
      </div>
      <button onClick={reconnect}
        style={{
          padding: '4px 12px', fontSize: 11, fontWeight: 600,
          background: '#7c3aed', color: '#fff',
          border: 'none', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
        }}>
        Reconnect
      </button>
      <button onClick={dismiss}
        aria-label="Dismiss for 4 hours"
        style={{
          padding: '4px 8px', fontSize: 14, fontWeight: 400,
          background: 'transparent', color: '#7f1d1d',
          border: 'none', cursor: 'pointer', fontFamily: 'inherit',
        }}>
        ×
      </button>
    </div>
  )
}
