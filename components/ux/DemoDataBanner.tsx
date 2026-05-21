'use client'
// components/ux/DemoDataBanner.tsx
//
// Phase 6 — slim dismissible strip that sits at the top of every
// vision/demo page (Inventory, Schedule grid, etc.) so the operator
// always knows the numbers in front of them aren't live. Mock data
// itself lives in lib/mock/*; this banner is the visual contract that
// keeps fake data from leaking into a customer demo.
//
// Spec values from OVERHAUL-PROMPT-PACK §6 Task 1:
//   background: '#fbf2eb'
//   color:      '#8a4f24'
//   fontSize:   11
//   icon:       ti-flask (small inline SVG)
//   copy:       "Demo data — this feature is in development."

import { useState } from 'react'

export interface DemoDataBannerProps {
  /** Custom copy. Falls back to the prompt's canonical phrasing. */
  text?:        string
  dismissible?: boolean
}

const DEFAULT_TEXT = 'Demo data — this feature is in development.'

export default function DemoDataBanner({
  text        = DEFAULT_TEXT,
  dismissible = true,
}: DemoDataBannerProps) {
  const [hidden, setHidden] = useState(false)
  if (hidden) return null

  return (
    <div
      role="status"
      style={{
        display:        'flex',
        alignItems:     'center',
        gap:            8,
        padding:        '6px 12px',
        background:     '#fbf2eb',
        color:          '#8a4f24',
        borderRadius:   6,
        fontSize:       11,
        marginBottom:   12,
        border:         '0.5px solid rgba(138,79,36,0.18)',
      }}
    >
      <FlaskIcon />
      <span style={{ flex: 1 }}>{text}</span>
      {dismissible && (
        <button
          type="button"
          onClick={() => setHidden(true)}
          aria-label="Dismiss demo banner"
          style={{
            background: 'transparent',
            border:     'none',
            color:      '#8a4f24',
            cursor:     'pointer',
            fontSize:   14,
            lineHeight: 1,
            padding:    '0 4px',
            fontFamily: 'inherit',
          }}
        >
          ×
        </button>
      )}
    </div>
  )
}

function FlaskIcon() {
  return (
    <svg
      width="13" height="13" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="1.4"
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 3h6" />
      <path d="M10 3v6.5L4 18a2 2 0 0 0 1.7 3h12.6A2 2 0 0 0 20 18l-6 -8.5V3" />
      <path d="M6 14h12" />
    </svg>
  )
}
