'use client'
// app/admin/page.tsx
// PR 12 cut-over — /admin is now an alias for /admin/v2/overview.
// The full v2 surface (Overview, Customers, Agents, Health, Audit, Tools) ships
// from /admin/v2 with its own nav + auth flow. This shim exists so existing
// bookmarks and inbound links keep working.

export const dynamic = 'force-dynamic'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function AdminRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/admin/v2/overview')
  }, [router])

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f6f8', color: '#6b7280', fontSize: 13 }}>
      Redirecting to /admin/v2…
    </div>
  )
}
