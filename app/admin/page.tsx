'use client'
// @ts-nocheck
// app/admin/page.tsx — thin redirect to the new admin surface.
// Legacy view has been rolled into /admin/overview + /admin/customers + /admin/agents + /admin/health.
// Historical flows are all preserved — see Session 9 ROADMAP entry.

export const dynamic = 'force-dynamic'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function AdminRedirect() {
  const router = useRouter()
  useEffect(() => {
    // If authed, skip login; otherwise /admin/overview will bounce to /admin/login itself
    router.replace('/admin/overview')
  }, [router])

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f6f8', color: '#6b7280', fontSize: 13 }}>
      Redirecting to the new admin dashboard…
    </div>
  )
}
