'use client'
// components/ux/AppShellUX.tsx
//
// Phase 1 — the redesigned page chrome. NOT yet mounted by any page.
// Phase 2 will wire individual pages to it; this exists so subsequent
// phases consume a stable shell rather than re-deriving values per page.
//
// Layout:
//   ┌──────────────────────────────────────────────────────────────┐
//   │ rail │ top toolbar                                  Ask CC ▾ │
//   │ 46px │──────────────────────────────────────────────────────│
//   │      │                                                       │
//   │      │  {children}                                           │
//   │      │                                                       │
//   └──────┴──────────────────────────────────────────────────────┘
//
// Rail = icon-only (28×28 active chip on lavFill, lavDeep icon).
// Toolbar = pill controls (date stepper, section dropdown, Compare),
// Ask CC pill far-right (lavender bg, white text + sparkle).
//
// Inline styles, no new deps. Values match the Phase 1 prompt verbatim.

import { UXP } from '@/lib/constants/tokens'
import type { ReactNode } from 'react'

export interface NavItem {
  key:   string
  label: string   // tooltip only — rail is icon-only
  icon:  ReactNode
}

export interface AppShellUXProps {
  section:       string
  dateLabel:     string
  onPrev?:       () => void
  onNext?:       () => void
  compareLabel?: string | null
  navItems:      NavItem[]
  activeKey:     string
  onNavClick?:   (key: string) => void
  onAskCc?:      () => void
  children:      ReactNode
}

export default function AppShellUX({
  section, dateLabel, onPrev, onNext, compareLabel,
  navItems, activeKey, onNavClick, onAskCc,
  children,
}: AppShellUXProps) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: UXP.pageBg }}>
      {/* ── Rail ──────────────────────────────────────────── */}
      <aside
        aria-label="Primary"
        style={{
          width:        UXP.railW,
          flexShrink:   0,
          background:   UXP.cardBg,
          borderRight:  `0.5px solid rgba(58,53,80,0.06)`,
          display:      'flex',
          flexDirection: 'column',
          alignItems:   'center',
          paddingTop:   10,
          gap:          4,
          position:     'sticky' as const,
          top:          0,
          alignSelf:    'flex-start' as const,
          maxHeight:    '100vh',
          overflowY:    'auto' as const,
        }}
      >
        {navItems.map(item => {
          const active = item.key === activeKey
          return (
            <button
              key={item.key}
              type="button"
              title={item.label}
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              onClick={() => onNavClick?.(item.key)}
              style={{
                width:          28,
                height:         28,
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
              }}
            >
              {item.icon}
            </button>
          )
        })}
      </aside>

      {/* ── Main column ───────────────────────────────────── */}
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
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const }}>
            <Pill>Insights ▾</Pill>
            <Pill>{section} ▾</Pill>
            <DateStepper
              label={dateLabel}
              onPrev={onPrev}
              onNext={onNext}
            />
            {compareLabel && <Pill>Compare: {compareLabel} ▾</Pill>}
          </div>

          <AskCcPill onClick={onAskCc} />
        </div>

        {/* Children */}
        <main style={{ flex: 1, padding: '16px', minWidth: 0 }}>
          {children}
        </main>
      </div>
    </div>
  )
}

// ─── Atoms ──────────────────────────────────────────────────────────

function Pill({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding:      '5px 9px',
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
        width:        18,
        height:       18,
        display:      'flex',
        alignItems:   'center',
        justifyContent: 'center',
        border:       'none',
        background:   'transparent',
        cursor:       onClick ? 'pointer' : 'not-allowed',
        color:        UXP.ink3,
        fontSize:     12,
        padding:      0,
      }}
    >
      {direction === 'prev' ? '◄' : '►'}
    </button>
  )
}

function AskCcPill({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
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
