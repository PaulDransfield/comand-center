'use client'
// lib/hooks/useAuthSubject.ts
//
// Client hook returning the current user's auth subject (role + business
// scope + finance flag) from /api/auth/me — the same shape the server uses,
// so client-side nav filtering agrees with the server route guards.
//
// Module-level cache: the subject doesn't change within a session, so the
// rail, toolbar and RoleGate share one fetch instead of three.
//
//   undefined → still loading      null → not authenticated      object → subject

import { useEffect, useState } from 'react'
import type { AuthSubject } from '@/lib/auth/permissions'

let cached: AuthSubject | null | undefined = undefined
let inflight: Promise<AuthSubject | null> | null = null

export function useAuthSubject(): AuthSubject | null | undefined {
  const [subject, setSubject] = useState<AuthSubject | null | undefined>(cached)

  useEffect(() => {
    if (cached !== undefined) { setSubject(cached); return }
    let cancelled = false
    if (!inflight) {
      inflight = fetch('/api/auth/me', { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : null))
        .then(j => {
          const s: AuthSubject | null = j?.userId
            ? { role: j.role, business_ids: j.business_ids ?? null, can_view_finances: !!j.can_view_finances }
            : null
          cached = s
          return s
        })
        .catch(() => { cached = null; return null })
    }
    inflight.then(s => { if (!cancelled) setSubject(s) })
    return () => { cancelled = true }
  }, [])

  return subject
}
