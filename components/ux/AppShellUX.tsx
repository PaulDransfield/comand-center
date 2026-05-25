'use client'
// components/ux/AppShellUX.tsx
//
// Phase 2 — the redesigned page chrome. Mounted by `components/AppShell.tsx`
// so every authenticated page inherits the new toolbar + rail. The rail
// itself lives in `components/ux/RailNav.tsx`; this file is the toolbar
// and main-column layout.
//
// Layout:
//   ┌────────────────────────────────────────────────────────────────┐
//   │ [biz] · Insights ▾ · Overview ▾ · ◄ date ► · Compare ▾  Ask CC │
//   │────────────────────────────────────────────────────────────────│
//   │                                                                │
//   │  {children}                                                    │
//   │                                                                │
//   └────────────────────────────────────────────────────────────────┘
//
// Area + page dropdowns derive from `lib/nav/areas.ts` via
// `resolveActiveNav(pathname)`. Pages opt-in to richer toolbar behaviour
// by passing `dateLabel` / `onPrev` / `onNext` / `compareLabel` to the
// outer `<AppShell>` wrapper, which forwards them here.

import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { UXP } from '@/lib/constants/tokens'
// pageLabel collides with this component's own `pageLabel` prop; alias on import.
import { AREAS, areaLabel, pageLabel as pageLabelFor, resolveActiveNav, type Area, type AreaPage } from '@/lib/nav/areas'
import type { ReactNode } from 'react'

export interface AppShellUXProps {
  /** Optional override — derived from pathname when omitted. */
  section?:      string
  /** Optional override — derived from pathname when omitted. */
  pageLabel?:    string
  dateLabel?:    string
  onPrev?:       () => void
  onNext?:       () => void
  compareLabel?: string | null
  /** Left side of toolbar, before the area dropdown. Usually <BizPicker />. */
  bizPicker?:    ReactNode
  /** Right side of toolbar, after Ask CC. Usually <UserMenu />. */
  userMenu?:     ReactNode
  onAskCc?:      () => void
  children:      ReactNode
}

export default function AppShellUX({
  section,
  pageLabel,
  dateLabel,
  onPrev,
  onNext,
  compareLabel,
  bizPicker,
  userMenu,
  onAskCc,
  children,
}: AppShellUXProps) {
  const pathname = usePathname()
  const tSidebar = useTranslations('sidebar')
  const { area: activeArea, page: activePage } = resolveActiveNav(pathname)

  const sectionLabel = section ?? (activeArea ? areaLabel(activeArea, tSidebar) : 'CommandCenter')
  const pageDisplay  = pageLabel ?? (activeArea && activePage ? pageLabelFor(activeArea, activePage, tSidebar) : null)

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar */}
      <div
        style={{
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          gap:            8,
          padding:        '10px 16px',
          background:     UXP.cardBg,
          borderBottom:   `0.5px solid ${UXP.border}`,
          flexWrap:       'wrap' as const,
          minHeight:      48,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const }}>
          {bizPicker}
          <AreaDropdown activeArea={activeArea} fallbackLabel={sectionLabel} />
          {pageDisplay && (
            <PageDropdown activeArea={activeArea} activePage={activePage} fallbackLabel={pageDisplay} />
          )}
          {dateLabel && (
            <DateStepper label={dateLabel} onPrev={onPrev} onNext={onNext} />
          )}
          {compareLabel && <Pill>Compare: {compareLabel} ▾</Pill>}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AskCcPill onClick={onAskCc} />
          {userMenu}
        </div>
      </div>

      {/* Children */}
      <main style={{ flex: 1, padding: '16px', minWidth: 0 }}>
        {children}
      </main>
    </div>
  )
}

// ─── Toolbar atoms ─────────────────────────────────────────────────

function Pill({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding:      '5px 10px',
        background:   UXP.cardBg,
        color:        UXP.ink2,
        border:       `0.5px solid rgba(58,53,80,0.1)`,
        borderRadius: 7,
        fontSize:     11,
        fontFamily:   'inherit',
        cursor:       onClick ? 'pointer' : 'default',
      }}
    >
      {children}
    </button>
  )
}

interface AreaDropdownProps {
  activeArea:    Area | null
  fallbackLabel: string
}

