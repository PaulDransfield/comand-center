'use client'
// components/OrgNumberGate.tsx
//
// Hard-block gate — wraps a page and replaces its content with a full-page
// "add your organisationsnummer" CTA when the owner's grace period has
// expired AND they still don't have one set. Until the gate is satisfied,
// the wrapped page is unreachable.
//
// Soft state (within grace) → renders children normally; the
// OrgNumberBanner component handles the dismissable nudge.
// Expired state → blocks rendering, full-screen CTA, only escape is
// /settings/company.
//
// Where to use: dashboard, financials, all the value-bearing pages. NOT
// /settings/company itself (that's where the escape lives) and not the
// admin tree (admin uses its own auth + isn't subject to org-nr rules).

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface CompanyInfo {
  org_number:           string | null
  grace_days_remaining: number
  in_grace:             boolean
  grace_expired:        boolean
}

export function OrgNumberGate({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [info,    setInfo]    = useState<CompanyInfo | null>(null)
  const [loaded,  setLoaded]  = useState<boolean>(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/settings/company-info', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (cancelled) return
        if (j?.organisation) {
          setInfo({
            org_number:           j.organisation.org_number,
            grace_days_remaining: j.organisation.grace_days_remaining,
            in_grace:             j.organisation.in_grace,
            grace_expired:        j.organisation.grace_expired,
          })
        }
        setLoaded(true)
      })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [])

  // Until we know, render children — avoids a flash of "blocked" while the
  // fetch is in flight. Worst case: a logged-in user with grace expired
  // sees the dashboard for ~200 ms then gets blocked. Acceptable.
  if (!loaded) return <>{children}</>

  // Set or still in grace → render normally.
  if (!info || info.org_number || info.in_grace) return <>{children}</>

  // Grace expired AND no org_number → full-page lockout.
  return (
    <div style={{
      position: 'fixed' as const, inset: 0, zIndex: 9000,
      background: 'rgba(255, 251, 235, 0.97)',
      backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{
        background: 'white',
        border: '1px solid #fde68a',
        borderRadius: 14,
        padding: '32px 36px',
        maxWidth: 560,
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.08)',
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase' as const, color: '#92400e', marginBottom: 8,
        }}>
          Action required
        </div>
        <h1 style={{
          fontSize: 22, fontWeight: 600, color: '#111', margin: '0 0 12px 0',
          letterSpacing: '-0.02em',
        }}>
          Add your organisationsnummer to continue
        </h1>
        <p style={{ fontSize: 14, color: '#374151', lineHeight: 1.6, margin: '0 0 20px 0' }}>
          Your 30-day grace period has ended. To keep using CommandCenter we need your
          company's <strong>10-digit Swedish organisationsnummer</strong> on file. This is required
          for VAT-compliant invoicing and to confirm the legal entity behind your account.
        </p>
        <p style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.6, margin: '0 0 24px 0' }}>
          It takes about ten seconds. Click below, paste your number, and you're back in.
        </p>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <a
            href="mailto:hello@comandcenter.se"
            style={{ fontSize: 12, color: '#6b7280', textDecoration: 'none' }}
          >
            Need help? hello@comandcenter.se
          </a>
          <button
            onClick={() => router.push('/settings/company')}
            style={{
              padding: '10px 20px',
              background: '#1a1f2e', color: 'white',
              border: 'none', borderRadius: 8,
              fontSize: 14, fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Add organisationsnummer →
          </button>
        </div>
      </div>
    </div>
  )
}
