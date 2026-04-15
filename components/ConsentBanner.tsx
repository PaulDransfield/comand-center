'use client'
// @ts-nocheck
// components/ConsentBanner.tsx
// Shows a consent banner if user hasn't accepted the privacy policy yet

import { useEffect, useState } from 'react'

export default function ConsentBanner() {
  const [show,    setShow]    = useState(false)
  const [saving,  setSaving]  = useState(false)

  useEffect(() => {
    // Check localStorage first for instant response
    if (localStorage.getItem('cc_privacy_accepted') === '1') return

    fetch('/api/gdpr/consent')
      .then(r => r.json())
      .then(data => {
        const hasConsent = (data.consents ?? []).some(
          (c: any) => c.consent_type === 'privacy_policy' && !c.withdrawn_at
        )
        if (hasConsent) {
          localStorage.setItem('cc_privacy_accepted', '1')
        } else {
          setShow(true)
        }
      })
      .catch(() => {})
  }, [])

  async function accept() {
    setSaving(true)
    // Save to localStorage immediately so banner never shows again
    localStorage.setItem('cc_privacy_accepted', '1')
    setShow(false)
    // Save to DB in background
    fetch('/api/gdpr/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent_type: 'privacy_policy', version: '1.0' }),
    }).catch(() => {})
    setSaving(false)
  }

  if (!show) return null

  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 999,
      background: '#1a1f2e', color: 'white',
      padding: '16px 24px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: 16, flexWrap: 'wrap',
      boxShadow: '0 -4px 20px rgba(0,0,0,0.3)',
    }}>
      <div style={{ fontSize: 13, flex: 1, minWidth: 200 }}>
        By using CommandCenter you agree to our{' '}
        <a href="/privacy" target="_blank" style={{ color: '#a5b4fc', textDecoration: 'underline' }}>
          Privacy Policy
        </a>
        . We process your restaurant and staff data to provide the service.
      </div>
      <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
        <a href="/privacy" target="_blank"
          style={{ padding: '8px 16px', background: 'transparent', color: '#9ca3af', border: '1px solid #374151', borderRadius: 8, fontSize: 13, textDecoration: 'none', cursor: 'pointer' }}>
          Read policy
        </a>
        <button onClick={accept} disabled={saving}
          style={{ padding: '8px 20px', background: '#6366f1', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          {saving ? 'Saving...' : 'I agree'}
        </button>
      </div>
    </div>
  )
}
