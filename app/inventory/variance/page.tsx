'use client'
// app/inventory/variance/page.tsx
//
// THE PAYOFF PAGE. Shows theoretical product usage (POS sales × recipes)
// vs actual product usage (purchases − waste) over a date range. Per-
// product table sorted by absolute SEK variance — biggest signals up top.
//
// This is the BI surface that converts the inventory pipeline shipped in
// Session 20 from "data entry tool" to "shrinkage detector". Per
// POS-RECIPE-MAPPING-PLAN.md: the closing of the loop.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface Row {
  product_id:         string
  product_name:       string | null
  category:           string | null
  base_unit:          string | null
  theoretical_used:   number
  purchased:          number
  wasted:             number
  net_inflow:         number
  count_adjusted:     boolean
  actual_used:        number
  variance_qty:       number
  variance_pct:       number | null
  variance_value_sek: number | null
}
interface Summary {
  range_from:                  string
  range_to:                    string
  products_total:              number
  products_warning:            number
  total_theoretical_value_sek: number
  total_actual_value_sek:      number
  total_variance_value_sek:    number
  has_sales:                   boolean
}

const RANGE_OPTIONS = [
  { key: '7d',  label: 'Last 7 days',  days: 7  },
  { key: '14d', label: 'Last 14 days', days: 14 },
  { key: '30d', label: 'Last 30 days', days: 30 },
  { key: '90d', label: 'Last 90 days', days: 90 },
]

