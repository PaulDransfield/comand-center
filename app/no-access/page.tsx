'use client'
// app/no-access/page.tsx
//
// Standalone page for the "you don't have access" state. Used as a
// fallback target by RoleGate, middleware redirects, and any direct
// linking to a forbidden route. Same content as the inline fallback
// in <RoleGate> but accessible as its own URL.

export const dynamic = 'force-dynamic'

import AppShell from '@/components/AppShell'
import { useTranslations } from 'next-intl'

export default function NoAccessPage() {
  const t = useTranslations('access.noAccess')
  return (
    <AppShell>
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
          padding: '32px 36px',
          maxWidth: 520,
          textAlign: 'center' as const,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
            textTransform: 'uppercase' as const, color: '#9ca3af', marginBottom: 8,
          }}>
            {t('eyebrow')}
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: '#111', margin: '0 0 12px 0', letterSpacing: '-0.02em' }}>
            {t('title')}
          </h1>
          <p style={{ fontSize: 14, color: '#374151', lineHeight: 1.6, margin: '0 0 20px 0' }}>
            {t('body')}
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
            <a
              href="/dashboard"
              style={{
                display: 'inline-block',
                padding: '10px 18px',
                background: '#1a1f2e',
                color: 'white',
                textDecoration: 'none',
                borderRadius: 8,
                fontSize: 14, fontWeight: 500,
              }}
            >
              {t('backToDash')}
            </a>
            <a
              href="mailto:hello@comandcenter.se"
              style={{
                display: 'inline-block',
                padding: '10px 18px',
                background: 'transparent',
                color: '#6b7280',
                textDecoration: 'none',
                borderRadius: 8,
                fontSize: 14, fontWeight: 500,
                border: '1px solid #e5e7eb',
              }}
            >
              {t('emailSupport')}
            </a>
          </div>
        </div>
      </div>
    </AppShell>
  )
}
