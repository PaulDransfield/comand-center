// components/ui/TopBar.tsx
// Slim page-header strip: crumb trail left, freeform right slot (period picker,
// W/M toggle, "Sync now" indicator, AI CTA). No border — whitespace separates
// it from the hero below.
// Spec: DESIGN.md § TopBar.

'use client'

import { UX } from '@/lib/constants/tokens'
import type { ReactNode } from 'react'

export interface TopBarCrumb {
  label:    string
  active?:  boolean
  href?:    string
}

export interface TopBarProps {
  crumbs:    TopBarCrumb[]
  rightSlot?: ReactNode
}

export default function TopBar({ crumbs, rightSlot }: TopBarProps) {
  return (
    <div
      style={{
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        gap:            12,
        height:         40,
        marginBottom:   8,
        fontSize:       UX.fsBody,
      }}
    >
      <nav
        aria-label="Breadcrumb"
        style={{
          display:    'flex',
          alignItems: 'center',
          gap:        6,
          minWidth:   0,
          overflow:   'hidden' as const,
        }}
      >
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1
          // Active / last crumb = bold ink1.  Parent crumbs = regular ink3.
          const isActive = c.active || isLast
          const style  = {
            fontSize:   UX.fsBody,
            fontWeight: isActive ? UX.fwMedium : UX.fwRegular,
            color:      isActive ? UX.ink1     : UX.ink3,
            textDecoration: 'none' as const,
            whiteSpace: 'nowrap' as const,
          }
          return (
            <span key={`${c.label}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {c.href && !isActive
                ? <a href={c.href} style={style}>{c.label}</a>
                : <span style={style}>{c.label}</span>}
              {/* Separator — bumped to ink3 so the "·" actually reads as
                  a divider rather than a faded artefact. */}
              {!isLast && (
                <span aria-hidden style={{ color: UX.ink3, fontSize: UX.fsBody, userSelect: 'none' as const }}>·</span>
              )}
            </span>
          )
        })}
      </nav>

      {rightSlot && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {rightSlot}
        </div>
      )}
    </div>
  )
}
