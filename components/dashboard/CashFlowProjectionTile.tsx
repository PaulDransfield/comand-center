// components/dashboard/CashFlowProjectionTile.tsx
//
// Phase 2 cash visibility — 30-day forward projection. Shows:
//   - Headline: cash trough date + amount ("Low point: 14 Jun · -180k")
//   - A line chart of projected daily balance
//   - Major scheduled events with amounts (top 3 by absolute size)
//   - Total outflows / inflows summary
//
// Data: /api/finance/cash-flow-projection. Soft-fails to a "set up your
// Fortnox to see cash flow" hint when no data is available.

'use client'

import { useEffect, useState } from 'react'

interface ProjectionEvent {
  type:   'supplier_due' | 'customer_due' | 'salary'
  amount: number
  label:  string
}
interface ProjectionDay {
  date:    string
  balance: number
  events:  ProjectionEvent[]
}
interface CashFlowResponse {
  business_id:      string
  currency:         string
  horizon_days:     number
  starting_balance: number | null
  starting_balance_source: 'fortnox_accounts' | 'unavailable'
  summary: {
    cash_trough_date:   string
    cash_trough_amount: number
    ending_balance:     number | null
    total_outflows_30d: number
    total_inflows_30d:  number
    net_30d:            number
  }
  sources: {
    supplier_invoices: { count: number; total: number; error: string | null }
    customer_invoices: { count: number; total: number; error: string | null }
    salary_estimate:   { next_payday: string | null; monthly_amount: number; source: string }
  }
  projection: ProjectionDay[]
}

interface Props {
  businessId: string
}

function fmtKr(n: number | null | undefined, currency: string = 'SEK'): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const unit = currency.toLowerCase() === 'sek' ? 'kr' : currency
  return `${Math.round(n).toLocaleString('sv-SE')} ${unit}`
}

