// components/ui/CategoryPill.tsx
//
// Canonical filled pill for recipes.type. The single guarantee of cross-device
// uniformity for category badges. Inline styles only — no new deps.
//
// Pill spec (matches the approved mockup, identical on every breakpoint):
//   display:        inline-flex; align-items:center; white-space:nowrap
//   background:     ink + '1a'  (~10% tint)
//   color:          ink         (full strength)
//   font:           11px / weight 700 / letter-spacing 0.3 / UPPERCASE
//   padding:        2px 7px
//   border-radius:  6px
//
// Container at each render site uses flex-wrap so a long pill drops to the
// next line as a unit — never resizes, never wraps mid-word.

import React from 'react'
import { categoryToken, CATEGORY_LABELS } from '@/lib/categoryColors'

export interface CategoryPillProps {
  /** recipes.type value — NULL / empty / unknown are accepted */
  type:       string | null | undefined
  /** When true, render a neutral "Uncategorised" pill for NULL/empty type.
   *  When false (default), render NOTHING for NULL/empty. */
  showEmpty?: boolean
}

export function CategoryPill({ type, showEmpty = false }: CategoryPillProps) {
  const key = String(type ?? '').trim().toLowerCase()
  if (!key) {
    if (!showEmpty) return null
    const { ink, fill } = categoryToken(null)
    return <Pill ink={ink} fill={fill} label="Uncategorised" />
  }
  const { ink, fill } = categoryToken(key)
  const label = CATEGORY_LABELS[key] ?? (key[0].toUpperCase() + key.slice(1).replace('_', ' '))
  return <Pill ink={ink} fill={fill} label={label} />
}

function Pill({ ink, fill, label }: { ink: string; fill: string; label: string }) {
  return (
    <span
      style={{
        display:        'inline-flex',
        alignItems:     'center',
        whiteSpace:     'nowrap',
        background:     fill,
        color:          ink,
        fontSize:       11,
        fontWeight:     700,
        letterSpacing:  0.3,
        textTransform:  'uppercase',
        padding:        '2px 7px',
        borderRadius:   6,
        fontFamily:     'inherit',
      }}
    >
      {label}
    </span>
  )
}
