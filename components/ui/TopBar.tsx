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
          const style  = {
            fontSize:   UX.fsBody,
            fontWeight: (c.active || isLast) ? UX.fwMedium : UX.fwRegular,
            color:      (c.active || isLast) ? UX.ink1     : UX.ink3,
            textDecoration: 'none' as const,
            whiteSpace: 'nowrap' as const,
          }
          return (
            <span key={`${c.label}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {c.href && !c.active && !isLast
                ? <a href={c.href} style={style}>{c.label}</a>
                : <span style={style}>{c.label}</span>}
              {!isLast && (
                <span aria-hidden style={{ color: UX.ink5, fontSize: UX.fsBody }}>·</span>
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
