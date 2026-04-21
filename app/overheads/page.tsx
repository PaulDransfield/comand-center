'use client'
// @ts-nocheck
// app/overheads/page.tsx
//
// The overheads *presentation*.  Upload UI moved to /overheads/upload.
// This page consumes tracker_line_items via /api/overheads/line-items
// and renders:
//   - Hero with this-period overheads total + count
//   - Subcategory breakdown card (horizontal stacked bars, ranked)
//   - Full line-item table, filterable by month, sortable by amount
//   - AttentionPanel surfacing AI cost insights (filled later by the
//     cost-intel agent in the next phase)

export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'
import PageHero from '@/components/ui/PageHero'
import SupportingStats from '@/components/ui/SupportingStats'
import TopBar from '@/components/ui/TopBar'
import AttentionPanel, { AttentionItem } from '@/components/ui/AttentionPanel'
import SegmentedToggle from '@/components/ui/SegmentedToggle'
import { UX } from '@/lib/constants/tokens'
import { fmtKr, fmtPct } from '@/lib/format'

interface Business { id: string; name: string; city: string | null }
interface LineItem {
  id:              string
  period_year:     number
  period_month:    number
  category:        string
  subcategory:     string | null
  label_sv:        string
  label_en:        string | null
  amount:          number
  fortnox_account: number | null
  created_at:      string
}
interface Subcategory {
  key:           string
  subcategory:   string | null
  label:         string
  total_kr:      number
  months_seen:   number
}

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const MONTHS       = ['January','February','March','April','May','June','July','August','September','October','November','December']

// Tone per subcategory — rough semantic colouring so the stacked bar has meaning.
const SUB_TONE: Record<string, string> = {
  rent:           '#1a1f2e',   // navy (fixed overhead, biggest)
  utilities:      '#3730a3',
  software:       '#6366f1',
  telecom:        '#8b5cf6',
  accounting:     '#d97706',   // amber (professional fees)
  audit:          '#d97706',
  consulting:     '#d97706',
  bank_fees:      '#dc2626',   // red (costs worth hunting)
  insurance:      '#7c3aed',
  marketing:      '#059669',   // green (growth-investment)
  cleaning:       '#0891b2',
  repairs:        '#6b7280',
  consumables:    '#6b7280',
  office_supplies:'#6b7280',
  postage:        '#6b7280',
  shipping:       '#6b7280',
  entertainment:  '#a16207',
  vehicles:       '#6b7280',
  other:          '#9ca3af',
}

