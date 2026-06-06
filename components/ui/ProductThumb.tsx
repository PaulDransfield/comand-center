// components/ui/ProductThumb.tsx
//
// CANONICAL product image thumbnail. Used everywhere a product is
// presented — recipe rows, prep list, order list, items list, edit
// modal, supplier-article picker. ONE source of truth for the styling
// so the look stays consistent.
//
// Size variants:
//   xs   20×20  inline mentions
//   sm   28×28  recipe ingredient rows (chef scans down a list)
//   md   40×40  items list rows / prep list rows
//   lg   64×64  modal cards / repointer lists
//   xl  108×108 hero image in EditItemModal
//
// Style invariants (so every surface looks the same):
//   - white background (products sit on coloured chrome elsewhere; the
//     supplier image needs neutral)
//   - 0.5 px hairline border
//   - rounded corners scale with size
//   - object-fit: contain (never crop)
//   - lazy loading (images are >100 KB; only load when scrolled into view)
//   - silent fallback when no url

import type { CSSProperties } from 'react'
import { UXP } from '@/lib/constants/tokens'

export type ProductThumbSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

const SIZE_PX: Record<ProductThumbSize, number> = {
  xs:  20,
  sm:  28,
  md:  40,
  lg:  64,
  xl: 108,
}
const RADIUS: Record<ProductThumbSize, number> = {
  xs: 3,
  sm: 4,
  md: 5,
  lg: 6,
  xl: 8,
}
const INNER_PADDING: Record<ProductThumbSize, number> = {
  xs: 1,
  sm: 2,
  md: 3,
  lg: 4,
  xl: 6,
}

export interface ProductThumbProps {
  url?:        string | null
  size?:       ProductThumbSize       // default 'sm'
  alt?:        string
  /** Optional click handler (e.g. open full-res image in a new tab). */
  onClick?:    () => void
  style?:      CSSProperties
  /**
   * What to render when `url` is missing.
   *   'none'    (default): return null — preserves the historical
   *                        "silent fallback" used by recipe drawers,
   *                        EditItemModal, item lists.
   *   'package': render a neutral 40 px slot with a muted package SVG
   *              so rows align cleanly even when the article has no
   *              scraped image yet. Use this everywhere an article
   *              appears in a column where alignment matters
   *              (orders, stock count, future article surfaces).
   */
  fallback?:   'none' | 'package'
}

export function ProductThumb({
  url, size = 'sm', alt = '', onClick, style, fallback = 'none',
}: ProductThumbProps) {
  const px = SIZE_PX[size]

  if (!url) {
    if (fallback !== 'package') return null
    return (
      <div
        aria-hidden="true"
        style={{
          width:          px,
          height:         px,
          background:     UXP.subtleBg,
          border:         `0.5px solid ${UXP.border}`,
          borderRadius:   RADIUS[size],
          flexShrink:     0,
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          color:          UXP.ink4,
          ...style,
        }}
      >
        {/* Lucide-style package outline. Inline so the canonical thumbnail
            slot owns its own visual without dragging in an icon dep. */}
        <svg
          width={Math.round(px * 0.5)} height={Math.round(px * 0.5)}
          viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
          <line x1="12" y1="22.08" x2="12" y2="12" />
        </svg>
      </div>
    )
  }
  return (
    <div
      onClick={onClick}
      style={{
        width:        px,
        height:       px,
        background:   '#fff',
        border:       `0.5px solid ${UXP.border}`,
        borderRadius: RADIUS[size],
        padding:      INNER_PADDING[size],
        boxSizing:    'border-box',
        flexShrink:   0,
        lineHeight:   0,
        cursor:       onClick ? 'pointer' : undefined,
        ...style,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- intentional: cross-customer cached URLs aren't next-image-optimisable */}
      <img
        src={url}
        alt={alt}
        loading="lazy"
        style={{
          width:     '100%',
          height:    '100%',
          objectFit: 'contain' as const,
          display:   'block',
        }}
      />
    </div>
  )
}
