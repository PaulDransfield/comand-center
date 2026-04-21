// components/ui/StatusPill.tsx
// Small uppercase pill for row badges (OUTLIER, ON TRACK, OFF TRACK, AI, etc).
// Spec: DESIGN.md § StatusPill.

'use client'

import { UX } from '@/lib/constants/tokens'
import type { ReactNode } from 'react'

export type StatusTone = 'good' | 'warning' | 'bad' | 'neutral' | 'info'

export interface StatusPillProps {
  tone: StatusTone
  children: ReactNode
}

const TONE_STYLES: Record<StatusTone, { bg: string; color: string }> = {
  good:    { bg: UX.greenBg,     color: UX.greenInk  },
  warning: { bg: UX.amberBg,     color: UX.amberInk2 },
  bad:     { bg: UX.redBg,       color: UX.redInk2   },
  neutral: { bg: UX.borderSoft,  color: UX.ink3      },
  info:    { bg: UX.indigoBg,    color: '#4338ca'    },
}

export default function StatusPill({ tone, children }: StatusPillProps) {
  const s = TONE_STYLES[tone]
  return (
    <span
      style={{
        display:       'inline-block',
        background:    s.bg,
        color:         s.color,
        fontSize:      UX.fsMicro,
        fontWeight:    UX.fwMedium,
        letterSpacing: '0.04em',
        textTransform: 'uppercase' as const,
        padding:       '2px 6px',
        borderRadius:  UX.r_sm,
        whiteSpace:    'nowrap' as const,
      }}
    >
      {children}
    </span>
  )
}