export default function OverheadsPage() {
  const router = useRouter()
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [bizId,      setBizId]      = useState<string | null>(null)
  const [rows,       setRows]       = useState<LineItem[]>([])
  const [subs,       setSubs]       = useState<Subcategory[]>([])
  const [loading,    setLoading]    = useState(true)
  const [year,       setYear]       = useState<number>(new Date().getFullYear())
  const [monthFilter, setMonthFilter] = useState<'all' | number>('all')
  const [insights,   setInsights]   = useState<AttentionItem[]>([])

  // Hydrate selected business from sidebar
  useEffect(() => {
    fetch('/api/businesses').then(r => r.json()).then((data: any[]) => {
      if (!Array.isArray(data) || !data.length) return
      setBusinesses(data)
      const saved = localStorage.getItem('cc_selected_biz')
      const id = (saved && data.find(b => b.id === saved)) ? saved : data[0].id
      setBizId(id)
    }).catch(() => {})
    const onStorage = () => {
      const s = localStorage.getItem('cc_selected_biz')
      if (s) setBizId(s)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Load overhead line items for the selected business / year
  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true)
    try {
      const r = await fetch(`/api/overheads/line-items?business_id=${bizId}&year_from=${year}&year_to=${year}&category=other_cost`, { cache: 'no-store' })
      const j = await r.json()
      setRows(Array.isArray(j.rows) ? j.rows : [])
      setSubs(Array.isArray(j.subcategories) ? j.subcategories : [])
    } catch {}
    // Cost insights — filled in the next phase by the cost-intel agent.
    try {
      const ci = await fetch(`/api/cost-insights?business_id=${bizId}`, { cache: 'no-store' })
      if (ci.ok) {
        const cj = await ci.json()
        setInsights(Array.isArray(cj.items) ? cj.items : [])
      }
    } catch {}
    setLoading(false)
  }, [bizId, year])

  useEffect(() => { if (bizId) load() }, [bizId, load])

  // ── Derived metrics ────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    return monthFilter === 'all' ? rows : rows.filter(r => r.period_month === monthFilter)
  }, [rows, monthFilter])

  const total      = filtered.reduce((s, r) => s + Number(r.amount ?? 0), 0)
  const subsInView = useMemo(() => {
    if (monthFilter === 'all') return subs
    // Re-compute subs for the selected month only
    const map: Record<string, { label: string; subcategory: string | null; total: number; months: Set<number> }> = {}
    for (const r of filtered) {
      const key = r.subcategory ?? r.label_sv ?? 'other'
      if (!map[key]) map[key] = { label: r.label_sv ?? key, subcategory: r.subcategory, total: 0, months: new Set() }
      map[key].total += Number(r.amount ?? 0)
      map[key].months.add(r.period_month)
    }
    return Object.entries(map)
      .map(([key, v]) => ({ key, subcategory: v.subcategory, label: v.label, total_kr: Math.round(v.total), months_seen: v.months.size }))
      .sort((a, b) => b.total_kr - a.total_kr)
  }, [filtered, subs, monthFilter])

  const monthsCovered = useMemo(() => {
    const s = new Set<number>()
    for (const r of rows) s.add(r.period_month)
    return s
  }, [rows])

  const selectedBiz = businesses.find(b => b.id === bizId) ?? null

  const hero = (() => {
    if (loading) return <>Loading overheads…</>
    if (!rows.length) {
      return <>
        No Fortnox overhead data for <span style={{ fontWeight: UX.fwMedium }}>{year}</span> yet.{' '}
        <a href="/overheads/upload" style={{ color: UX.indigo }}>Upload your Fortnox P&amp;L PDFs →</a>
      </>
    }
    const topSub = subsInView[0]
    const topShare = total > 0 && topSub ? Math.round((topSub.total_kr / total) * 100) : 0
    return (
      <>
        <span style={{ fontWeight: UX.fwMedium }}>{fmtKr(total)}</span> in overheads
        {monthFilter === 'all' ? ` across ${monthsCovered.size} month${monthsCovered.size === 1 ? '' : 's'}` : ` in ${MONTHS[Number(monthFilter) - 1]} ${year}`}
        {topSub && <>
          {' '}— largest category <span style={{ color: UX.redInk, fontWeight: UX.fwMedium }}>{topSub.label} ({topShare}%)</span>
        </>}.
      </>
    )
  })()

  return (
    <AppShell>
      <div style={{ maxWidth: 1100 }}>

        <TopBar
          crumbs={[{ label: 'Financials' }, { label: 'Overheads', active: true }]}
          rightSlot={
            <>
              <select value={year} onChange={e => setYear(Number(e.target.value))}
                style={{ padding: '5px 9px', border: `0.5px solid ${UX.border}`, borderRadius: UX.r_md, fontSize: UX.fsBody, background: UX.cardBg, color: UX.ink1 }}>
                {[2023, 2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
              </select>
              <button
                onClick={() => router.push('/overheads/upload')}
                style={{
                  padding: '5px 11px', background: UX.indigo, color: 'white',
                  border: 'none', borderRadius: UX.r_md, fontSize: UX.fsBody,
                  fontWeight: UX.fwMedium, cursor: 'pointer',
                }}
              >
                + Upload Fortnox PDFs
              </button>
            </>
          }
        />

        <PageHero
          eyebrow={`OVERHEADS — ${year}${selectedBiz ? ` · ${selectedBiz.name.toUpperCase()}` : ''}`}
          headline={hero}
          context={rows.length > 0
            ? `${rows.length} line item${rows.length === 1 ? '' : 's'} · ${monthsCovered.size} month${monthsCovered.size === 1 ? '' : 's'} of detail · business-wide, not split by department`
            : undefined
          }
          right={rows.length > 0 ? (
            <SupportingStats items={[
              {
                label: 'Overheads',
                value: fmtKr(total),
                sub: monthFilter === 'all' ? `${monthsCovered.size} months` : MONTHS_SHORT[Number(monthFilter) - 1],
              },
              {
                label: 'Categories',
                value: String(subsInView.length),
                sub: subsInView.length > 0 ? 'drilled out' : undefined,
              },
              {
                label: 'Line items',
                value: String(filtered.length),
                sub: filtered.length > 0 ? 'all Fortnox' : undefined,
              },
            ]} />
          ) : undefined}
        />

        {/* Month filter */}
        {rows.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const, marginBottom: 12 }}>
            <button onClick={() => setMonthFilter('all')} style={monthBtn(monthFilter === 'all')}>All months</button>
            {Array.from(monthsCovered).sort((a,b) => a - b).map(m => (
              <button key={m} onClick={() => setMonthFilter(m)} style={monthBtn(monthFilter === m)}>
                {MONTHS_SHORT[m - 1]}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center' as const, color: UX.ink4, fontSize: UX.fsBody }}>Loading…</div>
        ) : rows.length === 0 ? (
          <AttentionPanel
            title="No overhead data yet"
            items={[
              { tone: 'warning', entity: 'Upload',  message: 'drop your monthly Fortnox P&L PDFs — the AI extracts every line item including rent, software subs, bank fees.' },
              { tone: 'warning', entity: 'Why',     message: 'övriga externa kostnader is where margin quietly disappears. We surface duplicates, creep, and renegotiation candidates.' },
            ]}
          />
        ) : (
          <>
            {/* Subcategory breakdown */}
            <SubcategoryBreakdown subs={subsInView} total={total} />

            {/* AI insights — filled by cost-intel agent (Phase 7) */}
            {insights.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <AttentionPanel
                  title="AI cost insights"
                  items={insights}
                />
              </div>
            )}

            {/* Full line-item table */}
            <div style={{ marginTop: 12 }}>
              <LineItemsTable rows={filtered} showMonth={monthFilter === 'all'} />
            </div>
          </>
        )}
      </div>

      <AskAI
        page="overheads"
        context={
          rows.length > 0
            ? `Year: ${year}. Overheads total: ${fmtKr(total)} across ${rows.length} line items.\nTop subcategories: ${subsInView.slice(0, 5).map(s => `${s.label} ${fmtKr(s.total_kr)}`).join(', ')}`
            : 'No overhead data yet.'
        }
      />
    </AppShell>
  )
}

