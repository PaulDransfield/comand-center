'use client'
// components/ui/Overlay.tsx
//
// CANONICAL overlay primitives for CommandCenter. Two components:
//
//   <Modal>  — centered popup over a dark scrim. Sizes sm/md/lg/xl.
//   <Drawer> — slide-in side panel anchored right. Sizes sm/md/lg.
//
// Adoption rule (Session 25, owner request 2026-06-02):
//
//   ALL new popups + side cards use these primitives. No more
//   hand-rolled `position: 'fixed', inset: 0, background: 'rgba(...)'`
//   blocks scattered across pages — that's the source of the size /
//   position / scrim-color inconsistency.
//
//   Existing surfaces migrate opportunistically; the recipes tab
//   migrated first (visible immediate win), other tabs as touched.
//
// Behaviour rules (consistent across both components):
//   - Backdrop click → onClose (unless { dismissOnBackdrop: false })
//   - Escape key    → onClose (always, prevents trapped users)
//   - × button      → onClose (top-right, always present)
//   - Body scroll locked while open
//   - Z-stack uses the existing Z.modal / Z.backdrop tokens
//
// Backdrop color, blur, padding, border-radius, shadow, animation all
// come from a SINGLE source here so they can't drift.

import { useEffect, type ReactNode, type CSSProperties } from 'react'
import { UXP, Z } from '@/lib/constants/tokens'

// ── Shared tokens (single source of truth) ──────────────────────────
const BACKDROP_COLOR   = 'rgba(20,18,40,0.45)'
const MODAL_RADIUS     = 12
const MODAL_PADDING    = 24
const MODAL_SHADOW     = '0 12px 32px rgba(58,53,80,0.20)'
const DRAWER_SHADOW    = '-8px 0 24px rgba(58,53,80,0.10)'
const TRANSITION_MS    = 180

const MODAL_WIDTHS: Record<ModalSize, number> = {
  sm: 380,
  md: 480,
  lg: 640,
  xl: 840,
}
const DRAWER_WIDTHS: Record<DrawerSize, number> = {
  sm: 380,
  md: 460,
  lg: 560,
}

export type ModalSize  = 'sm' | 'md' | 'lg' | 'xl'
export type DrawerSize = 'sm' | 'md' | 'lg'

// ── Shared hook — body scroll lock + Esc handler ────────────────────
function useOverlayBehavior(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])
}

// ── <Modal> ─────────────────────────────────────────────────────────
export interface ModalProps {
  open:                boolean
  onClose:             () => void
  title?:              ReactNode
  subtitle?:           ReactNode
  size?:               ModalSize        // default 'md'
  dismissOnBackdrop?:  boolean          // default true
  showCloseButton?:    boolean          // default true
  footer?:             ReactNode
  children:            ReactNode
  /** Optional override for the inner card style — escape hatch for
   *  unusual content (e.g. full-bleed media). Don't over-use. */
  bodyStyle?:          CSSProperties
  /** aria-label for screen readers when title is non-text (icons etc). */
  ariaLabel?:          string
}

