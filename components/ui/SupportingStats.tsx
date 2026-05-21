// components/ui/SupportingStats.tsx
// Replaces the 4-KPI-card row on redesigned pages. Lives in the PageHero
// `right` slot. Spec: DESIGN.md § SupportingStats.

'use client'

import { UXP } from '@/lib/constants/tokens'

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
  good:    UXP.greenDeep,
  bad:     UXP.roseText,
  neutral: UXP.ink3,
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
            fontSize:     10,
            color:        UXP.ink4,
            marginBottom: 2,
            letterSpacing: '0.04em',
            textTransform: 'uppercase' as const,
          }}>
            {it.label}
          </div>
          <div style={{
            fontSize:             14,
            fontWeight:           500,
            color:                UXP.ink1,
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
              fontSize:      10,
              lineHeight:    1.3,
            }}>
              {it.delta && (
                <span style={{
                  color:      DELTA_COLOUR[it.deltaTone ?? 'neutral'],
                  fontWeight: 500,
                }}>
                  {it.delta}
                </span>
              )}
              {it.sub && (
                <span style={{ color: UXP.ink3, whiteSpace: 'nowrap' as const }}>{it.sub}</span>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
