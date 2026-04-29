'use client'
// components/OrgNumberBanner.tsx
//
// Soft banner shown on the dashboard when the owner's organisation has no
// org_number. Links to /settings/company where they can fill it in.
// Within the 30-day grace, the banner is dismissable per session (a new
// session re-shows it). Past 30 days, the banner is non-dismissable and
// the message changes to a hard-block warning. The actual hard-block is
// enforced by middleware/route gates separately.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface CompanyInfoState {
  org_number:           string | null
  grace_days_remaining: number
  in_grace:             boolean
  grace_expired:        boolean
}

const DISMISS_KEY = 'cc_orgnr_banner_dismissed'

export function OrgNumberBanner() {
  const router = useRouter()
  const [state,     setState]     = useState<CompanyInfoState | null>(null)
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try { return sessionStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
  })

  useEffect(() => {
    let cancelled = false
    fetch('/api/settings/company-info', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (cancelled || !j?.organisation) return
        setState({
          org_number:           j.organisation.org_number,
          grace_days_remaining: j.organisation.grace_days_remaining,
          in_grace:             j.organisation.in_grace,
          grace_expired:        j.organisation.grace_expired,
        })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Already filled in → nothing to show.
  if (!state || state.org_number) return null
  // Dismissed for this session AND still in grace → nothing to show.
  if (dismissed && state.in_grace) return null

  const isExpired = state.grace_expired

  function dismiss() {
    setDismissed(true)
    try { sessionStorage.setItem(DISMISS_KEY, '1') } catch {}
  }

  return (
    <div style={{
      background:   isExpired ? '#fef2f2' : '#fffbeb',
      border:       `1px solid ${isExpired ? '#fecaca' : '#fde68a'}`,
      borderRadius: 10,
      padding:      '12px 16px',
      marginBottom: 14,
      display:      'flex',
      alignItems:   'center',
      justifyContent: 'space-between',
      gap:          14,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 600,
          color:    isExpired ? '#991b1b' : '#92400e',
          marginBottom: 2,
        }}>
          {isExpired
            ? 'Action required: add your organisationsnummer'
            : 'Add your company\'s organisationsnummer'}
        </div>
        <div style={{
          fontSize: 12,
          color:    isExpired ? '#7f1d1d' : '#78350f',
          lineHeight: 1.5,
        }}>
          {isExpired
            ? 'Required for VAT-compliant invoicing. Some features will be blocked until added.'
            : <>Required for VAT-compliant invoicing. {state.grace_days_remaining} day{state.grace_days_remaining === 1 ? '' : 's'} remaining before features are blocked.</>}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
        {!isExpired && (
          <button
            onClick={dismiss}
            style={{
              padding: '6px 10px', background: 'transparent', border: 'none',
              fontSize: 12, color: '#92400e', cursor: 'pointer',
            }}
          >
            Later
          </button>
        )}
        <button
          onClick={() => router.push('/settings/company')}
          style={{
            padding: '7px 14px',
            background: isExpired ? '#991b1b' : '#92400e',
            color: 'white', border: 'none', borderRadius: 7,
            fontSize: 12, fontWeight: 500, cursor: 'pointer',
          }}
        >
          Add now →
        </button>
      </div>
    </div>
  )
}