export function Modal({
  open, onClose, title, subtitle,
  size = 'md', dismissOnBackdrop = true, showCloseButton = true,
  footer, children, bodyStyle, ariaLabel,
}: ModalProps) {
  useOverlayBehavior(open, onClose)
  if (!open) return null
  const width = MODAL_WIDTHS[size]
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onClick={dismissOnBackdrop ? onClose : undefined}
      style={{
        position: 'fixed', inset: 0,
        background: BACKDROP_COLOR,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: Z.modal, padding: 20,
        animation: `cc-overlay-in ${TRANSITION_MS}ms ease-out`,
      }}
    >
      <style>{`
        @keyframes cc-overlay-in {
          from { opacity: 0; transform: scale(0.98); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width:        `min(${width}px, 100%)`,
          maxHeight:    '90vh',
          overflow:     'auto',
          background:   UXP.cardBg,
          border:       `0.5px solid ${UXP.border}`,
          borderRadius: MODAL_RADIUS,
          padding:      MODAL_PADDING,
          boxShadow:    MODAL_SHADOW,
          fontFamily:   'inherit',
          color:        UXP.ink1,
          ...bodyStyle,
        }}
      >
        {(title || subtitle || showCloseButton) && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {title && (
                <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: UXP.ink1, lineHeight: 1.3 }}>
                  {title}
                </h2>
              )}
              {subtitle && (
                <div style={{ fontSize: 11, color: UXP.ink3, marginTop: 4 }}>
                  {subtitle}
                </div>
              )}
            </div>
            {showCloseButton && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: UXP.ink3, fontSize: 20, padding: 0, lineHeight: 1,
                  flexShrink: 0,
                }}
              >×</button>
            )}
          </div>
        )}

        <div>{children}</div>

        {footer && (
          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

// ── <Drawer> ────────────────────────────────────────────────────────
//
// Slide-in panel anchored to the right edge, full viewport height.
// Used for "detail" surfaces where the user wants the parent list
// visible alongside the detail content (recipes drawer, edit-item).
export interface DrawerProps {
  open:                boolean
  onClose:             () => void
  title?:              ReactNode
  subtitle?:           ReactNode
  size?:               DrawerSize       // default 'md'
  dismissOnBackdrop?:  boolean          // default true
  showCloseButton?:    boolean          // default true
  footer?:             ReactNode
  children:            ReactNode
  bodyStyle?:          CSSProperties
  ariaLabel?:          string
}

export function Drawer({
  open, onClose, title, subtitle,
  size = 'md', dismissOnBackdrop = true, showCloseButton = true,
  footer, children, bodyStyle, ariaLabel,
}: DrawerProps) {
  useOverlayBehavior(open, onClose)
  if (!open) return null
  const width = DRAWER_WIDTHS[size]
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onClick={dismissOnBackdrop ? onClose : undefined}
      style={{
        position: 'fixed', inset: 0,
        background: BACKDROP_COLOR,
        display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
        zIndex: Z.modal,
        animation: `cc-overlay-in ${TRANSITION_MS}ms ease-out`,
      }}
    >
      <style>{`
        @keyframes cc-overlay-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes cc-drawer-in {
          from { transform: translateX(100%); }
          to   { transform: translateX(0); }
        }
      `}</style>
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width:       `min(${width}px, 100%)`,
          height:      '100%',
          background:  UXP.cardBg,
          borderLeft:  `0.5px solid ${UXP.border}`,
          boxShadow:   DRAWER_SHADOW,
          display:     'flex',
          flexDirection: 'column',
          animation:   `cc-drawer-in ${TRANSITION_MS}ms ease-out`,
          fontFamily:  'inherit',
          color:       UXP.ink1,
        }}
      >
        {(title || subtitle || showCloseButton) && (
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
            padding: '18px 22px 12px', gap: 12,
            borderBottom: `0.5px solid ${UXP.border}`,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {title && (
                <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: UXP.ink1, lineHeight: 1.3 }}>
                  {title}
                </h2>
              )}
              {subtitle && (
                <div style={{ fontSize: 11, color: UXP.ink3, marginTop: 4 }}>
                  {subtitle}
                </div>
              )}
            </div>
            {showCloseButton && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: UXP.ink3, fontSize: 20, padding: 0, lineHeight: 1,
                  flexShrink: 0,
                }}
              >×</button>
            )}
          </div>
        )}

        <div style={{
          flex: 1, minHeight: 0, overflow: 'auto',
          padding: '14px 22px 22px',
          ...bodyStyle,
        }}>
          {children}
        </div>

        {footer && (
          <div style={{
            padding: '12px 22px 18px',
            borderTop: `0.5px solid ${UXP.border}`,
            display: 'flex', justifyContent: 'flex-end', gap: 8,
            background: UXP.subtleBg,
          }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Shared button styles (also used by recipe + prep modals) ────────
//
// Exported so call sites can use a CONSISTENT button look when they
// supply `footer={<Modal.Buttons.Primary>...</...>}` etc.
export const overlayBtn = {
  primary: {
    padding: '8px 16px', fontSize: 12, fontWeight: 600,
    background: UXP.lavDeep, color: '#fff',
    border: 'none', borderRadius: 6,
    cursor: 'pointer', fontFamily: 'inherit',
  } satisfies CSSProperties,
  secondary: {
    padding: '8px 14px', fontSize: 12, fontWeight: 500,
    background: 'transparent', color: UXP.ink2,
    border: `0.5px solid ${UXP.border}`, borderRadius: 6,
    cursor: 'pointer', fontFamily: 'inherit',
  } satisfies CSSProperties,
  danger: {
    padding: '8px 14px', fontSize: 12, fontWeight: 500,
    background: 'transparent', color: UXP.roseText,
    border: `0.5px solid ${UXP.rose}`, borderRadius: 6,
    cursor: 'pointer', fontFamily: 'inherit',
  } satisfies CSSProperties,
}
