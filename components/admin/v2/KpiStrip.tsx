'use client'
// components/admin/v2/KpiStrip.tsx
//
// Reusable stat-card grid. Used on the overview page in PR 2 and on
// customer detail in PR 4. Pre-formatted values — the strip is dumb.
// Tone applies a coloured bottom-border accent + value tint.

import type { KpiStat } from '@/lib/admin/v2/types'

const TONE: Record<NonNullable<KpiStat['tone']>, { value: string; accent: string }> = {
  neutral: { value: '#111827', accent: '#e5e7eb' },
  good:    { value: '#15803d', accent: '#bbf7d0' },
  warn:    { value: '#d97706', accent: '#fde68a' },
  bad:     { value: '#dc2626', accent: '#fecaca' },
}

export function KpiStrip({ items, columns = 4 }: { items: KpiStat[]; columns?: number }) {
  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: `repeat(auto-fit, minmax(${Math.floor(960 / columns)}px, 1fr))`,
      gap:                 10,
    }}>
      {items.map((it, i) => {
        const tone = TONE[it.tone ?? 'neutral']
        const card = (
          <div
            key={i}
            style={{
              background:    'white',
              border:        `1px solid ${tone.accent}`,
              borderRadius:  10,
              padding:       '14px 16px',
              cursor:        it.href ? 'pointer' : 'default',
              transition:    'box-shadow 0.15s',
            }}
            onMouseEnter={it.href ? e => (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.04)') : undefined}
            onMouseLeave={it.href ? e => (e.currentTarget.style.boxShadow = 'none') : undefined}
          >
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase' as const, color: '#9ca3af' }}>
              {it.label}
            </div>
            <div style={{ fontSize: 22, fontWeight: 500, color: tone.value, marginTop: 6, letterSpacing: '-0.01em' }}>
              {it.value}
            </div>
            {it.sub && (
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                {it.sub}
              </div>
            )}
          </div>
        )
        return it.href
          ? <a key={i} href={it.href} style={{ textDecoration: 'none', color: 'inherit' }}>{card}</a>
          : card
      })}
    </div>
  )
}
