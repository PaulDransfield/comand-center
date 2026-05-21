'use client'
// @ts-nocheck
// app/notebook/studio/page.tsx — AI Studio placeholder on UXP

import AppShell from '@/components/AppShell'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { UXP } from '@/lib/constants/tokens'

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
      <div style={{ padding: '24px 8px 40px', maxWidth: 640 }}>
        <div style={{ marginBottom: 16 }}>
          <Link
            href="/notebook"
            style={{ fontSize: 12, color: UXP.ink3, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            ← {t('backToAssistant')}
          </Link>
        </div>

        <div style={{
          background:    UXP.cardBg,
          border:        `0.5px solid ${UXP.border}`,
          borderRadius:  UXP.r_lg,
          padding:       40,
          textAlign:     'center',
        }}>
          <div style={{ fontSize: 36, marginBottom: 12, color: UXP.lavDeep }}>✦</div>
          <h1 style={{ fontSize: 20, fontWeight: 500, color: UXP.ink1, margin: '0 0 6px', letterSpacing: '-0.01em' }}>
            {t('title')}
          </h1>
          <p style={{ fontSize: 13, color: UXP.ink3, lineHeight: 1.55, marginBottom: 20, maxWidth: 440, marginLeft: 'auto', marginRight: 'auto' }}>
            {t('subtitle')}
          </p>
          <div style={{
            display:       'inline-flex',
            padding:       '5px 12px',
            background:    UXP.lavFill,
            color:         UXP.lavText,
            border:        `0.5px solid ${UXP.lavMid}`,
            borderRadius:  999,
            fontSize:      10,
            fontWeight:    600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}>
            {t('comingSoon')}
          </div>
        </div>

        <div style={{ marginTop: 16, display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr' }}>
          {features.map(item => (
            <div
              key={item.key}
              style={{
                background:    UXP.cardBg,
                border:        `0.5px solid ${UXP.border}`,
                borderRadius:  UXP.r_md,
                padding:       16,
              }}
            >
              <div style={{ fontSize: 20, marginBottom: 6 }}>{item.icon}</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: UXP.ink1, marginBottom: 3 }}>
                {t(`features.${item.key}.title`)}
              </div>
              <div style={{ fontSize: 11, color: UXP.ink3, lineHeight: 1.5 }}>
                {t(`features.${item.key}.desc`)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  )
}
