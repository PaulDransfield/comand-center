'use client'
// app/admin/audit/page.tsx
// PR 12 cut-over — replaced by /admin/v2/audit.
// Original implementation preserved in git history (pre-cut-over commit).

export const dynamic = 'force-dynamic'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function AdminAuditRedirect() {
  const router = useRouter()
  useEffect(() => { router.replace('/admin/v2/audit') }, [router])
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f6f8', color: '#6b7280', fontSize: 13 }}>
      Redirecting…
    </div>
  )
}
