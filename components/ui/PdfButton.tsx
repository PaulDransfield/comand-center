'use client'
// components/ui/PdfButton.tsx
//
// Canonical "view PDF" pill button. Lavender-fill rounded shape, used
// uniformly across the app — invoice rows on /overheads, /suppliers,
// /dashboard, the EditItemModal "View PDF" on supplier-article rows,
// and any future PDF surface.
//
// Pair with the shared <PdfModal /> for in-app rendering — never
// open new tabs for PDFs anywhere in the app.

import { UXP } from '@/lib/constants/tokens'
import type { ReactNode, CSSProperties } from 'react'

export interface PdfButtonProps {
  onClick:  () => void
  label?:   ReactNode             // defaults to 'PDF'
  title?:   string                // tooltip
  disabled?: boolean
  /** Subtle size variant. 'sm' is the default; 'xs' shrinks for dense rows. */
  size?:    'sm' | 'xs'
  /** Override style — last-resort escape hatch for callers that need it. */
  style?:   CSSProperties
}

export function PdfButton({ onClick, label = 'PDF', title, disabled, size = 'sm', style }: PdfButtonProps) {
  const dims = size === 'xs'
    ? { padding: '3px 8px',  fontSize: 9  as const }
    : { padding: '4px 10px', fontSize: 10 as const }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...dims,
        background:   UXP.lavFill,
        color:        UXP.lavText,
        border:       'none',
        borderRadius: 999,
        fontWeight:   500,
        cursor:       disabled ? 'not-allowed' : 'pointer',
        fontFamily:   'inherit',
        opacity:      disabled ? 0.5 : 1,
        ...style,
      }}
    >
      {label}
    </button>
  )
}
