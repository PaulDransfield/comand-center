// components/ui/SegmentedToggle.tsx
// Horizontal pill toggle. Used for W/M view switches and Compare-mode toggles.
// Spec: DESIGN.md § SegmentedToggle.

'use client'

import { UXP } from '@/lib/constants/tokens'

export interface SegmentedToggleOption {
  value: string
  label: string
}

export interface SegmentedToggleProps {
  options:  SegmentedToggleOption[]
  value:    string
  onChange: (v: string) => void
  ariaLabel?: string
}

export default function SegmentedToggle({
  options,
  value,
  onChange,
  ariaLabel,
}: SegmentedToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      style={{
        display:      'inline-flex',
        background:   UXP.cardBg,
        border:       `0.5px solid ${UXP.border}`,
        borderRadius: UXP.r_md,
        padding:      2,
        gap:          2,
      }}
    >
      {options.map(o => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            style={{
              padding:      '5px 12px',
              borderRadius: UXP.r_sm,
              border:       'none',
              cursor:       'pointer',
              fontSize:     12,
              fontWeight:   500,
              background:   active ? UXP.ink1       : 'transparent',
              color:        active ? UXP.cardBg     : UXP.ink3,
              boxShadow:    active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              letterSpacing: '0.01em',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