function fmtShortDate(iso: string): string {
  const d = new Date(iso + 'T12:00:00Z')
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export default function CashFlowProjectionTile({ businessId }: Props) {
  const [data,    setData]    = useState<CashFlowResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!businessId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/finance/cash-flow-projection?business_id=${businessId}&days=30`, { cache: 'no-store' })
      .then(async r => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}))
          throw new Error(body?.error ?? `HTTP ${r.status}`)
        }
        return r.json()
      })
      .then(j => { if (!cancelled) setData(j) })
      .catch(e => { if (!cancelled) setError(String(e?.message ?? e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [businessId])

  if (loading) {
    return (
      <div style={tileStyle}>
        <div style={labelStyle}>Cash flow · next 30 days</div>
        <div style={{ height: 28, marginTop: 8, background: '#f3f4f6', borderRadius: 4 }} />
      </div>
    )
  }

  if (error || !data || data.starting_balance == null) {
    return (
      <div style={{ ...tileStyle, opacity: 0.7 }}>
        <div style={labelStyle}>Cash flow · next 30 days</div>
        <div style={{ fontSize: 13, color: '#6b7280', marginTop: 8, lineHeight: 1.5 }}>
          Connect Fortnox and let the backfill complete to see a 30-day cash-flow projection here.
        </div>
        {error && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>({error})</div>}
      </div>
    )
  }

  const { summary, projection, sources, currency } = data
  const trough = projection.find(d => d.date === summary.cash_trough_date) ?? projection[0]
  const troughBelowZero = summary.cash_trough_amount < 0
  const allEvents = projection.flatMap(d => d.events.map(e => ({ ...e, date: d.date })))
  const sortedEvents = [...allEvents].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
  const topEvents = sortedEvents.slice(0, 3)

  // Build the chart
  function Chart({ days }: { days: ProjectionDay[] }) {
    if (days.length < 2) return null
    const W = 320, H = 80, PAD_X = 4, PAD_Y = 6
    let min = Math.min(...days.map(d => d.balance), 0)
    let max = Math.max(...days.map(d => d.balance), 0)
    if (min === max) { min -= 1; max += 1 }
    const stepX = (W - PAD_X * 2) / (days.length - 1)
    const yOf = (v: number) => H - PAD_Y - ((v - min) / (max - min)) * (H - PAD_Y * 2)
    const xOf = (i: number) => PAD_X + i * stepX
    const path = days.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xOf(i).toFixed(1)} ${yOf(d.balance).toFixed(1)}`).join(' ')
    const zeroY = yOf(0)
    return (
      <svg width={W} height={H} style={{ display: 'block', width: '100%', maxWidth: W }}>
        <line x1={PAD_X} y1={zeroY} x2={W - PAD_X} y2={zeroY} stroke="#d1d5db" strokeDasharray="3,3" strokeWidth="0.7" />
        <path d={path} fill="none" stroke="#1a3f6b" strokeWidth="1.5" />
        {/* Mark events as dots */}
        {days.map((d, i) => d.events.length > 0 ? (
          <circle key={d.date}
                  cx={xOf(i)} cy={yOf(d.balance)} r={2.5}
                  fill={d.events.some(e => e.amount < 0) ? '#b91c1c' : '#15803d'} />
        ) : null)}
        {/* Mark trough */}
        {(() => {
          const idx = days.findIndex(d => d.date === summary.cash_trough_date)
          if (idx < 0) return null
          return <circle cx={xOf(idx)} cy={yOf(summary.cash_trough_amount)} r={4} fill="#dc2626" stroke="#ffffff" strokeWidth="1.5" />
        })()}
      </svg>
    )
  }

  return (
    <div style={tileStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={labelStyle}>Cash flow · next 30 days</div>
        <div style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.05em' }}>
          starting {fmtKr(data.starting_balance, currency)}
        </div>
      </div>

      <div style={{ marginTop: 8, fontSize: 13, color: '#374151' }}>
        <span style={{ color: '#6b7280' }}>Cash low: </span>
        <strong style={{ color: troughBelowZero ? '#b91c1c' : '#1a1f2e', fontVariantNumeric: 'tabular-nums' }}>
          {fmtKr(summary.cash_trough_amount, currency)}
        </strong>
        <span style={{ color: '#6b7280' }}> on </span>
        <strong style={{ color: '#1a1f2e' }}>{fmtShortDate(summary.cash_trough_date)}</strong>
      </div>

      <div style={{ marginTop: 10 }}>
        <Chart days={projection} />
      </div>

      <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280', lineHeight: 1.5 }}>
        Out: <strong style={{ color: '#b91c1c' }}>{fmtKr(-summary.total_outflows_30d, currency)}</strong>
        {' · '}
        In: <strong style={{ color: '#15803d' }}>{fmtKr(summary.total_inflows_30d, currency)}</strong>
        {' · '}
        Net: <strong style={{ color: summary.net_30d >= 0 ? '#15803d' : '#b91c1c' }}>{summary.net_30d >= 0 ? '+' : ''}{fmtKr(summary.net_30d, currency)}</strong>
      </div>

      {topEvents.length > 0 && !expanded && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #f3f4f6' }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 6 }}>
            Largest scheduled movements
          </div>
          {topEvents.map((e, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0', fontSize: 12 }}>
              <span style={{ color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>
                {fmtShortDate(e.date)} · {e.label}
              </span>
              <span style={{ color: e.amount >= 0 ? '#15803d' : '#b91c1c', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                {e.amount >= 0 ? '+' : ''}{Math.round(e.amount).toLocaleString('sv-SE')}
              </span>
            </div>
          ))}
          <button onClick={() => setExpanded(true)}
                  style={{ background: 'transparent', border: 'none', color: '#1a3f6b', fontSize: 11, cursor: 'pointer', marginTop: 6, padding: 0 }}>
            Show all events →
          </button>
        </div>
      )}

      {expanded && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #f3f4f6', maxHeight: 240, overflowY: 'auto' }}>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 6 }}>
            All scheduled movements ({allEvents.length})
          </div>
          {[...allEvents].sort((a, b) => a.date.localeCompare(b.date)).map((e, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0', fontSize: 12 }}>
              <span style={{ color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>
                {fmtShortDate(e.date)} · {e.label}
              </span>
              <span style={{ color: e.amount >= 0 ? '#15803d' : '#b91c1c', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                {e.amount >= 0 ? '+' : ''}{Math.round(e.amount).toLocaleString('sv-SE')}
              </span>
            </div>
          ))}
          <button onClick={() => setExpanded(false)}
                  style={{ background: 'transparent', border: 'none', color: '#1a3f6b', fontSize: 11, cursor: 'pointer', marginTop: 6, padding: 0 }}>
            ← Show less
          </button>
        </div>
      )}

      <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 8, lineHeight: 1.4 }}>
        Starting from booked Fortnox bank balance. Outflows = unpaid supplier invoices ({sources.supplier_invoices.count}) + estimated salary on next 25th. Inflows = unpaid customer invoices ({sources.customer_invoices.count}). POS revenue not projected — assumes deposits already booked.
      </div>
    </div>
  )
}

const tileStyle: React.CSSProperties = {
  background:    '#ffffff',
  border:        '1px solid #e5e7eb',
  borderRadius:  12,
  padding:       '16px 18px',
  borderLeft:    '3px solid #1a3f6b',
}
const labelStyle: React.CSSProperties = {
  fontSize:       11,
  fontWeight:     700,
  textTransform:  'uppercase',
  letterSpacing:  '.07em',
  color:          '#6b7280',
}
