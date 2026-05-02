// components/OnboardingGate.tsx
//
// Client-side completion gate rendered inside AppShell BEFORE PlanGate.
// Mirrors PlanGate's shape: fetch /api/me/onboarding on mount, redirect
// to /onboarding when the wizard isn't finished.
//
// Why before PlanGate: with M046 the user flow is signup → email-verify
// → onboarding → plan. If both gates fire on /dashboard, OnboardingGate
// must win (otherwise the user would be punted to /upgrade with an
// empty profile and nothing to anchor the AI on). Order is preserved by
// rendering this component above PlanGate in AppShell.tsx.
//
// Routes that stay open regardless of onboarding state:
//   /onboarding         — the wizard itself (the destination)
//   /settings, /account — owner can still manage account / change email
//   /upgrade            — needed when PlanGate later kicks in
//   /privacy, /terms, /security, /login, /reset-password — public/auth
//   anything under /api — never gated by client component

'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'

const OPEN_PATH_PREFIXES = [
  '/onboarding',
  '/settings',
  '/account',
  '/upgrade',
  '/privacy',
  '/terms',
  '/security',
  '/login',
  '/reset-password',
  '/api',
]

export default function OnboardingGate() {
  const pathname = usePathname()
  const router   = useRouter()

  useEffect(() => {
    if (!pathname) return
    if (OPEN_PATH_PREFIXES.some(p => pathname.startsWith(p))) return

    let cancelled = false
    async function check() {
      try {
        const r = await fetch('/api/me/onboarding')
        if (!r.ok) return                          // 401 → middleware handles auth
        const j = await r.json()
        if (cancelled) return
        if (!j.completed) {
          router.replace('/onboarding')
        }
      } catch {
        // Non-fatal — if the check fails, let them through. Worst case
        // they land on a blank-data dashboard and figure out to visit
        // /onboarding from the sidebar.
      }
    }
    check()
    return () => { cancelled = true }
  }, [pathname, router])

  return null
}