export default function VariancePage() {
  const [bizId,    setBizId]    = useState<string | null>(null)
  const [rangeKey, setRangeKey] = useState('30d')
  const [summary,  setSummary]  = useState<Summary | null>(null)
  const [rows,     setRows]     = useState<Row[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [filter,   setFilter]   = useState<'all' | 'warning' | 'shrinkage' | 'overpull'>('all')

  useEffect(() => {
    const s = localStorage.getItem('cc_selected_biz')
    if (s) setBizId(s)
  }, [])

  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true); setError(null)
    try {
      const opt  = RANGE_OPTIONS.find(o => o.key === rangeKey) ?? RANGE_OPTIONS[2]
      const to   = isoToday()
      const from = isoDaysAgo(opt.days)
      const r = await fetch(`/api/inventory/variance?business_id=${encodeURIComponent(bizId)}&from=${from}&to=${to}`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      const j = await r.json()
      setSummary(j.summary ?? null)
      setRows(j.rows ?? [])
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }, [bizId, rangeKey])
  useEffect(() => { if (bizId) load() }, [bizId, load])

  const visibleRows = rows.filter(r => {
    if (filter === 'all')        return true
    if (filter === 'warning')    return r.variance_pct != null && Math.abs(r.variance_pct) >= 0.10
    if (filter === 'shrinkage')  return r.variance_value_sek != null && r.variance_value_sek < -50      // actual < theoretical = stock dropped more than recipes account for
    if (filter === 'overpull')   return r.variance_value_sek != null && r.variance_value_sek >  50      // actual > theoretical = recipes overstate / over-bought
    return true
  })

  return (
    <AppShell>
      <div style={{ maxWidth: 1280, padding: '20px 24px' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: UXP.ink1 }}>Variance</h1>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3 }}>
              Theoretical product usage (from POS sales × recipes) vs actual (purchases − waste).
              Positive = bought more than recipes account for (waste / shrinkage). Negative = recipes overstate (or over-counted).
            </p>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {RANGE_OPTIONS.map(opt => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setRangeKey(opt.key)}
                style={{
                  padding: '5px 12px', fontSize: 11, fontWeight: 500,
                  background:   rangeKey === opt.key ? UXP.ink1   : 'transparent',
                  color:        rangeKey === opt.key ? '#fff'     : UXP.ink2,
                  border:       `0.5px solid ${rangeKey === opt.key ? UXP.ink1 : UXP.border}`,
                  borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
                }}
              >{opt.label}</button>
            ))}
          </div>
        </div>

        {/* KPIs */}
        {summary && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
            <Kpi
              label="Theoretical cost"
              value={summary.total_theoretical_value_sek > 0 ? fmtKr(summary.total_theoretical_value_sek) : '—'}
              sub={`from POS sales × recipes`}
            />
            <Kpi
              label="Actual cost"
              value={summary.total_actual_value_sek > 0 ? fmtKr(summary.total_actual_value_sek) : '—'}
              sub="purchases − waste"
            />
            <Kpi
              label="Variance"
              value={fmtKr(summary.total_variance_value_sek)}
              tone={summary.total_variance_value_sek > 100 ? 'warn' : (summary.total_variance_value_sek < -100 ? 'good' : 'neutral')}
              sub={summary.total_variance_value_sek > 0 ? 'over-bought / shrinkage' : 'under-pull / over-count'}
            />
            <Kpi
              label={`${summary.products_warning} / ${summary.products_total} products`}
              value={`${summary.products_warning}`}
              sub="with >10% variance"
            />
          </div>
        )}

        {/* Empty state */}
        {!loading && summary && !summary.has_sales && (
          <Empty>
            <strong>No POS sales recorded in this range.</strong><br />
            Enter weekly sales at <a href="/inventory/sales" style={link()}>/inventory/sales</a> to start the variance loop.
            You'll need a few weeks of data + recipes mapped to menu items before this report becomes meaningful.
          </Empty>
        )}

        {!loading && summary?.has_sales && rows.length === 0 && (
          <Empty>
            POS sales recorded, but no products are linked through recipes yet.
            Map menu items to recipes at <a href="/inventory/sales" style={link()}>/inventory/sales</a>.
          </Empty>
        )}

        {error && (
          <div style={{ padding: 12, background: UXP.roseFill, color: UXP.roseText, borderRadius: 6, marginBottom: 12, fontSize: 12 }}>
            {error}
          </div>
        )}

        {loading && !rows.length && <div style={{ fontSize: 12, color: UXP.ink3 }}>Loading…</div>}

        {/* Filter pills */}
        {rows.length > 0 && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <Pill active={filter === 'all'}        onClick={() => setFilter('all')}>All ({rows.length})</Pill>
            <Pill active={filter === 'warning'}    onClick={() => setFilter('warning')}>≥10% off</Pill>
            <Pill active={filter === 'shrinkage'}  onClick={() => setFilter('shrinkage')}>Possible shrinkage</Pill>
            <Pill active={filter === 'overpull'}   onClick={() => setFilter('overpull')}>Over-pulled</Pill>
          </div>
        )}

        {/* Table */}
        {visibleRows.length > 0 && (
          <div style={{
            border: `0.5px solid ${UXP.border}`, borderRadius: 8, overflow: 'hidden',
            background: UXP.cardBg,
          }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'inherit' }}>
                <thead>
                  <tr style={{ background: UXP.subtleBg, borderBottom: `0.5px solid ${UXP.border}` }}>
                    <th style={th(220, true)}>Product</th>
                    <th style={th(80)}>Unit</th>
                    <th style={th(100)}>Theoretical</th>
                    <th style={th(100)}>Purchased</th>
                    <th style={th(80)}>Wasted</th>
                    <th style={th(100)}>Actual</th>
                    <th style={th(100)}>Variance</th>
                    <th style={th(80)}>%</th>
                    <th style={th(120)}>Value (SEK)</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map(r => {
                    const tone =
                      r.variance_pct != null && Math.abs(r.variance_pct) >= 0.20 ? 'rose'
                      : r.variance_pct != null && Math.abs(r.variance_pct) >= 0.10 ? 'amber'
                      : 'neutral'
                    const valueTone =
                      r.variance_value_sek != null && r.variance_value_sek >  100 ? 'rose'
                      : r.variance_value_sek != null && r.variance_value_sek < -100 ? 'green'
                      : 'neutral'
                    return (
                      <tr key={r.product_id} style={{ borderBottom: `0.5px solid ${UXP.borderSoft}` }}>
                        <td style={td(true)}>
                          <a href={`/inventory/items/${r.product_id}`} style={link()}>{r.product_name ?? '—'}</a>
                          {r.category && <div style={{ fontSize: 9, color: UXP.ink4 }}>{r.category}</div>}
                        </td>
                        <td style={td()}>{r.base_unit ?? '—'}</td>
                        <td style={td()}>{fmtQty(r.theoretical_used)}</td>
                        <td style={td()}>{fmtQty(r.purchased)}</td>
                        <td style={td()}>{r.wasted > 0 ? fmtQty(r.wasted) : '—'}</td>
                        <td style={td()}>{fmtQty(r.actual_used)}</td>
                        <td style={{ ...td(), color: toneColour(tone) }}>{fmtQty(r.variance_qty, true)}</td>
                        <td style={{ ...td(), color: toneColour(tone) }}>{r.variance_pct != null ? `${(r.variance_pct * 100).toFixed(0)}%` : '—'}</td>
                        <td style={{ ...td(), color: toneColour(valueTone), fontWeight: 500 }}>
                          {r.variance_value_sek != null ? fmtKr(r.variance_value_sek) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p style={{ fontSize: 11, color: UXP.ink4, marginTop: 14, lineHeight: 1.6 }}>
          v1: variance compares purchases−waste to theoretical (recipes × sales) in the same window.
          Doesn't yet incorporate stock count deltas — those will tighten the signal once weekly counts become habitual.
          Per-product drill: click the name to see price history + invoices.
        </p>
      </div>
    </AppShell>
  )
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' | 'good' | 'neutral' }) {
  const colour = tone === 'warn' ? UXP.rose : (tone === 'good' ? UXP.green : UXP.ink1)
  return (
    <div style={{
      background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
      borderRadius: 8, padding: 12,
    }}>
      <div style={{ fontSize: 10, color: UXP.ink4, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 500, color: colour, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: UXP.ink3, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '4px 12px', fontSize: 11, fontWeight: 500,
        background:   active ? UXP.lavFill   : 'transparent',
        color:        active ? UXP.lavText   : UXP.ink2,
        border:       `0.5px solid ${active ? UXP.lav : UXP.border}`,
        borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
      }}
    >{children}</button>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: 32, textAlign: 'center', fontSize: 12, color: UXP.ink3,
      background: UXP.cardBg, border: `0.5px dashed ${UXP.border}`,
      borderRadius: 8, lineHeight: 1.7,
    }}>{children}</div>
  )
}

function th(width: number, left = false): React.CSSProperties {
  return {
    width, padding: '8px 10px',
    fontSize: 10, fontWeight: 600,
    color: UXP.ink3, textTransform: 'uppercase', letterSpacing: 0.4,
    textAlign: left ? 'left' as const : 'right' as const,
  }
}
function td(left = false): React.CSSProperties {
  return {
    padding: '8px 10px',
    fontSize: 12, color: UXP.ink1,
    textAlign: left ? 'left' as const : 'right' as const,
    fontVariantNumeric: 'tabular-nums' as const,
  }
}
function link(): React.CSSProperties {
  return { color: UXP.lavText, textDecoration: 'underline' }
}
function toneColour(tone: 'rose' | 'amber' | 'green' | 'neutral'): string {
  if (tone === 'rose')  return UXP.roseText
  if (tone === 'amber') return UXP.coral
  if (tone === 'green') return UXP.greenDeep
  return UXP.ink1
}

function fmtQty(n: number, signed = false): string {
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) < 0.01) return '0'
  const prefix = signed && n > 0 ? '+' : ''
  if (Math.abs(n) >= 1000) return `${prefix}${(n / 1000).toFixed(1)}k`
  if (Math.abs(n) >= 10)   return `${prefix}${n.toFixed(0)}`
  return `${prefix}${n.toFixed(2)}`
}
function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}
function isoDaysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}
