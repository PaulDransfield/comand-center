'use client'
// components/VersionWatcher.tsx
//
// Polls /api/version and compares against the SHA baked into THIS bundle
// at build time. When they differ, a deploy has shipped and the tab is
// running stale code — show a small "Update available" pill so the
// owner can reload without knowing to hard-refresh.
//
// Mounted once in app/layout.tsx so every page benefits.

import { useEffect, useState } from 'react'

const POLL_INTERVAL_MS = 60_000        // 60s — catch within a minute
const INITIAL_DELAY_MS = 90_000        // 90s before first poll (let initial nav finish)

export default function VersionWatcher() {
  const [stale, setStale] = useState(false)

  useEffect(() => {
    // The SHA Webpack inlined into this bundle. 'dev' on local builds.
    const myVersion = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? 'dev'
    if (myVersion === 'dev') return    // Local dev — polling pointless

    let cancelled = false

    async function check() {
      try {
        const r = await fetch('/api/version', { cache: 'no-store' })
        if (!r.ok) return
        const { sha } = await r.json()
        if (cancelled) return
        if (sha && sha !== 'dev' && sha !== myVersion) {
          setStale(true)
          // Stop polling — banner is up, no more work to do.
          clearInterval(timer)
        }
      } catch {
        // Network blip / offline — silently ignore, try again next tick.
      }
    }

    // Initial delay so first navigation isn't competing for a fetch
    // socket; then steady cadence.
    const initialDelay = setTimeout(check, INITIAL_DELAY_MS)
    const timer = setInterval(check, POLL_INTERVAL_MS)

    // Catch users coming back to the tab after a long away — many people
    // leave tabs open all day, this is the most common stale-state moment.
    function onFocus() { check() }
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      clearTimeout(initialDelay)
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  if (!stale) return null

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 16,
        // Sit clear of the AskAI floating button (bottom-right). Place
        // on the LEFT so the two never collide on small screens.
        left: 16,
        zIndex: 400,         // toast layer per Z token scale
        background: '#1a1a1a',
        color: 'white',
        padding: '10px 14px',
        borderRadius: 8,
        fontSize: 13,
        fontFamily: 'inherit',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
        maxWidth: 360,
      }}
    >
      <span>A new update is available.</span>
      <button
        onClick={() => window.location.reload()}
        style={{
          background: 'white',
          color: '#1a1a1a',
          border: 'none',
          borderRadius: 6,
          padding: '6px 12px',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        Reload
      </button>
    </div>
  )
}
