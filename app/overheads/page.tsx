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
  // KPI inputs — revenue + covers per month from monthly_metrics
  const [metrics,    setMetrics]    = useState<any[]>([])
  // YoY drift — line items from the previous year for comparison
  const [prevSubs,   setPrevSubs]   = useState<Subcategory[]>([])
  // Industry benchmarks — anonymised cross-tenant medians per subcategory
  const [benchmarks, setBenchmarks] = useState<Record<string, { sample_size: number; median_kr: number }>>({})

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

  // Load overhead line items + monthly metrics + prior-year for YoY drift
  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true)
    try {
      const [liRes, prevRes, mmRes, ciRes, bRes] = await Promise.all([
        fetch(`/api/overheads/line-items?business_id=${bizId}&year_from=${year}&year_to=${year}&category=other_cost`, { cache: 'no-store' }),
        fetch(`/api/overheads/line-items?business_id=${bizId}&year_from=${year - 1}&year_to=${year - 1}&category=other_cost`, { cache: 'no-store' }),
        fetch(`/api/metrics/monthly?business_id=${bizId}&year=${year}`, { cache: 'no-store' }),
        fetch(`/api/cost-insights?business_id=${bizId}`, { cache: 'no-store' }),
        fetch(`/api/overheads/benchmarks`, { cache: 'no-store' }),
      ])
      const lj = await liRes.json().catch(() => ({}))
      const pj = await prevRes.json().catch(() => ({}))
      const mj = await mmRes.json().catch(() => ({}))
      const cj = await ciRes.json().catch(() => ({}))
      const bj = await bRes.json().catch(() => ({}))
      setRows(Array.isArray(lj.rows) ? lj.rows : [])
      setSubs(Array.isArray(lj.subcategories) ? lj.subcategories : [])
      setPrevSubs(Array.isArray(pj.subcategories) ? pj.subcategories : [])
      setMetrics(Array.isArray(mj.rows) ? mj.rows : [])
      setInsights(Array.isArray(cj.items) ? cj.items : [])
      const bm: Record<string, { sample_size: number; median_kr: number }> = {}
      for (const b of (bj.benchmarks ?? [])) bm[b.subcategory] = { sample_size: b.sample_size, median_kr: b.median_kr }
      setBenchmarks(bm)
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
            {/* Overhead health KPIs — rent %, per-cover, software ratio */}
            <OverheadKpis
              subs={subsInView}
              total={total}
              metrics={metrics}
              monthFilter={monthFilter}
            />

            {/* Subcategory breakdown */}
            <SubcategoryBreakdown subs={subsInView} total={total} benchmarks={benchmarks} monthsInView={monthFilter === 'all' ? monthsCovered.size : 1} />

            {/* Year-over-year drift — only when previous year has data */}
            {prevSubs.length > 0 && (
              <YoyDrift thisYear={subs} prevYear={prevSubs} year={year} />
            )}

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
// ─── Overhead health KPIs ──────────────────────────────────────────────
// Classic restaurant-management ratios: rent % of revenue (8-12% healthy),
// overheads per cover, software as % of overheads, overhead % of revenue.
// All computed at the business scope — these are business-wide metrics.
function OverheadKpis({ subs, total, metrics, monthFilter }: { subs: Subcategory[]; total: number; metrics: any[]; monthFilter: 'all' | number }) {
  const inScope = monthFilter === 'all' ? metrics : metrics.filter(m => m.month === monthFilter)
  const revenue = inScope.reduce((s, m) => s + Number(m.revenue ?? 0), 0)
  const covers  = inScope.reduce((s, m) => s + Number(m.covers  ?? 0), 0)

  const rent = subs.find(s => s.subcategory === 'rent')?.total_kr ?? 0
  const sw   = subs.find(s => s.subcategory === 'software')?.total_kr ?? 0
  const bank = subs.find(s => s.subcategory === 'bank_fees')?.total_kr ?? 0

  const rentPct      = revenue > 0 ? (rent / revenue) * 100 : null
  const overheadPct  = revenue > 0 ? (total / revenue) * 100 : null
  const ovhPerCover  = covers  > 0 ? total / covers : null
  const swPct        = total   > 0 ? (sw / total) * 100 : null
  const bankPct      = revenue > 0 ? (bank / revenue) * 100 : null

  // Tone thresholds — restaurant industry norms from DESIGN.md and
  // common Swedish operator benchmarks.
  const rentTone  = rentPct == null ? 'neutral' : rentPct <= 12 ? 'good' : rentPct <= 15 ? 'warning' : 'bad'
  const ovhTone   = overheadPct == null ? 'neutral' : overheadPct <= 20 ? 'good' : overheadPct <= 30 ? 'warning' : 'bad'
  const swTone    = swPct == null ? 'neutral' : swPct <= 3 ? 'good' : swPct <= 6 ? 'warning' : 'bad'
  const bankTone  = bankPct == null ? 'neutral' : bankPct <= 0.5 ? 'good' : bankPct <= 1 ? 'warning' : 'bad'

  const items = [
    { label: 'Rent % of revenue', value: rentPct != null ? fmtPct(rentPct) : '—', sub: rent ? `${fmtKr(rent)} paid` : 'no rent recorded', tone: rentTone,
      help: 'Industry healthy: ≤12%. Above 15% starts to bite margin.' },
    { label: 'Overhead % of rev',  value: overheadPct != null ? fmtPct(overheadPct) : '—', sub: `${fmtKr(total)} total overheads`, tone: ovhTone,
      help: 'All non-food, non-staff costs. Healthy ≤20%.' },
    { label: 'Overhead / cover',   value: ovhPerCover != null ? fmtKr(ovhPerCover) : '—', sub: covers > 0 ? `${covers.toLocaleString('en-GB')} covers` : 'no cover data', tone: 'neutral' },
    { label: 'Software share',     value: swPct != null ? fmtPct(swPct) : '—', sub: sw ? `${fmtKr(sw)} in subs` : 'no software costs', tone: swTone,
      help: 'Industry median ≈ 1.5% of overheads. >6% = audit tools.' },
    { label: 'Bank fees / rev',    value: bankPct != null ? fmtPct(bankPct) : '—', sub: bank ? fmtKr(bank) : 'no fees recorded', tone: bankTone,
      help: 'Healthy ≤0.5%. >1% means negotiate card acquirer rates.' },
  ]

  return (
    <div style={{
      background:   UX.cardBg,
      border:       `0.5px solid ${UX.border}`,
      borderRadius: UX.r_lg,
      padding:      '12px 14px',
      marginBottom: 12,
      display:      'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
      gap:          10,
    }}>
      {items.map(it => (
        <div key={it.label} title={(it as any).help}
             style={{ padding: '8px 10px', borderRight: `0.5px solid ${UX.borderSoft}`, cursor: (it as any).help ? 'help' : 'default' }}>
          <div style={{ fontSize: 10, fontWeight: UX.fwMedium, color: UX.ink4, letterSpacing: '.05em', textTransform: 'uppercase' as const, marginBottom: 3 }}>
            {it.label}
          </div>
          <div style={{ fontSize: 18, fontWeight: UX.fwMedium, color:
              it.tone === 'good'    ? UX.greenInk
            : it.tone === 'warning' ? UX.amberInk
            : it.tone === 'bad'     ? UX.redInk
            :                         UX.ink1,
            fontVariantNumeric: 'tabular-nums' as const,
          }}>{it.value}</div>
          <div style={{ fontSize: 10, color: UX.ink4, marginTop: 2 }}>{it.sub}</div>
        </div>
      ))}
    </div>
  )
}

// ─── Year-over-year drift — per subcategory ──────────────────────────
function YoyDrift({ thisYear, prevYear, year }: { thisYear: Subcategory[]; prevYear: Subcategory[]; year: number }) {
  // Build a merged lookup by subcategory key so every category we saw in
  // either year shows up (new and dropped lines are the biggest signals).
  const map = new Map<string, { label: string; subcategory: string | null; thisKr: number; prevKr: number }>()
  for (const s of thisYear) map.set(s.key, { label: s.label, subcategory: s.subcategory, thisKr: s.total_kr, prevKr: 0 })
  for (const s of prevYear) {
    const ex = map.get(s.key)
    if (ex) ex.prevKr = s.total_kr
    else     map.set(s.key, { label: s.label, subcategory: s.subcategory, thisKr: 0, prevKr: s.total_kr })
  }

  // Rank by absolute drift (either direction) — biggest surprises first.
  const rows = Array.from(map.values())
    .map(r => {
      const delta   = r.thisKr - r.prevKr
      const pct     = r.prevKr > 0 ? (delta / r.prevKr) * 100 : (r.thisKr > 0 ? 100 : 0)
      const isNew   = r.prevKr === 0 && r.thisKr > 0
      const dropped = r.thisKr === 0 && r.prevKr > 0
      return { ...r, delta, pct, isNew, dropped }
    })
    .filter(r => Math.abs(r.delta) > 100)   // noise floor — ignore ±100 kr
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 12)

  if (!rows.length) return null

  return (
    <div style={{
      background:   UX.cardBg,
      border:       `0.5px solid ${UX.border}`,
      borderRadius: UX.r_lg,
      overflow:     'hidden' as const,
      marginTop:    12,
    }}>
      <div style={{ padding: '12px 16px', borderBottom: `0.5px solid ${UX.borderSoft}`, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={{ fontSize: UX.fsSection, fontWeight: UX.fwMedium, color: UX.ink1 }}>Year over year drift</div>
        <div style={{ fontSize: UX.fsMicro, color: UX.ink4 }}>{year} vs {year - 1}</div>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: UX.fsBody }}>
        <thead>
          <tr style={{ background: UX.subtleBg, borderBottom: `0.5px solid ${UX.borderSoft}` }}>
            <th style={{ padding: '8px 14px', textAlign: 'left' as const, fontSize: UX.fsNano, fontWeight: UX.fwMedium, color: UX.ink4, letterSpacing: '.06em', textTransform: 'uppercase' as const }}>Subcategory</th>
            <th style={{ padding: '8px 14px', textAlign: 'right' as const, fontSize: UX.fsNano, fontWeight: UX.fwMedium, color: UX.ink4, letterSpacing: '.06em', textTransform: 'uppercase' as const }}>{year - 1}</th>
            <th style={{ padding: '8px 14px', textAlign: 'right' as const, fontSize: UX.fsNano, fontWeight: UX.fwMedium, color: UX.ink4, letterSpacing: '.06em', textTransform: 'uppercase' as const }}>{year}</th>
            <th style={{ padding: '8px 14px', textAlign: 'right' as const, fontSize: UX.fsNano, fontWeight: UX.fwMedium, color: UX.ink4, letterSpacing: '.06em', textTransform: 'uppercase' as const }}>Δ kr</th>
            <th style={{ padding: '8px 14px', textAlign: 'right' as const, fontSize: UX.fsNano, fontWeight: UX.fwMedium, color: UX.ink4, letterSpacing: '.06em', textTransform: 'uppercase' as const }}>Δ %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const color = SUB_TONE[r.subcategory ?? 'other'] ?? '#9ca3af'
            const deltaColor = r.isNew          ? UX.redInk
                             : r.dropped        ? UX.greenInk
                             : Math.abs(r.pct) >= 10 && r.delta > 0 ? UX.redInk
                             : Math.abs(r.pct) >= 10 && r.delta < 0 ? UX.greenInk
                             :                                        UX.ink3
            return (
              <tr key={r.label} style={{ borderBottom: `0.5px solid ${UX.borderSoft}` }}>
                <td style={{ padding: '7px 14px', color: UX.ink1 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 2, background: color }} />
                    {r.label}
                    {r.isNew   && <span style={{ fontSize: 9, background: UX.redBg,   color: UX.redInk2,   padding: '1px 5px', borderRadius: 3, letterSpacing: '.04em' }}>NEW</span>}
                    {r.dropped && <span style={{ fontSize: 9, background: UX.greenBg, color: UX.greenInk,  padding: '1px 5px', borderRadius: 3, letterSpacing: '.04em' }}>DROPPED</span>}
                  </span>
                </td>
                <td style={{ padding: '7px 14px', textAlign: 'right' as const, color: UX.ink3, fontVariantNumeric: 'tabular-nums' as const }}>{r.prevKr > 0 ? fmtKr(r.prevKr) : '—'}</td>
                <td style={{ padding: '7px 14px', textAlign: 'right' as const, color: UX.ink1, fontWeight: UX.fwMedium, fontVariantNumeric: 'tabular-nums' as const }}>{r.thisKr > 0 ? fmtKr(r.thisKr) : '—'}</td>
                <td style={{ padding: '7px 14px', textAlign: 'right' as const, color: deltaColor, fontWeight: UX.fwMedium, fontVariantNumeric: 'tabular-nums' as const }}>
                  {r.delta > 0 ? '+' : r.delta < 0 ? '−' : ''}{fmtKr(Math.abs(r.delta))}
                </td>
                <td style={{ padding: '7px 14px', textAlign: 'right' as const, color: deltaColor, fontWeight: UX.fwMedium, fontVariantNumeric: 'tabular-nums' as const }}>
                  {r.isNew ? 'new' : r.dropped ? 'dropped' : `${r.pct > 0 ? '+' : ''}${r.pct.toFixed(0)}%`}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function SubcategoryBreakdown({ subs, total, benchmarks, monthsInView }: { subs: Subcategory[]; total: number; benchmarks: Record<string, { sample_size: number; median_kr: number }>; monthsInView: number }) {
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
        {/* Legend rows with benchmark chip when available */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '6px 14px', fontSize: UX.fsBody }}>
          {top.map(s => {
            const pct = total > 0 ? (s.total_kr / total) * 100 : 0
            const color = SUB_TONE[s.subcategory ?? 'other'] ?? '#9ca3af'
            const bm = s.subcategory ? benchmarks[s.subcategory] : null
            // Our monthly spend for this sub (average across months in view)
            // vs the benchmark median (which is a monthly figure).
            const ourMonthly = monthsInView > 0 ? s.total_kr / monthsInView : 0
            const medMonthly = bm ? Number(bm.median_kr) : 0
            const ratio      = medMonthly > 0 ? ourMonthly / medMonthly : null
            const bmTone     = ratio == null ? 'neutral'
                             : ratio <= 0.8  ? 'good'
                             : ratio <= 1.2  ? 'neutral'
                             :                 'bad'
            return (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                <span style={{ flex: 1, color: UX.ink2, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
                  {s.label}
                  {bm && (
                    <span
                      title={`Industry median monthly: ${fmtKr(medMonthly)} across ${bm.sample_size} restaurants. Your monthly avg in view: ${fmtKr(ourMonthly)}.`}
                      style={{
                        marginLeft:    6,
                        fontSize:      9,
                        padding:       '1px 5px',
                        borderRadius:  3,
                        letterSpacing: '.04em',
                        background:    bmTone === 'good' ? UX.greenBg   : bmTone === 'bad' ? UX.redBg    : UX.borderSoft,
                        color:         bmTone === 'good' ? UX.greenInk  : bmTone === 'bad' ? UX.redInk2  : UX.ink3,
                        fontWeight:    UX.fwMedium,
                        whiteSpace:    'nowrap' as const,
                      }}
                    >
                      {ratio! < 1 ? 'below median' : ratio! > 1 ? `${(ratio! * 100).toFixed(0)}% of median` : 'at median'}
                    </span>
                  )}
                </span>
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
