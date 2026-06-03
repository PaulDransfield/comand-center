'use client'
// components/ui/Layout.tsx
//
// CANONICAL responsive layout primitives. Build pages FROM these — never
// hand-roll fixed-width layout. Responsiveness is a PROPERTY of these
// components: any page composed from them is responsive automatically.
//
// Components in this file:
//   <PageContainer>      Page chrome (max-width + padding scaling).
//   <CardGrid>           Responsive multi-column grid. Phone 1 col,
//                        tablet 2 col, desktop N col. CSS-only.
//   <MetricCardRow>      KPI strip. Defaults to 4 cards on desktop, 2 on
//                        tablet, 1 on mobile.
//   <Stack>              Vertical spacing primitive (gap-based).
//   <Cluster>            Horizontal spacing primitive that wraps cleanly.
//
// See docs/LAYOUT.md for the convention. See lib/constants/breakpoints.ts
// for the 3-tier definitions (mobile <768 / tablet 768-1023 / desktop ≥1024).

import type { CSSProperties, ReactNode } from 'react'
import { MIN_PX, PAGE_PADDING, PAGE_MAX_WIDTH } from '@/lib/constants/breakpoints'
import { UXP } from '@/lib/constants/tokens'

// ── <PageContainer> ─────────────────────────────────────────────────
//
// Wraps every page. Padding shrinks on mobile, max-width caps content
// on desktop so it doesn't sprawl on ultra-wide monitors. Centered.
export interface PageContainerProps {
  children:   ReactNode
  /** Override the default 1280px max-width (use sparingly). */
  maxWidth?:  number
  /** Custom style (rarely needed). */
  style?:     CSSProperties
}

export function PageContainer({ children, maxWidth = PAGE_MAX_WIDTH, style }: PageContainerProps) {
  return (
    <div
      className="cc-page-container"
      style={{
        width:    '100%',
        maxWidth: maxWidth,
        margin:   '0 auto',
        padding:  `${PAGE_PADDING.mobile}px`,
        boxSizing: 'border-box',
        ...style,
      }}
    >
      {children}
      <style>{`
        @media (min-width: ${MIN_PX.tablet})  { .cc-page-container { padding: ${PAGE_PADDING.tablet}px; } }
        @media (min-width: ${MIN_PX.desktop}) { .cc-page-container { padding: ${PAGE_PADDING.desktop}px; } }
      `}</style>
    </div>
  )
}

// ── <CardGrid> ──────────────────────────────────────────────────────
//
// Responsive multi-column grid. Pure CSS — no JS, no layout thrash on
// resize. Default behavior: 1 col mobile, 2 col tablet, N col desktop
// where N is computed from the `columns` prop (default 4) or from the
// content if `auto` is set.
//
// Two modes:
//   columns={{ mobile, tablet, desktop }}  Explicit per-tier counts.
//   columns="auto"                         CSS auto-fit with min width.
//
// Examples:
//   <CardGrid columns={{ mobile: 1, tablet: 2, desktop: 4 }}>…</CardGrid>
//   <CardGrid columns="auto" minWidth={280}>…</CardGrid>
export type CardGridColumns =
  | 'auto'
  | { mobile?: number; tablet?: number; desktop?: number }

export interface CardGridProps {
  children:  ReactNode
  /** Per-tier column counts or 'auto' (uses minWidth). Default 1/2/4. */
  columns?:  CardGridColumns
  /** Used when columns='auto'. Each cell will be at least this wide. */
  minWidth?: number
  /** Gap between cells (default 14). */
  gap?:      number
  style?:    CSSProperties
}

let _gridUid = 0
function nextGridId() { return `cc-grid-${++_gridUid}` }

export function CardGrid({
  children,
  columns  = { mobile: 1, tablet: 2, desktop: 4 },
  minWidth = 220,
  gap      = 14,
  style,
}: CardGridProps) {
  if (columns === 'auto') {
    return (
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fit, minmax(${minWidth}px, 1fr))`,
        gap, ...style,
      }}>
        {children}
      </div>
    )
  }
  // Per-tier explicit columns. Inject a tiny scoped <style> tag so the
  // grid-template-columns can change at each breakpoint without inline
  // media query gymnastics.
  const id      = nextGridId()
  const mob     = columns.mobile  ?? 1
  const tab     = columns.tablet  ?? Math.min((columns.desktop ?? 4), 2)
  const desk    = columns.desktop ?? 4
  return (
    <>
      <div id={id} style={{
        display: 'grid', gap,
        gridTemplateColumns: `repeat(${mob}, minmax(0, 1fr))`,
        ...style,
      }}>{children}</div>
      <style>{`
        @media (min-width: ${MIN_PX.tablet})  { #${id} { grid-template-columns: repeat(${tab}, minmax(0, 1fr)); } }
        @media (min-width: ${MIN_PX.desktop}) { #${id} { grid-template-columns: repeat(${desk}, minmax(0, 1fr)); } }
      `}</style>
    </>
  )
}

// ── <MetricCardRow> ─────────────────────────────────────────────────
//
// KPI strip wrapper. Specialised <CardGrid> with sensible defaults for
// dashboard headers (1 col mobile, 2 col tablet, 4 col desktop). When
// you have 3 KPIs use `columns={{ mobile: 1, tablet: 3, desktop: 3 }}`.
export interface MetricCardRowProps {
  children: ReactNode
  columns?: { mobile?: number; tablet?: number; desktop?: number }
  gap?:     number
  style?:   CSSProperties
}

export function MetricCardRow({
  children,
  columns = { mobile: 1, tablet: 2, desktop: 4 },
  gap     = 12,
  style,
}: MetricCardRowProps) {
  return <CardGrid columns={columns} gap={gap} style={style}>{children}</CardGrid>
}

// ── <Stack> ─────────────────────────────────────────────────────────
//
// Vertical-spacing primitive. Use instead of `<div style={{ display:
// 'flex', flexDirection: 'column', gap: X }}>` everywhere.
export interface StackProps {
  children: ReactNode
  gap?:     number  // default 12
  style?:   CSSProperties
}

export function Stack({ children, gap = 12, style }: StackProps) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap,
      ...style,
    }}>
      {children}
    </div>
  )
}

// ── <Cluster> ───────────────────────────────────────────────────────
//
// Horizontal-spacing primitive that wraps cleanly. Use for toolbars,
// chip rows, button groups — anything that should flow horizontally
// when there's room and wrap to multiple lines when there isn't.
export interface ClusterProps {
  children: ReactNode
  gap?:     number  // default 8
  align?:   'start' | 'center' | 'end' | 'baseline'
  justify?: 'start' | 'center' | 'end' | 'space-between'
  style?:   CSSProperties
}

const ALIGN_MAP = { start: 'flex-start', center: 'center', end: 'flex-end', baseline: 'baseline' } as const
const JUSTIFY_MAP = { start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between' } as const

export function Cluster({ children, gap = 8, align = 'center', justify = 'start', style }: ClusterProps) {
  return (
    <div style={{
      display:        'flex',
      flexWrap:       'wrap',
      gap,
      alignItems:     ALIGN_MAP[align],
      justifyContent: JUSTIFY_MAP[justify],
      ...style,
    }}>
      {children}
    </div>
  )
}

// ── Re-export the tokens so consumers can read padding/border via UXP. ──
export { UXP }
