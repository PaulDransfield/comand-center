'use client'
// components/CookieConsent.tsx
//
// ePrivacy Directive / Swedish Lag (2003:389) require explicit prior
// consent before non-essential cookies. PostHog is analytics, not
// strictly necessary — so it cannot fire until the user accepts.
//
// Simple banner pattern: renders a fixed bottom strip when no choice
// has been made, writes 'granted' / 'denied' to localStorage, and
// auto-dismisses after the click. Re-opens from a footer link so the
// user can change their mind later.
//
// Deliberately NOT using a third-party consent management tool — at
// our scale (<50 customers) the compliance bar is "ask, record the
// answer, respect it." Bigger platforms (OneTrust, Cookiebot) add
// audit trails and geo-detection; not worth the ~€100/month at this
// stage.

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { setAnalyticsConsent, hasAnalyticsConsent } from '@/lib/analytics/posthog'

const CONSENT_KEY = 'cc_analytics_consent'

export default function CookieConsent() {
  const t = useTranslations('misc.cookieConsent')
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // Render only if no choice has been recorded yet.
    try {
      const stored = localStorage.getItem(CONSENT_KEY)
      if (!stored) setVisible(true)
    } catch { /* private browsing etc — don't block */ }
  }, [])

  if (!visible) return null

  const accept = () => {
    setAnalyticsConsent(true)
    setVisible(false)
  }
  const decline = () => {
    setAnalyticsConsent(false)
    setVisible(false)
  }

  return (
    <div
      role="dialog"
      aria-label={t('ariaLabel')}
      style={{
        position:   'fixed',
        bottom:     0,
        left:       0,
        right:      0,
        background: 'white',
        borderTop:  '1px solid #e5e7eb',
        boxShadow:  '0 -2px 12px rgba(0, 0, 0, 0.06)',
        zIndex:     9999,
        padding:    '14px 20px',
      }}
    >
      <div
        style={{
          maxWidth:   1100,
          margin:     '0 auto',
          display:    'flex',
          alignItems: 'center',
          gap:        16,
          flexWrap:   'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 260, fontSize: 13, color: '#374151', lineHeight: 1.55 }}>
          <strong style={{ color: '#111' }}>{t('lead')}</strong> {t('body')}{' '}
          <a href="/privacy" style={{ color: '#6366f1', textDecoration: 'underline' }}>{t('privacyLink')}</a>.
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button
            onClick={decline}
            style={{
              padding:      '8px 14px',
              background:   'transparent',
              color:        '#374151',
              border:       '1px solid #e5e7eb',
              borderRadius: 8,
              fontSize:     13,
              fontWeight:   600,
              cursor:       'pointer',
            }}
          >
            {t('decline')}
          </button>
          <button
            onClick={accept}
            style={{
              padding:      '8px 14px',
              background:   '#1a1f2e',
              color:        'white',
              border:       'none',
              borderRadius: 8,
              fontSize:     13,
              fontWeight:   600,
              cursor:       'pointer',
            }}
          >
            {t('accept')}
          </button>
        </div>
      </div>
    </div>
  )
}
