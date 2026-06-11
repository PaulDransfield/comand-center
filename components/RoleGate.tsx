'use client'
// components/RoleGate.tsx
//
// Client-side page guard. Wraps a page's content and replaces it with a
// "you don't have access" message if the logged-in user's role doesn't
// permit the current path.
//
// Sources truth from /api/auth/me which returns the same subject shape
// the server uses. That way client + server agree on the rule and we
// never end up with the UI rendering content the API would 403 on.
//
// Two modes:
//   - <RoleGate /> wraps children and redirects to /no-access if path
//     isn't allowed
//   - <RoleGate require="owner" /> stricter override for explicitly
//     owner-only sections

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { canAccessPath, type AuthSubject } from '@/lib/auth/permissions'

interface MeResponse {
  userId:           string
  orgId:            string
  role:             string
  plan:             string
  business_ids:     string[] | null
  can_view_finances: boolean
}

export function RoleGate({
  children,
  require,                                   // 'owner' to force owner-only regardless of path rules
}: {
  children: React.ReactNode
  require?: 'owner'
}) {
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const [me, setMe] = useState<MeResponse | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (cancelled) return
        if (j?.userId) setMe(j as MeResponse)
        setLoaded(true)
      })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [])

  if (!loaded) return <>{children}</>            // brief flash; acceptable

  // Not authed → middleware should already have redirected. If we got here,
  // render children and let server-side gates 401 us out properly.
  if (!me) return <>{children}</>

  const subject: AuthSubject = {
    role:              me.role as any,
    business_ids:      me.business_ids,
    can_view_finances: me.can_view_finances,
  }

  // Explicit "owner only" override.
  if (require === 'owner' && me.role !== 'owner') {
    const home = roleHome(me.role)
    if (home && !pathname.startsWith(home)) { router.replace(home); return null }
    return <NoAccessFallback role={me.role} />
  }

  if (canAccessPath(subject, pathname)) return <>{children}</>

  // Landed on a page they can't access. Roles with a dedicated home (revisor,
  // staff) get auto-redirected there rather than shown a fallback whose
  // "back to dashboard" link would loop (they can't see the dashboard either).
  const home = roleHome(me.role)
  if (home && !pathname.startsWith(home)) {
    router.replace(home)
    return null
  }

  return <NoAccessFallback role={me.role} />
}

// The landing page for roles whose universe isn't the dashboard. Returns null
// for owner/manager (their home IS the dashboard).
function roleHome(role: string): string | null {
  if (role === 'revisor') return '/revisor'
  if (role === 'staff')   return '/inventory/recipes/prep'
  return null
}

function NoAccessFallback({ role }: { role: string }) {
  const t = useTranslations('misc.roleGate')
  // Don't link a scoped role back to a page they can't access.
  const home      = roleHome(role)
  const backHref  = home ?? '/dashboard'
  const backLabel = role === 'revisor' ? 'Back to your monthly view'
                  : role === 'staff'   ? 'Back to the prep list'
                  : t('backToDash')
  return (
    <div style={{
      minHeight: '60vh',
      display:   'flex',
      alignItems:'center',
      justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{
        background: 'white',
        border: '1px solid #e5e7eb',
        borderRadius: 12,
        padding: '28px 32px',
        maxWidth: 480,
        textAlign: 'center' as const,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase' as const, color: '#9ca3af', marginBottom: 8,
        }}>
          {t('eyebrow')}
        </div>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: '#111', margin: '0 0 10px 0' }}>
          {t('title')}
        </h1>
        <p style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.5, margin: '0 0 16px 0' }}>
          {t('body', { role })}
        </p>
        <a
          href={backHref}
          style={{
            display: 'inline-block',
            padding: '8px 16px',
            background: '#1a1f2e',
            color: 'white',
            textDecoration: 'none',
            borderRadius: 7,
            fontSize: 13, fontWeight: 500,
          }}
        >
          {backLabel}
        </a>
      </div>
    </div>
  )
}
