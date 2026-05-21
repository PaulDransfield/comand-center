// components/ui/StatusPill.tsx
// Small uppercase pill for row badges (OUTLIER, ON TRACK, OFF TRACK, AI, etc).
// Spec: DESIGN.md § StatusPill.

'use client'

import { UXP } from '@/lib/constants/tokens'
import type { ReactNode } from 'react'

export type StatusTone = 'good' | 'warning' | 'bad' | 'neutral' | 'info'

export interface StatusPillProps {
  tone: StatusTone
  children: ReactNode
}

const TONE_STYLES: Record<StatusTone, { bg: string; color: string }> = {
  good:    { bg: UXP.greenFill,     color: UXP.greenDeep  },
  warning: { bg: UXP.lavFill,     color: UXP.coral },
  bad:     { bg: UXP.roseFill,       color: UXP.roseText   },
  neutral: { bg: UXP.borderSoft,  color: UXP.ink3      },
  info:    { bg: UXP.lavFill,    color: '#4338ca'    },
}

export default function StatusPill({ tone, children }: StatusPillProps) {
  const s = TONE_STYLES[tone]
  return (
    <span
      style={{
        display:       'inline-block',
        background:    s.bg,
        color:         s.color,
        fontSize:      10,
        fontWeight:    500,
        letterSpacing: '0.04em',
        textTransform: 'uppercase' as const,
        padding:       '2px 6px',
        borderRadius:  UXP.r_sm,
        whiteSpace:    'nowrap' as const,
      }}
    >
      {children}
    </span>
  )
}
