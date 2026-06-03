'use client'
// components/ui/DataTable.tsx
//
// The high-leverage primitive: a table that switches to CARD-PER-ROW on
// mobile (and optionally tablet). Solves "wide table squashed into phone
// width" for every list surface — recipe editor ingredient table, P&L
// rows, items list, prep list session lines, anywhere with N rows × M
// columns.
//
// Usage:
//   <DataTable
//     columns={[
//       { id: 'name',   header: 'Name',   primary: true, cell: r => r.name },
//       { id: 'qty',    header: 'Qty',    cell: r => r.qty, align: 'right' },
//       { id: 'unit',   header: 'Unit',   cell: r => r.unit },
//       { id: 'cost',   header: 'Cost',   cell: r => fmtKr(r.cost), align: 'right' },
//     ]}
//     data={ingredients}
//     getKey={r => r.id}
//     onRowClick={ing => openModal(ing)}
//   />
//
// Behavior:
//   desktop  table layout (sticky header, real <table>)
//   tablet   default = table; pass cardsOn="tablet" to switch
//   mobile   card-per-row by default (each card: primary col = title,
//            other columns = label/value pairs underneath; columns
//            marked `hideOnMobile` collapse into an Expand row)

import { useState, type CSSProperties, type ReactNode } from 'react'
import { useViewport } from '@/lib/hooks/useViewport'
import { UXP } from '@/lib/constants/tokens'

export interface DataTableColumn<T> {
  id:       string
  header:   ReactNode
  /** When true this column is the card title on mobile. Exactly one
   *  column should be marked primary; if none is, the first column wins. */
  primary?: boolean
  /** Hide this column on mobile cards (collapses into Expand). */
  hideOnMobile?: boolean
  align?:   'left' | 'right' | 'center'
  width?:   number | string
  cell:     (row: T) => ReactNode
}

export interface DataTableProps<T> {
  columns:    Array<DataTableColumn<T>>
  data:       T[]
  getKey:     (row: T) => string | number
  /** Optional row click handler (whole row tap on mobile cards). */
  onRowClick?: (row: T) => void
  /** Below which tier should we render cards? Default 'mobile' only. */
  cardsOn?:    'mobile' | 'mobile-tablet'
  /** Optional empty-state node. */
  empty?:     ReactNode
  /** Outer style on the wrapper. */
  style?:     CSSProperties
}

export function DataTable<T>({
  columns, data, getKey, onRowClick, cardsOn = 'mobile', empty, style,
}: DataTableProps<T>) {
  const tier = useViewport()
  const useCards = cardsOn === 'mobile'
    ? tier === 'mobile'
    : tier !== 'desktop'

  if (data.length === 0 && empty) return <>{empty}</>

  if (useCards) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, ...style }}>
        {data.map(row => (
          <DataCard
            key={getKey(row)}
            row={row}
            columns={columns}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
          />
        ))}
      </div>
    )
  }

  // Desktop / tablet table layout
  return (
    <div style={{ overflowX: 'auto', ...style }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: UXP.subtleBg }}>
            {columns.map(c => (
              <th key={c.id} style={{
                padding: '8px 12px', fontSize: 10, fontWeight: 600,
                color: UXP.ink4, letterSpacing: '0.04em',
                textTransform: 'uppercase' as const,
                textAlign: c.align ?? 'left',
                width: c.width,
              }}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map(row => (
            <tr
              key={getKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              style={{
                borderTop: `0.5px solid ${UXP.borderSoft}`,
                cursor:    onRowClick ? 'pointer' : undefined,
              }}
              onMouseEnter={onRowClick ? e => (e.currentTarget.style.background = UXP.subtleBg) : undefined}
              onMouseLeave={onRowClick ? e => (e.currentTarget.style.background = 'transparent') : undefined}
            >
              {columns.map(c => (
                <td key={c.id} style={{
                  padding: '10px 12px',
                  fontSize: 12,
                  color: UXP.ink2,
                  textAlign: c.align ?? 'left',
                  fontVariantNumeric: c.align === 'right' ? 'tabular-nums' : undefined,
                }}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Card-per-row mobile rendering.
function DataCard<T>({ row, columns, onClick }: {
  row:      T
  columns:  Array<DataTableColumn<T>>
  onClick?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const primary = columns.find(c => c.primary) ?? columns[0]
  const secondary = columns.filter(c => c !== primary && !c.hideOnMobile)
  const hidden    = columns.filter(c => c !== primary && c.hideOnMobile)
  return (
    <div
      onClick={onClick}
      style={{
        padding: '10px 12px',
        background: UXP.cardBg,
        border: `0.5px solid ${UXP.border}`,
        borderRadius: 8,
        cursor: onClick ? 'pointer' : undefined,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ fontWeight: 600, color: UXP.ink1, fontSize: 13 }}>
        {primary.cell(row)}
      </div>
      {secondary.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', fontSize: 11 }}>
          {secondary.map(c => (
            <Frag key={c.id}>
              <div style={{ color: UXP.ink4 }}>{c.header}</div>
              <div style={{
                color: UXP.ink1, fontWeight: 500,
                textAlign: c.align === 'right' ? 'right' : 'left',
                fontVariantNumeric: c.align === 'right' ? 'tabular-nums' : undefined,
              }}>{c.cell(row)}</div>
            </Frag>
          ))}
        </div>
      )}
      {hidden.length > 0 && (
        <>
          <button
            type="button"
            onClick={e => { e.stopPropagation(); setExpanded(v => !v) }}
            style={{
              alignSelf: 'flex-start',
              padding: 0, marginTop: 2,
              background: 'transparent', border: 'none',
              color: UXP.lavText, fontSize: 10, fontWeight: 600,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {expanded ? '▾ Hide details' : '▸ Show details'}
          </button>
          {expanded && (
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', fontSize: 11, paddingTop: 4 }}>
              {hidden.map(c => (
                <Frag key={c.id}>
                  <div style={{ color: UXP.ink4 }}>{c.header}</div>
                  <div style={{ color: UXP.ink2 }}>{c.cell(row)}</div>
                </Frag>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Frag({ children }: { children: ReactNode }) { return <>{children}</> }
