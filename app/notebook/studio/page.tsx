'use client'
// @ts-nocheck
// app/notebook/studio/page.tsx — AI Studio (coming soon)

import AppShell from '@/components/AppShell'
import Link from 'next/link'
import { useTranslations } from 'next-intl'

export default function StudioPage() {
  const t = useTranslations('notebook.studio')
  const features = [
    { icon: '📊', key: 'reports' },
    { icon: '⏰', key: 'scheduled' },
    { icon: '🔔', key: 'alerts' },
    { icon: '📧', key: 'digests' },
  ] as const

  return (
    <AppShell>
      <div style={{ padding: '40px 28px', maxWidth: 640 }}>
        <div style={{ marginBottom: 24 }}>
          <Link href="/notebook" style={{ fontSize: 13, color: '#6b7280', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            ← {t('backToAssistant')}
          </Link>
        </div>

        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 16, padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>✦</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#111827', marginBottom: 8 }}>{t('title')}</h1>
          <p style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.6, marginBottom: 24 }}>
            {t('subtitle')}
          </p>
          <div style={{ display: 'inline-flex', padding: '6px 14px', background: '#f3f4f6', borderRadius: 20, fontSize: 12, color: '#6b7280', fontWeight: 600 }}>
            {t('comingSoon')}
          </div>
        </div>

        <div style={{ marginTop: 20, display: 'grid', gap: 12, gridTemplateColumns: '1fr 1fr' }}>
          {features.map(item => (
            <div key={item.key} style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 22, marginBottom: 8 }}>{item.icon}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 4 }}>{t(`features.${item.key}.title`)}</div>
              <div style={{ fontSize: 12, color: '#9ca3af' }}>{t(`features.${item.key}.desc`)}</div>
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  )
}
