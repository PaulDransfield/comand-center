// components/ui/SupportingStats.tsx
// Replaces the 4-KPI-card row on redesigned pages. Lives in the PageHero
// `right` slot. Spec: DESIGN.md § SupportingStats.

'use client'

import { UX } from '@/lib/constants/tokens'

export type StatTone = 'good' | 'bad' | 'neutral'

export interface SupportingStatsItem {
  label:      string
  value:      string
  delta?:     string
  deltaTone?: StatTone
  sub?:       string
}

export interface SupportingStatsProps {
  items: SupportingStatsItem[]
}

const DELTA_COLOUR: Record<StatTone, string> = {
  good:    UX.greenInk,
  bad:     UX.redInk,
  neutral: UX.ink3,
}

export default function SupportingStats({ items }: SupportingStatsProps) {
  // Spec: max 4 items. Render whatever is passed, capped.
  const list = items.slice(0, 4)

  return (
    <div
      style={{
        display:    'flex',
        flexDirection: 'row',
        gap:        18,
        alignItems: 'flex-start',
      }}
    >
      {list.map((it, i) => (
        <div key={`${it.label}-${i}`} style={{ minWidth: 0 }}>
          <div style={{
            fontSize:     UX.fsMicro,
            color:        UX.ink4,
            marginBottom: 2,
            letterSpacing: '0.04em',
            textTransform: 'uppercase' as const,
          }}>
            {it.label}
          </div>
          <div style={{
            fontSize:             14,
            fontWeight:           UX.fwMedium,
            color:                UX.ink1,
            fontVariantNumeric:   'tabular-nums' as const,
            lineHeight:           1.1,
            whiteSpace:           'nowrap' as const,
          }}>
            {it.value}
          </div>
          {(it.delta || it.sub) && (
            <div style={{
              display:       'flex',
              gap:           6,
              alignItems:    'baseline',
              marginTop:     2,
              fontSize:      UX.fsMicro,
              lineHeight:    1.3,
            }}>
              {it.delta && (
                <span style={{
                  color:      DELTA_COLOUR[it.deltaTone ?? 'neutral'],
                  fontWeight: UX.fwMedium,
                }}>
                  {it.delta}
                </span>
              )}
              {it.sub && (
                <span style={{ color: UX.ink3, whiteSpace: 'nowrap' as const }}>{it.sub}</span>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
