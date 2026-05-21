// components/ui/PageHero.tsx
// Per-page hero card: eyebrow + single-sentence headline + optional context
// + optional right slot (SupportingStats, big stat, or CTA).
// Spec: DESIGN.md § PageHero.

'use client'

import { UXP } from '@/lib/constants/tokens'
import type { ReactNode } from 'react'

export interface PageHeroProps {
  eyebrow:   string
  headline:  ReactNode    // single sentence; may contain <span> for coloured deltas
  context?:  ReactNode    // 1–2 sentences
  right?:    ReactNode    // SupportingStats / big number / CTA
}

export default function PageHero({ eyebrow, headline, context, right }: PageHeroProps) {
  return (
    <div
      style={{
        background:          UXP.cardBg,
        border:              `0.5px solid ${UXP.border}`,
        borderRadius:        UXP.r_lg,
        padding:             '18px 20px',
        marginBottom:        14,
        display:             'grid',
        gridTemplateColumns: right ? '1fr auto' : '1fr',
        gap:                 24,
        alignItems:          'center',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize:      10,
          color:         UXP.ink4,
          letterSpacing: '0.06em',
          marginBottom:  5,
          fontWeight:    500,
          textTransform: 'uppercase' as const,
        }}>
          {eyebrow}
        </div>
        <h1 style={{
          fontSize:    22,
          fontWeight:  500,
          margin:      '0 0 6px',
          lineHeight:  1.35,
          color:       UXP.ink1,
          letterSpacing: '-0.01em',
        }}>
          {headline}
        </h1>
        {context && (
          <div style={{
            fontSize:   12,
            color:      UXP.ink3,
            lineHeight: 1.5,
          }}>
            {context}
          </div>
        )}
      </div>
      {right && (
        <div style={{
          paddingLeft: 20,
          borderLeft:  `0.5px solid ${UXP.border}`,
        }}>
          {right}
        </div>
      )}
    </div>
  )
}
