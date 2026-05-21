'use client'
// components/ux/RailNav.tsx
//
// Phase 2 — icon-only left rail per the overhaul prompt. Replaces the
// labelled SidebarV2. Each icon = ONE AREA (Insights, Schedule, …); page
// navigation happens via the top toolbar dropdown, not the rail.
//
// Active state derives from the current pathname via
// `resolveActiveNav()`; clicking an area icon routes to its first page.
//
// Width: 46px. Active chip: 32×30, lavFill bg, lavDeep icon. Inactive
// icon: 16px, ink4. Settings pinned to the bottom. Optional `footer`
// slot for SyncIndicator (collapsed/icon mode).

import { usePathname, useRouter } from 'next/navigation'
import { UXP } from '@/lib/constants/tokens'
import { AREAS, defaultPageFor, resolveActiveNav, type Area, type AreaIcon } from '@/lib/nav/areas'
import type { ReactNode } from 'react'

export interface RailNavProps {
  /** Mounted at the very bottom — typically <SyncIndicator collapsed/>. */
  footer?: ReactNode
}

export default function RailNav({ footer }: RailNavProps) {
  const pathname = usePathname()
  const router   = useRouter()
  const { area: activeArea } = resolveActiveNav(pathname)

  function handleClick(area: Area) {
    const dest = defaultPageFor(area)
    if (dest) router.push(dest.href)
  }

  const top    = AREAS.filter(a => a.pinned !== 'bottom')
  const bottom = AREAS.filter(a => a.pinned === 'bottom')

  return (
    <aside
      aria-label="Primary"
      style={{
        width:         UXP.railW,
        flexShrink:    0,
        background:    UXP.cardBg,
        borderRight:   '0.5px solid rgba(58,53,80,0.06)',
        display:       'flex',
        flexDirection: 'column',
        alignItems:    'center',
        paddingTop:    10,
        paddingBottom: 10,
        gap:           4,
        position:      'sticky' as const,
        top:           0,
        alignSelf:     'flex-start' as const,
        maxHeight:     '100vh',
        overflowY:     'auto' as const,
        zIndex:        20,
      }}
    >
      <Brand />

      <div style={{ height: 6 }} />

      {top.map(area => (
        <RailButton
          key={area.key}
          area={area}
          active={activeArea?.key === area.key}
          onClick={() => handleClick(area)}
        />
      ))}

      <div style={{ flex: 1 }} />

      {bottom.map(area => (
        <RailButton
          key={area.key}
          area={area}
          active={activeArea?.key === area.key}
          onClick={() => handleClick(area)}
        />
      ))}

      {footer && (
        <div style={{ marginTop: 6, width: '100%', display: 'flex', justifyContent: 'center' }}>
          {footer}
        </div>
      )}
    </aside>
  )
}

// ── Atoms ───────────────────────────────────────────────────────────

function Brand() {
  // Brand chip = 28×28 lavender square + monogram. Pure logo, not
  // clickable — the chip-as-button pattern conflicts with screen-reader
  // expectations on the home logo.
  return (
    <div
      aria-hidden
      style={{
        width:         28,
        height:        28,
        borderRadius:  UXP.r_md,
        background:    UXP.lav,
        color:         '#fff',
        display:       'flex',
        alignItems:    'center',
        justifyContent: 'center',
        fontSize:      11,
        fontWeight:    600,
        letterSpacing: '0.02em',
        fontFamily:    'var(--font-display, inherit)',
      }}
    >
      CC
    </div>
  )
}

interface RailButtonProps {
  area:    Area
  active:  boolean
  onClick: () => void
}

function RailButton({ area, active, onClick }: RailButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={area.label}
      aria-label={area.label}
      aria-current={active ? 'page' : undefined}
      style={{
        width:          32,
        height:         30,
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        borderRadius:   UXP.r_md,
        background:     active ? UXP.lavFill : 'transparent',
        color:          active ? UXP.lavDeep : UXP.ink4,
        border:         'none',
        cursor:         'pointer',
        padding:        0,
        marginBottom:   2,
        fontFamily:     'inherit',
      }}
    >
      <AreaIconSvg name={area.icon} />
    </button>
  )
}

// ── Icon set ────────────────────────────────────────────────────────
//
// Tabler-style 16px inline SVGs, stroke-width 1.4. Single source so the
// rail stays visually consistent and we don't drag in a 200KB icon lib.

function AreaIconSvg({ name }: { name: AreaIcon }) {
  const common = {
    width:          16,
    height:         16,
    viewBox:        '0 0 24 24',
    fill:           'none',
    stroke:         'currentColor',
    strokeWidth:    1.4,
    strokeLinecap:  'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden':  true as any,
  }

  switch (name) {
    case 'chart-pie':
      return (
        <svg {...common}>
          <path d="M12 3v9l8 .01" />
          <path d="M20 12a8 8 0 1 1 -8 -9" />
        </svg>
      )
    case 'calendar-event':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 9h18M8 3v4M16 3v4" />
          <rect x="8" y="13" width="4" height="4" rx="0.5" />
        </svg>
      )
    case 'box':
      return (
        <svg {...common}>
          <path d="M12 3l9 4.5v9L12 21 3 16.5v-9L12 3z" />
          <path d="M3 7.5l9 4.5 9 -4.5" />
          <path d="M12 12v9" />
        </svg>
      )
    case 'file-invoice':
      return (
        <svg {...common}>
          <path d="M14 3v4a1 1 0 0 0 1 1h4" />
          <path d="M17 21H7a2 2 0 0 1 -2 -2V5a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" />
          <path d="M9 12h6M9 16h6" />
        </svg>
      )
    case 'alert-triangle':
      return (
        <svg {...common}>
          <path d="M12 9v4" />
          <path d="M10.363 3.591 2.257 17a1.764 1.764 0 0 0 1.521 2.649h16.444a1.762 1.762 0 0 0 1.52 -2.649L13.636 3.591a1.914 1.914 0 0 0 -3.273 0z" />
          <path d="M12 16h.01" />
        </svg>
      )
    case 'sparkles':
      return (
        <svg {...common}>
          <path d="M16 18a2 2 0 0 1 2 2 2 2 0 0 1 2 -2 2 2 0 0 1 -2 -2 2 2 0 0 1 -2 2zM16 4a2 2 0 0 1 2 2 2 2 0 0 1 2 -2 2 2 0 0 1 -2 -2 2 2 0 0 1 -2 2zM9 12a4 4 0 0 1 4 4 4 4 0 0 1 4 -4 4 4 0 0 1 -4 -4 4 4 0 0 1 -4 4z" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...common}>
          <path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )
  }
}