// ─── Subcategory stacked bar + list ────────────────────────────────────
function SubcategoryBreakdown({ subs, total }: { subs: Subcategory[]; total: number }) {
  if (!subs.length) return null
  const top = subs.slice(0, 10)
  return (
    <div style={{
      background:   UX.cardBg,
      border:       `0.5px solid ${UX.border}`,
      borderRadius: UX.r_lg,
      overflow:     'hidden' as const,
    }}>
      <div style={{ padding: '12px 16px', borderBottom: `0.5px solid ${UX.borderSoft}`, fontSize: UX.fsSection, fontWeight: UX.fwMedium, color: UX.ink1 }}>
        Where the money goes
      </div>
      <div style={{ padding: 16 }}>
        {/* Stacked bar */}
        <div style={{ display: 'flex', height: 14, borderRadius: 3, overflow: 'hidden' as const, background: UX.borderSoft, marginBottom: 12 }}>
          {top.map(s => {
            const pct = total > 0 ? (s.total_kr / total) * 100 : 0
            const color = SUB_TONE[s.subcategory ?? 'other'] ?? '#9ca3af'
            return <div key={s.key} title={`${s.label} — ${fmtKr(s.total_kr)} (${pct.toFixed(1)}%)`}
                         style={{ width: `${pct}%`, background: color }} />
          })}
        </div>
        {/* Legend rows */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '6px 14px', fontSize: UX.fsBody }}>
          {top.map(s => {
            const pct = total > 0 ? (s.total_kr / total) * 100 : 0
            const color = SUB_TONE[s.subcategory ?? 'other'] ?? '#9ca3af'
            return (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                <span style={{ flex: 1, color: UX.ink2, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>{s.label}</span>
                <span style={{ color: UX.ink1, fontWeight: UX.fwMedium, fontVariantNumeric: 'tabular-nums' as const, whiteSpace: 'nowrap' as const }}>
                  {fmtKr(s.total_kr)} <span style={{ color: UX.ink4, fontWeight: UX.fwRegular }}>{fmtPct(pct)}</span>
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── Line-item table ───────────────────────────────────────────────────
function LineItemsTable({ rows, showMonth }: { rows: LineItem[]; showMonth: boolean }) {
  const [sortBy, setSortBy] = useState<'amount' | 'period' | 'label'>('amount')
  const sorted = useMemo(() => {
    const cp = [...rows]
    if (sortBy === 'amount') cp.sort((a, b) => b.amount - a.amount)
    if (sortBy === 'period') cp.sort((a, b) => (b.period_year - a.period_year) || (b.period_month - a.period_month))
    if (sortBy === 'label')  cp.sort((a, b) => (a.label_sv ?? '').localeCompare(b.label_sv ?? ''))
    return cp
  }, [rows, sortBy])

  return (
    <div style={{ background: UX.cardBg, border: `0.5px solid ${UX.border}`, borderRadius: UX.r_lg, overflow: 'hidden' as const }}>
      <div style={{ padding: '10px 16px', background: UX.subtleBg, borderBottom: `0.5px solid ${UX.borderSoft}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: UX.fsSection, fontWeight: UX.fwMedium, color: UX.ink1 }}>
        <span>Line items ({rows.length})</span>
        <SegmentedToggle
          options={[
            { value: 'amount', label: 'Amount' },
            { value: 'period', label: 'Period' },
            { value: 'label',  label: 'A–Z' },
          ]}
          value={sortBy}
          onChange={v => setSortBy(v as any)}
        />
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: UX.fsBody }}>
        <thead>
          <tr style={{ background: UX.subtleBg, borderBottom: `0.5px solid ${UX.borderSoft}` }}>
            <th style={thStyle}>Label</th>
            <th style={thStyle}>Category</th>
            <th style={thStyle}>Account</th>
            {showMonth && <th style={thStyle}>Period</th>}
            <th style={{ ...thStyle, textAlign: 'right' as const }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(r => {
            const color = SUB_TONE[r.subcategory ?? 'other'] ?? '#9ca3af'
            return (
              <tr key={r.id} style={{ borderBottom: `0.5px solid ${UX.borderSoft}` }}>
                <td style={{ padding: '7px 14px', color: UX.ink1 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 2, background: color }} />
                    {r.label_sv}
                  </span>
                </td>
                <td style={{ padding: '7px 14px', color: UX.ink3, fontSize: UX.fsMicro }}>
                  {r.subcategory ?? <span style={{ color: UX.ink5 }}>—</span>}
                </td>
                <td style={{ padding: '7px 14px', color: UX.ink4, fontSize: UX.fsMicro, fontVariantNumeric: 'tabular-nums' as const }}>
                  {r.fortnox_account ?? '—'}
                </td>
                {showMonth && (
                  <td style={{ padding: '7px 14px', color: UX.ink3, fontSize: UX.fsMicro }}>
                    {r.period_month && r.period_month > 0 ? `${MONTHS_SHORT[r.period_month - 1]} ${r.period_year}` : `${r.period_year} (annual)`}
                  </td>
                )}
                <td style={{ padding: '7px 14px', textAlign: 'right' as const, color: UX.ink1, fontWeight: UX.fwMedium, fontVariantNumeric: 'tabular-nums' as const }}>
                  {fmtKr(r.amount)}
                </td>
              </tr>
            )
          })}
          {sorted.length === 0 && (
            <tr><td colSpan={showMonth ? 5 : 4} style={{ padding: 30, textAlign: 'center' as const, color: UX.ink4 }}>No line items for this filter.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

const thStyle = {
  padding: '8px 14px',
  textAlign: 'left' as const,
  fontSize: UX.fsNano,
  fontWeight: UX.fwMedium,
  color: UX.ink4,
  letterSpacing: '.06em',
  textTransform: 'uppercase' as const,
}

function monthBtn(active: boolean) {
  return {
    padding: '4px 10px',
    background: active ? UX.navy : UX.cardBg,
    color: active ? 'white' : UX.ink2,
    border: `0.5px solid ${active ? UX.navy : UX.border}`,
    borderRadius: UX.r_md,
    fontSize: UX.fsMicro,
    fontWeight: UX.fwMedium,
    cursor: 'pointer',
  } as any
}
