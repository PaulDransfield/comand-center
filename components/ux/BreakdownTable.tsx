'use client'
// components/ux/BreakdownTable.tsx
//
// CSS-grid table with optional section headers, footer row, numeric
// right-alignment, and delta chips. Phase 1 — presentational only.
//
// Verbatim spec values:
//   • rowPad          : 10px 16px
//   • header label    : fontSize 9, letterSpacing 0.04em, uppercase, color rgba(58,53,80,0.5)
//   • header border   : 0.5px solid rgba(58,53,80,0.08)
//   • body row border : 0.5px solid rgba(58,53,80,0.04)
//   • numerics        : fontSize 11, tabular-nums, right-aligned
//   • delta chips     :
//       green = bg #eef4f0, fg #477f60
//       rose  = bg #f7dee0, fg #b0454e
//       sizing: fontSize 9, borderRadius 6, padding '2px 6px'
//   • footer row      : bg #f7f6fb, color rgba(58,53,80,0.6)

import { UXP } from '@/lib/constants/tokens'
import type { ReactNode } from 'react'

export type ColumnAlign = 'left' | 'right' | 'center'

export interface BreakdownColumn<T = any> {
  key:      string
  header:   string
  align?:   ColumnAlign   // default: 'left' for first col, 'right' for the rest
  /** Width preset. 'auto' = 1fr. Pass a string like '120px' / 'minmax(120px, 1fr)' for explicit. */
  width?:   string
  /** Render a cell value. Receives the row + the column key. Return a string or React node. */
  render?:  (row: T, key: string) => ReactNode
}

export interface BreakdownSection<T = any> {
  /** Section label rendered above the rows. Omit for ungrouped. */
  label?:   string
  rows:     T[]
}

export interface BreakdownTableProps<T = any> {
  columns:   BreakdownColumn<T>[]
  sections:  BreakdownSection<T>[]
  footer?:   {
    label:  string
    cells:  Record<string, ReactNode>   // keyed by column key
  } | null
  /** Optional row key getter. Defaults to `row.id` / `row.key` / array index. */
  rowKey?:   (row: T, idx: number) => string
}

const rowPad        = '10px 16px'
const headerBorder  = `0.5px solid rgba(58,53,80,0.08)`
const bodyBorder    = `0.5px solid rgba(58,53,80,0.04)`
const footerBg      = '#f7f6fb'
const footerColor   = 'rgba(58,53,80,0.6)'

const microHeader = {
  fontSize:        9,
  letterSpacing:   '0.04em',
  textTransform:   'uppercase' as const,
  color:           'rgba(58,53,80,0.5)',
  padding:         rowPad,
  borderBottom:    headerBorder,
}

const tableCell = {
  fontSize:           11,
  fontVariantNumeric: 'tabular-nums' as const,
  padding:            rowPad,
  borderBottom:       bodyBorder,
  color:              UXP.ink2,
}

export default function BreakdownTable<T extends Record<string, any>>({
  columns, sections, footer, rowKey,
}: BreakdownTableProps<T>) {
  const gridTemplateColumns = columns
    .map(c => c.width ?? '1fr')
    .join(' ')

  return (
    <div style={{ background: '#fff', border: headerBorder, borderRadius: 12, overflow: 'hidden' }}>
      {/* Header row */}
      <div style={{ display: 'grid', gridTemplateColumns }}>
        {columns.map((c, ci) => {
          const align = c.align ?? (ci === 0 ? 'left' : 'right')
          return (
            <div key={c.key} style={{ ...microHeader, textAlign: align }}>
              {c.header}
            </div>
          )
        })}
      </div>

      {/* Sections */}
      {sections.map((section, si) => (
        <div key={`s-${si}`}>
          {section.label && (
            <div style={{
              padding:      '8px 16px',
              fontSize:     10,
              fontWeight:   500,
              color:        UXP.ink3,
              background:   UXP.subtleBg,
              borderBottom: bodyBorder,
              textTransform: 'uppercase' as const,
              letterSpacing: '0.04em',
            }}>
              {section.label}
            </div>
          )}
          {section.rows.map((row, ri) => (
            <div
              key={rowKey?.(row, ri) ?? row.id ?? row.key ?? `r-${si}-${ri}`}
              style={{ display: 'grid', gridTemplateColumns }}
            >
              {columns.map((c, ci) => {
                const align = c.align ?? (ci === 0 ? 'left' : 'right')
                const v = c.render ? c.render(row, c.key) : row[c.key]
                return (
                  <div
                    key={c.key}
                    style={{
                      ...tableCell,
                      textAlign: align,
                      color: ci === 0 ? UXP.ink1 : UXP.ink2,
                    }}
                  >
                    {v ?? <span style={{ color: UXP.ink4 }}>—</span>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      ))}

      {/* Footer */}
      {footer && (
        <div style={{ display: 'grid', gridTemplateColumns, background: footerBg }}>
          {columns.map((c, ci) => {
            const align = c.align ?? (ci === 0 ? 'left' : 'right')
            const v = ci === 0 ? footer.label : footer.cells[c.key]
            return (
              <div
                key={c.key}
                style={{
                  ...tableCell,
                  textAlign:    align,
                  color:        footerColor,
                  borderBottom: 'none',
                  fontWeight:   500,
                }}
              >
                {v ?? ''}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Delta chip ─────────────────────────────────────────────────────
// Reusable utility for the "+9.6%" / "-1 200 kr" cell renderer.
export function DeltaChip({
  value,
  positiveIsGood = true,
}: {
  value: string | number   // pre-formatted (e.g. "+9.6%") or raw number
  positiveIsGood?: boolean
}) {
  const str = typeof value === 'number'
    ? (value > 0 ? '+' : '') + value.toFixed(1) + '%'
    : value
  // Strip the sign for tone detection
  const num = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.\-+]/g, ''))
  const isPositive = num > 0
  const isNegative = num < 0
  const good = isPositive ? positiveIsGood : isNegative ? !positiveIsGood : null
  const palette = good == null
    ? { bg: UXP.lavFill, fg: UXP.ink3 }
    : good
      ? { bg: '#eef4f0', fg: '#477f60' }   // green
      : { bg: '#f7dee0', fg: '#b0454e' }   // rose

  return (
    <span style={{
      display:        'inline-block',
      fontSize:       9,
      borderRadius:   6,
      padding:        '2px 6px',
      background:     palette.bg,
      color:          palette.fg,
      fontVariantNumeric: 'tabular-nums' as const,
      letterSpacing:  '0.01em',
    }}>
      {str}
    </span>
  )
}
