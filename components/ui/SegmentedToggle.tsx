// components/ui/SegmentedToggle.tsx
// Horizontal pill toggle. Used for W/M view switches and Compare-mode toggles.
// Spec: DESIGN.md § SegmentedToggle.

'use client'

import { UX } from '@/lib/constants/tokens'

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
        background:   UX.cardBg,
        border:       `0.5px solid ${UX.border}`,
        borderRadius: UX.r_md,
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
              borderRadius: UX.r_sm,
              border:       'none',
              cursor:       'pointer',
              fontSize:     UX.fsBody,
              fontWeight:   UX.fwMedium,
              background:   active ? UX.navy       : 'transparent',
              color:        active ? UX.cardBg     : UX.ink3,
              boxShadow:    active ? UX.shadowPill : 'none',
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
