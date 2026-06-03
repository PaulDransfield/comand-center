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
}

export function ProductThumb({ url, size = 'sm', alt = '', onClick, style }: ProductThumbProps) {
  if (!url) return null
  const px = SIZE_PX[size]
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
