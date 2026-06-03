'use client'
// components/ui/Popover.tsx
//
// Viewport-aware dropdown / menu primitive. Companion to the Modal +
// Drawer in Overlay.tsx — those handle CENTERED dialogs and SIDE
// drawers. Popover handles ANCHORED menus: business pickers, compare
// toggles, sort menus, language selectors, inline filter dropdowns.
//
// The bug it solves: hand-rolled dropdowns scattered across the app
// use `position: 'absolute', left: 0` or `right: 0` with a fixed
// minWidth (180-244). On phone-width viewports the dropdown
// frequently overflows whichever edge the trigger is anchored
// against, leaving the menu half off-screen.
//
// Behaviour:
//
//   Desktop / tablet (tier !== 'mobile'):
//     Anchored absolute relative to the trigger wrapper (the caller
//     puts <Popover> inside a `position: relative` container that
//     contains the trigger button). Default anchor is `align: 'left'`
//     — popover's LEFT edge aligns with trigger's LEFT edge,
//     extending rightward. Pass `align: 'right'` for the mirror.
//     Width: `min(menuWidth, viewport - 16)` so it can never spill
//     off-screen at the desktop bottom-edge case too.
//
//   Mobile (tier === 'mobile'):
//     Renders as a bottom-sheet over a dimmed backdrop. Slides up.
//     Full viewport width minus 12px gutter. Dismisses on
//     backdrop-tap, Esc, or × button (per Overlay.tsx contract).
//     Body scroll locked. Same accessibility model as <Modal>.
//
// Usage:
//
//   <div style={{ position: 'relative' }}>
//     <button onClick={() => setOpen(o => !o)}>Compare ▾</button>
//     <Popover
//       open={open}
//       onClose={() => setOpen(false)}
//       align="right"
//       menuWidth={200}
//       title="Compare"           // mobile bottom-sheet shows this
//     >
//       <button onClick={pick(...)}>No compare</button>
//       …
//     </Popover>
//   </div>
//
// Doesn't try to be a portal — most existing dropdowns are inline so
// stacking-context issues aren't a concern at this scale. If a future
// caller needs portal-mounted (e.g. dropdown inside an overflow-hidden
// container), add a `portal: true` prop then.

import { useEffect, type ReactNode, type CSSProperties } from 'react'
import { useViewport } from '@/lib/hooks/useViewport'
import { UXP, Z } from '@/lib/constants/tokens'

const BACKDROP_COLOR  = 'rgba(20,18,40,0.35)'
const SHEET_RADIUS    = 14
const ANCHOR_RADIUS   = 8
const ANCHOR_SHADOW   = '0 8px 24px rgba(58,53,80,0.12)'
const SHEET_SHADOW    = '0 -8px 24px rgba(58,53,80,0.18)'
const TRANSITION_MS   = 180

export interface PopoverProps {
  open:        boolean
  onClose:     () => void
  /** Which trigger edge to anchor the desktop popover to. Default 'left'. */
  align?:      'left' | 'right'
  /** Desktop minimum width (px). On mobile the popover is full-width. */
  menuWidth?:  number
  /** Optional bottom-sheet header on mobile (mobile only — desktop omits). */
  title?:      ReactNode
  /** Override the inner style for unusual content. */
  bodyStyle?:  CSSProperties
  /** aria-label when title isn't text. */
  ariaLabel?:  string
  children:    ReactNode
}

export function Popover({
  open, onClose, align = 'left', menuWidth = 200,
  title, bodyStyle, ariaLabel, children,
}: PopoverProps) {
  const tier = useViewport()
  const isMobile = tier === 'mobile'

  // Body scroll lock + Esc — mobile only (desktop dropdowns don't
  // lock scroll; that would be hostile to the rest of the page).
  useEffect(() => {
    if (!open || !isMobile) {
      // Still listen for Escape on desktop so the menu dismisses,
      // but don't lock scroll.
      if (!open) return
      function onKeyD(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
      window.addEventListener('keydown', onKeyD)
      return () => window.removeEventListener('keydown', onKeyD)
    }
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [open, isMobile, onClose])

  if (!open) return null

  // ── Mobile bottom-sheet ──────────────────────────────────────────
  if (isMobile) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? (typeof title === 'string' ? title : undefined)}
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          background: BACKDROP_COLOR,
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
          zIndex: Z.modal,
          animation: `cc-popover-fade ${TRANSITION_MS}ms ease-out`,
        }}
      >
        <style>{`
          @keyframes cc-popover-fade { from { opacity: 0 } to { opacity: 1 } }
          @keyframes cc-popover-rise { from { transform: translateY(100%) } to { transform: translateY(0) } }
        `}</style>
        <div
          onClick={e => e.stopPropagation()}
          style={{
            width: 'calc(100% - 12px)',
            maxHeight: '85vh',
            overflow: 'auto',
            background: UXP.cardBg,
            border: `0.5px solid ${UXP.border}`,
            borderRadius: `${SHEET_RADIUS}px ${SHEET_RADIUS}px 0 0`,
            padding: 12,
            boxShadow: SHEET_SHADOW,
            marginBottom: 0,
            animation: `cc-popover-rise ${TRANSITION_MS}ms ease-out`,
            ...bodyStyle,
          }}
        >
          {/* Grab handle */}
          <div style={{ width: 36, height: 3, background: UXP.border, borderRadius: 2, margin: '0 auto 10px' }} />
          {title && (
            <div style={{ fontSize: 12, fontWeight: 500, color: UXP.ink2, marginBottom: 8, padding: '0 2px' }}>
              {title}
            </div>
          )}
          <div>{children}</div>
        </div>
      </div>
    )
  }

  // ── Desktop / tablet anchored popover ────────────────────────────
  // Caller wraps trigger + Popover in `position: relative`. We anchor
  // to that relative parent. Width clamped to viewport-16px so even
  // a wide menu at the screen edge doesn't spill.
  return (
    <div
      onClick={e => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: 'calc(100% + 4px)',
        ...(align === 'right' ? { right: 0 } : { left: 0 }),
        width: `min(${menuWidth}px, calc(100vw - 16px))`,
        background: UXP.cardBg,
        border: `0.5px solid ${UXP.border}`,
        borderRadius: ANCHOR_RADIUS,
        padding: 4,
        boxShadow: ANCHOR_SHADOW,
        zIndex: Z.dropdown,
        ...bodyStyle,
      }}
    >
      {children}
    </div>
  )
}