function AreaDropdown({ activeArea, fallbackLabel }: AreaDropdownProps) {
  const router = useRouter()
  const t      = useTranslations('sidebar')
  const ref    = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as any)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // No area resolved (e.g. /settings/foo without an entry) → render a
  // plain label, no menu. Keeps the toolbar from looking broken on
  // pages we haven't classified yet.
  if (!activeArea) {
    return (
      <span style={{
        padding: '5px 10px', color: UXP.ink2, fontSize: 11, fontWeight: 500,
      }}>{fallbackLabel}</span>
    )
  }

  return (
    <div ref={ref} style={{ position: 'relative' as const }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          padding:      '5px 10px',
          background:   UXP.cardBg,
          color:        UXP.ink1,
          border:       `0.5px solid rgba(58,53,80,0.1)`,
          borderRadius: 7,
          fontSize:     11,
          fontWeight:   500,
          fontFamily:   'inherit',
          cursor:       'pointer',
          display:      'inline-flex',
          alignItems:   'center',
          gap:          4,
        }}
      >
        {areaLabel(activeArea, t)}
        <span aria-hidden style={{ color: UXP.ink3, fontSize: 10 }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position:     'absolute' as const,
            top:          'calc(100% + 4px)',
            left:         0,
            minWidth:     180,
            background:   UXP.cardBg,
            border:       `0.5px solid ${UXP.border}`,
            borderRadius: UXP.r_md,
            padding:      4,
            zIndex:       40,
            boxShadow:    '0 8px 24px rgba(58,53,80,0.12)',
          }}
        >
          {AREAS.filter(a => a.pages.length > 0).map(area => (
            <button
              key={area.key}
              type="button"
              onClick={() => {
                setOpen(false)
                const dest = area.pages[0]
                if (dest) router.push(dest.href)
              }}
              style={{
                display:      'block',
                width:        '100%',
                textAlign:    'left' as const,
                padding:      '7px 9px',
                background:   area.key === activeArea.key ? UXP.lavFill : 'transparent',
                color:        area.key === activeArea.key ? UXP.lavText : UXP.ink1,
                border:       'none',
                borderRadius: UXP.r_sm,
                cursor:       'pointer',
                fontSize:     11,
                fontFamily:   'inherit',
              }}
            >
              {areaLabel(area, t)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface PageDropdownProps {
  activeArea:    Area | null
  activePage:    AreaPage | null
  fallbackLabel: string
}

function PageDropdown({ activeArea, activePage, fallbackLabel }: PageDropdownProps) {
  const router = useRouter()
  const t      = useTranslations('sidebar')
  const ref    = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as any)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // No siblings → render a static label (no point in a 1-item dropdown).
  if (!activeArea || activeArea.pages.length <= 1) {
    return (
      <span style={{
        padding:    '5px 10px',
        background: UXP.lavFill,
        color:      UXP.lavText,
        borderRadius: 7,
        fontSize:   11,
        fontWeight: 500,
      }}>{fallbackLabel}</span>
    )
  }

  return (
    <div ref={ref} style={{ position: 'relative' as const }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          padding:      '5px 10px',
          background:   UXP.lavFill,
          color:        UXP.lavText,
          border:       `0.5px solid rgba(58,53,80,0.1)`,
          borderRadius: 7,
          fontSize:     11,
          fontWeight:   500,
          fontFamily:   'inherit',
          cursor:       'pointer',
          display:      'inline-flex',
          alignItems:   'center',
          gap:          4,
        }}
      >
        {fallbackLabel}
        <span aria-hidden style={{ color: UXP.lavText, fontSize: 10 }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position:     'absolute' as const,
            top:          'calc(100% + 4px)',
            left:         0,
            minWidth:     200,
            background:   UXP.cardBg,
            border:       `0.5px solid ${UXP.border}`,
            borderRadius: UXP.r_md,
            padding:      4,
            zIndex:       40,
            boxShadow:    '0 8px 24px rgba(58,53,80,0.12)',
          }}
        >
          {activeArea.pages.map(p => (
            <button
              key={p.key}
              type="button"
              onClick={() => { setOpen(false); router.push(p.href) }}
              style={{
                display:      'block',
                width:        '100%',
                textAlign:    'left' as const,
                padding:      '7px 9px',
                background:   p.key === activePage?.key ? UXP.lavFill : 'transparent',
                color:        p.key === activePage?.key ? UXP.lavText : UXP.ink1,
                border:       'none',
                borderRadius: UXP.r_sm,
                cursor:       'pointer',
                fontSize:     11,
                fontFamily:   'inherit',
              }}
            >
              {pageLabelFor(activeArea, p, t)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function DateStepper({ label, onPrev, onNext }: { label: string; onPrev?: () => void; onNext?: () => void }) {
  return (
    <div
      style={{
        display:      'inline-flex',
        alignItems:   'center',
        gap:          4,
        padding:      '4px 6px',
        background:   UXP.cardBg,
        border:       `0.5px solid rgba(58,53,80,0.1)`,
        borderRadius: 7,
      }}
    >
      <StepArrow direction="prev" onClick={onPrev} />
      <span style={{ fontSize: 11, color: UXP.ink2, padding: '0 4px', minWidth: 80, textAlign: 'center' as const }}>
        {label}
      </span>
      <StepArrow direction="next" onClick={onNext} />
    </div>
  )
}

function StepArrow({ direction, onClick }: { direction: 'prev' | 'next'; onClick?: () => void }) {
  return (
    <button
      type="button"
      aria-label={direction === 'prev' ? 'Previous' : 'Next'}
      onClick={onClick}
      style={{
        width:          18,
        height:         18,
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        border:         'none',
        background:     'transparent',
        cursor:         onClick ? 'pointer' : 'not-allowed',
        color:          UXP.ink3,
        fontSize:       12,
        padding:        0,
      }}
    >
      {direction === 'prev' ? '◄' : '►'}
    </button>
  )
}

function AskCcPill({ onClick }: { onClick?: () => void }) {
  // When no explicit onClick is provided by the page, dispatch the
  // global 'cc-open-askai' event. The nearest mounted AskAI handler
  // (either the page-level rich-context one or the AppShell fallback)
  // listens for this and opens the slide-in panel.
  const handleClick = () => {
    if (onClick) { onClick(); return }
    try { window.dispatchEvent(new CustomEvent('cc-open-askai')) } catch {}
  }
  return (
    <button
      type="button"
      onClick={handleClick}
      style={{
        display:        'inline-flex',
        alignItems:     'center',
        gap:            6,
        padding:        '6px 12px',
        background:     UXP.lav,
        color:          '#fff',
        border:         'none',
        borderRadius:   999,
        fontSize:       11,
        fontWeight:     500,
        fontFamily:     'inherit',
        cursor:         'pointer',
        letterSpacing:  '0.01em',
      }}
    >
      <span aria-hidden style={{ fontSize: 11 }}>✦</span>
      Ask CC
    </button>
  )
}

// Re-export for callers that previously imported the NavItem shape from
// this file (Phase 1 preview page).
export interface NavItem {
  key:   string
  label: string
  icon:  ReactNode
}
