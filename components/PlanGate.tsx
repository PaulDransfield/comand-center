// components/PlanGate.tsx
//
// Client-side subscription gate rendered inside AppShell. Fetches
// /api/me/plan on mount; if the user's org has no active paid plan
// (trial, past_due, unknown) AND they're on a gated route, redirects to
// /upgrade?required=1.
//
// Routes that stay open regardless of plan:
//   /upgrade        — where they pick a plan
//   /settings       — account management (email, delete account)
//   /onboarding     — first-run setup
//   /account        — same as settings on some mount points
//
// This complements the session-presence check in middleware.ts (which
// kicks logged-out users to /login). This gate enforces paid-subscription.

'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'

const OPEN_PATH_PREFIXES = [
  '/upgrade',
  '/settings',
  '/account',
  '/onboarding',
  '/privacy',
  '/terms',
  '/security',
]

export default function PlanGate() {
  const pathname = usePathname()
  const router   = useRouter()

  useEffect(() => {
    // Skip the check on pages that stay open regardless of subscription.
    if (!pathname) return
    if (OPEN_PATH_PREFIXES.some(p => pathname.startsWith(p))) return

    let cancelled = false
    async function check() {
      try {
        const r = await fetch('/api/me/plan')
        if (!r.ok) return                         // 401 etc. — middleware handles auth
        const j = await r.json()
        if (cancelled) return
        if (j.requiresUpgrade) {
          const reason = j.reason === 'past_due' ? 'past_due' : 'required'
          router.replace(`/upgrade?${reason}=1`)
        }
      } catch {
        // Non-fatal — if the plan check fails we let them through. They hit
        // a real 402/limit on their first paid action.
      }
    }
    check()
    return () => { cancelled = true }
  }, [pathname, router])

  return null
}
