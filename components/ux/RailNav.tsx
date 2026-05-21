'use client'
// components/ux/RailNav.tsx
//
// Phase 2 — icon-only left rail. One icon per AREA (Insights, Schedule, …);
// page-level nav happens via the top toolbar dropdown.
//
// The glyphs are now the animated RailIcon set (components/RailIcon/) —
// SVG + colocated CSS-module with idle/hover/click motion. Tabler glyphs
// were swapped out in commit ux/rail-icons. The wrapper button keeps its
// hover/active behavior because RailIcon's CSS animations fire from the
// nearest interactive ancestor.
//
// Active state: button gets aria-current="page"; UXP.lavFill background +
// UXP.lavDeep colour; the glyph picks up via currentColor.

import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { UXP } from '@/lib/constants/tokens'
import { AREAS, defaultPageFor, resolveActiveNav, type Area, type AreaIcon } from '@/lib/nav/areas'
import { RailIcon, type RailIconName } from '@/components/RailIcon/RailIcon'
import type { ReactNode } from 'react'

export interface RailNavProps {
  /** Mounted at the very bottom — typically <SyncIndicator collapsed/>. */
  footer?: ReactNode
}

// AreaIcon (Tabler-name in nav config) → RailIconName (animated set).
// Keeping the schema-side enum decoupled from the visual library lets
// us swap icon kits later without touching nav config.
const RAIL_ICON_FOR: Record<AreaIcon, RailIconName> = {
  'chart-pie':      'insights',
  'calendar-event': 'workforce',
  'box':            'inventory',
  'file-invoice':   'bookkeeping',
  'alert-triangle': 'alerts',
  'sparkles':       'ask',
  'settings':       'settings',
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

      {/* Theme toggle pinned at the top of the rail, ABOVE the area
          buttons. Wires data-theme + localStorage now so the dark-mode
          CSS layer (TBD) can just plug in. */}
      <ThemeToggleButton />

      <div style={{ height: 2 }} />

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

// Theme toggle — crescent moon glyph. Reads/writes `cc_theme` in
// localStorage and reflects via document.documentElement.dataset.theme.
// The dark-mode CSS layer isn't wired yet (that's a separate piece of
// work), but the toggle persists state cleanly so dropping that layer
// in later is purely additive.
function ThemeToggleButton() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light')

  useEffect(() => {
    try {
      const saved = localStorage.getItem('cc_theme')
      if (saved === 'dark' || saved === 'light') {
        setTheme(saved)
        document.documentElement.dataset.theme = saved
      }
    } catch { /* SSR / no-localStorage */ }
  }, [])

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    try {
      localStorage.setItem('cc_theme', next)
      document.documentElement.dataset.theme = next
    } catch { /* ignore */ }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      style={{
        width:          32,
        height:         30,
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        borderRadius:   UXP.r_md,
        background:     'transparent',
        color:          UXP.ink4,
        border:         'none',
        cursor:         'pointer',
        padding:        0,
        marginBottom:   2,
        fontFamily:     'inherit',
      }}
    >
      <RailIcon name="darkmode" />
    </button>
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
      <RailIcon name={RAIL_ICON_FOR[area.icon]} />
    </button>
  )
}
