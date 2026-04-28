'use client'
// app/admin/v2/layout.tsx
//
// Shared layout for the new /admin/v2 surface. Mounts AdminNavV2 +
// CommandPalette and runs the client-side admin-auth check.
//
// Auth pattern matches the existing /admin/* pages: read 'admin_auth'
// from sessionStorage. If absent, bounce to /admin/login?next=<here>.
// Per the plan's hard rule, NEVER use localStorage for admin auth.

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { AdminNavV2 } from '@/components/admin/v2/AdminNavV2'
import { CommandPalette } from '@/components/admin/v2/CommandPalette'
import { readAdminSecret } from '@/lib/admin/v2/api-client'

export default function AdminV2Layout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  // Server-render an empty state, then check auth on the client. This
  // matches the existing /admin/* pattern — we can't read sessionStorage
  // during SSR.
  const [authChecked, setAuthChecked] = useState(false)
  const [authed, setAuthed] = useState(false)

  useEffect(() => {
    const secret = readAdminSecret()
    if (!secret) {
      const next = encodeURIComponent(pathname || '/admin/v2/overview')
      router.replace(`/admin/login?next=${next}`)
      return
    }
    setAuthed(true)
    setAuthChecked(true)
  }, [pathname, router])

  // Empty render until auth is confirmed — avoids a flash of nav before
  // the bounce-to-login happens.
  if (!authChecked || !authed) {
    return (
      <div style={{ minHeight: '100vh', background: '#f9fafb' }}>
        <div style={{ padding: 60, textAlign: 'center' as const, color: '#9ca3af', fontSize: 13 }}>
          Checking admin access…
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f9fafb' }}>
      <AdminNavV2 />
      <main style={{ maxWidth: 1280, margin: '0 auto', padding: '20px 24px 80px' }}>
        {children}
      </main>
      <CommandPalette />
    </div>
  )
}
