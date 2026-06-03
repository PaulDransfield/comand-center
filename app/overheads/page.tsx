'use client'
// @ts-nocheck
// app/overheads/page.tsx — full rebuild on the new system
//
// Same treatment as the other rebuilds. Every surface lives on UXP +
// KpiCardUX / BreakdownTable; the legacy PageHero / SupportingStats /
// TopBar / AttentionPanel / SegmentedToggle are gone from this page.
//
// Year nav lives in the AppShell toolbar's date stepper. The Cost
// Review + Upload PDFs actions sit in a header pill row.
//
// Data unchanged:
//   /api/overheads/line-items (curr + prev year)  — tracker_line_items rows
//   /api/metrics/monthly                          — for revenue base in % calcs
//   /api/cost-insights                            — AI cost intelligence items
//   /api/overheads/benchmarks                     — industry medians per subcat
//   /api/overheads/reconciliation                 — invoice vs Fortnox findings
//   /api/overheads/vat-projection                 — next-filing estimate
//   /api/overheads/projection                     — review queue + savings
//
// The /overheads/review and /overheads/upload subpages are separate
// rebuild targets — they're heavy interactive workflows on their own.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import dynamicImport from 'next/dynamic'

const AskAI = dynamicImport(() => import('@/components/AskAI'), { ssr: false, loading: () => null })

import AppShell from '@/components/AppShell'
import KpiCardUX from '@/components/ux/KpiCard'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'
import Sparkline from '@/components/ui/Sparkline'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr, fmtPct } from '@/lib/format'

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
  key:         string
  subcategory: string | null
  label:       string
  total_kr:    number
  months_seen: number
}
interface ReconItem  { tone: 'good' | 'warning' | 'bad'; entity: string; message: string }
interface InsightItem { tone: 'good' | 'warning' | 'bad'; entity: string; message: string }

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const MONTHS       = ['January','February','March','April','May','June','July','August','September','October','November','December']

export default function OverheadsPage() {
  const router = useRouter()
  const now    = new Date()
  const [bizId,        setBizId]        = useState<string | null>(null)
  const [year,         setYear]         = useState<number>(now.getFullYear())
  const [monthFilter,  setMonthFilter]  = useState<'all' | number>('all')
  const [rows,         setRows]         = useState<LineItem[]>([])
  const [subs,         setSubs]         = useState<Subcategory[]>([])
  const [prevSubs,     setPrevSubs]     = useState<Subcategory[]>([])
  const [metrics,      setMetrics]      = useState<any[]>([])
  const [insights,     setInsights]     = useState<InsightItem[]>([])
  const [benchmarks,   setBenchmarks]   = useState<Record<string, { sample_size: number; median_kr: number }>>({})
  const [recon,        setRecon]        = useState<ReconItem[]>([])
  const [vat,          setVat]          = useState<any>(null)
  const [reviewProj,   setReviewProj]   = useState<any>(null)
  const [loading,      setLoading]      = useState(true)

  // Subscribe to BizPicker
  useEffect(() => {
    const sync = () => { const s = localStorage.getItem('cc_selected_biz'); if (s) setBizId(s) }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true)
    try {
      const [liRes, prevRes, mmRes, ciRes, bRes, rRes, vRes, opRes] = await Promise.all([
        fetch(`/api/overheads/line-items?business_id=${bizId}&year_from=${year}&year_to=${year}&category=other_cost`, { cache: 'no-store' }),
        fetch(`/api/overheads/line-items?business_id=${bizId}&year_from=${year - 1}&year_to=${year - 1}&category=other_cost`, { cache: 'no-store' }),
        fetch(`/api/metrics/monthly?business_id=${bizId}&year=${year}`, { cache: 'no-store' }),
        fetch(`/api/cost-insights?business_id=${bizId}`, { cache: 'no-store' }),
        fetch(`/api/overheads/benchmarks`, { cache: 'no-store' }),
        fetch(`/api/overheads/reconciliation?business_id=${bizId}`, { cache: 'no-store' }),
        fetch(`/api/overheads/vat-projection?business_id=${bizId}`, { cache: 'no-store' }),
        fetch(`/api/overheads/projection?business_id=${bizId}`, { cache: 'no-store' }),
      ])
      const lj  = await liRes.json().catch(()  => ({}))
      const pj  = await prevRes.json().catch(() => ({}))
      const mj  = await mmRes.json().catch(()  => ({}))
      const cj  = await ciRes.json().catch(()  => ({}))
      const bj  = await bRes.json().catch(()   => ({}))
      const rj  = await rRes.json().catch(()   => ({}))
      const vj  = await vRes.json().catch(()   => ({}))
      const opj = await opRes.json().catch(()  => ({}))
      setRows(Array.isArray(lj.rows) ? lj.rows : [])
      setSubs(Array.isArray(lj.subcategories) ? lj.subcategories : [])
      setPrevSubs(Array.isArray(pj.subcategories) ? pj.subcategories : [])
      setMetrics(Array.isArray(mj.rows) ? mj.rows : [])
      setInsights(Array.isArray(cj.items) ? cj.items : [])
      setRecon(Array.isArray(rj.items) ? rj.items : [])
      setVat(vj && !vj.error ? vj : null)
      setReviewProj(opj && !opj.error ? opj : null)
      const bm: Record<string, { sample_size: number; median_kr: number }> = {}
      for (const b of (bj.benchmarks ?? [])) bm[b.subcategory] = { sample_size: b.sample_size, median_kr: b.median_kr }
      setBenchmarks(bm)
    } catch {}
    setLoading(false)
  }, [bizId, year])
  useEffect(() => { if (bizId) load() }, [bizId, load])

  // Derived
  const filtered = useMemo(
    () => monthFilter === 'all' ? rows : rows.filter(r => r.period_month === monthFilter),
    [rows, monthFilter],
  )
  const total      = filtered.reduce((s, r) => s + Number(r.amount ?? 0), 0)
  const subsInView = useMemo(() => {
    if (monthFilter === 'all') return subs
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

  // YoY drift — for the largest category compare current vs prev-year monthly average
  const yoyDrift = useMemo(() => {
    const ranked: Array<{ key: string; label: string; pct: number; deltaKr: number }> = []
    for (const sub of subsInView.slice(0, 8)) {
      const prev = prevSubs.find(p => p.key === sub.key)
      if (!prev || prev.total_kr === 0) continue
      const pct = ((sub.total_kr - prev.total_kr) / prev.total_kr) * 100
      ranked.push({ key: sub.key, label: sub.label, pct, deltaKr: sub.total_kr - prev.total_kr })
    }
    return ranked.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
  }, [subsInView, prevSubs])
  const biggestDrift = yoyDrift[0] ?? null

  // Total revenue from monthly_metrics — gives an "overheads % of revenue" anchor
  const totalRevenue = metrics.reduce((s: number, r: any) => s + Number(r.revenue ?? 0), 0)
  const overheadsPctOfRev = totalRevenue > 0 ? (total / totalRevenue) * 100 : null

  const pendingCount    = Number(reviewProj?.pending_count ?? 0)
  const potentialMonthly = Number(reviewProj?.savings?.total_sek ?? 0)

  // Year nav
  const canStepNext = year < now.getFullYear() + 1
  function step(dir: -1 | 1) { setYear(y => y + dir) }

  // Honesty: page is genuinely useful only when there's overhead data
  const hasAnyData = rows.length > 0
  const noData     = !loading && !hasAnyData

  return (
    <AppShell
      dateLabel={String(year)}
      onPrev={() => step(-1)}
      onNext={canStepNext ? () => step(1) : undefined}
    >
      <div style={{ display: 'grid', gap: 14, maxWidth: 1280 }}>

        {/* Header row — Cost review badge + Upload action */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const }}>
          <button
            type="button"
            onClick={() => router.push('/overheads/review')}
            style={{
              display:      'inline-flex',
              alignItems:   'center',
              gap:          6,
              padding:      '5px 12px',
              background:   pendingCount > 0 ? UXP.lavFill : UXP.cardBg,
              color:        pendingCount > 0 ? UXP.lavText : UXP.ink2,
              border:       `0.5px solid ${UXP.border}`,
              borderRadius: 999,
              fontSize:     11,
              fontWeight:   500,
              fontFamily:   'inherit',
              cursor:       'pointer',
            }}
          >
            Cost review
            {pendingCount > 0 && (
              <span style={{
                padding:      '1px 7px',
                background:   UXP.lavDeep,
                color:        '#fff',
                borderRadius: 999,
                fontSize:     9,
                fontWeight:   600,
                fontVariantNumeric: 'tabular-nums' as const,
              }}>
                {pendingCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => router.push('/overheads/upload')}
            style={{
              padding:      '5px 12px',
              background:   UXP.lav,
              color:        '#fff',
              border:       'none',
              borderRadius: 999,
              fontSize:     11,
              fontWeight:   500,
              fontFamily:   'inherit',
              cursor:       'pointer',
            }}
          >
            + Upload Fortnox PDFs
          </button>
        </div>

        {/* KPI strip */}
        <KpiStrip
          year={year}
          total={total}
          monthsCovered={monthsCovered.size}
          overheadsPctOfRev={overheadsPctOfRev}
          pendingCount={pendingCount}
          potentialMonthly={potentialMonthly}
          biggestDrift={biggestDrift}
          subsCount={subsInView.length}
          topSub={subsInView[0] ?? null}
        />

        {/* Cost-review banner (when pending) */}
        {pendingCount > 0 && (
          <CostReviewBanner
            pending={pendingCount}
            potential={potentialMonthly}
            onClick={() => router.push('/overheads/review')}
          />
        )}

        {/* Month filter row */}
        {hasAnyData && (
          <MonthFilter value={monthFilter} onChange={setMonthFilter} availableMonths={Array.from(monthsCovered).sort((a, b) => a - b)} />
        )}

        {/* Loading + empty states */}
        {loading && (
          <div style={{ padding: 60, textAlign: 'center' as const, color: UXP.ink3, fontSize: 12 }}>Loading overheads…</div>
        )}
        {noData && (
          <EmptyCard
            title={`No Fortnox overhead data for ${year} yet`}
            body={<>Upload your annual Resultatrapport to surface the line-by-line overhead breakdown. <a href="/overheads/upload" style={{ color: UXP.lavText, textDecoration: 'underline' }}>Upload now →</a></>}
          />
        )}

        {hasAnyData && (
          <>
            {/* Subcategory breakdown */}
            <SubcategoryBreakdown
              subs={subsInView}
              prevSubs={prevSubs}
              benchmarks={benchmarks}
              total={total}
              monthsCovered={monthsCovered.size}
              allRows={rows}
              bizId={bizId}
              year={year}
              monthFilter={monthFilter}
            />

            {/* Line-item table */}
            <LineItemTable rows={filtered} total={total} />

            {/* AI cost insights */}
            {insights.length > 0 && <AttentionCard title="AI cost intelligence" items={insights} />}

            {/* Reconciliation findings */}
            {recon.length > 0 && <AttentionCard title="Invoice reconciliation" items={recon} />}

            {/* VAT projection */}
            {vat && <VatCard vat={vat} />}
          </>
        )}
      </div>

      <AskAI
        page="overheads"
        context={hasAnyData ? [
          `Year ${year} overheads`,
          `Total ${fmtKr(total)} across ${rows.length} line items in ${monthsCovered.size} months${overheadsPctOfRev != null ? ` (~${fmtPct(overheadsPctOfRev)} of revenue)` : ''}.`,
          subsInView[0] ? `Largest category: ${subsInView[0].label} at ${fmtKr(subsInView[0].total_kr)}.` : null,
          pendingCount > 0 ? `${pendingCount} flag${pendingCount === 1 ? '' : 's'} pending review (${fmtKr(potentialMonthly)}/mo potential savings).` : null,
        ].filter(Boolean).join('\n') : `No overheads logged for ${year}.`}
      />
    </AppShell>
  )
}

// ════════════════════════════════════════════════════════════════════
// Sub-components
// ════════════════════════════════════════════════════════════════════

function KpiStrip({ year, total, monthsCovered, overheadsPctOfRev, pendingCount, potentialMonthly, biggestDrift, subsCount, topSub }: any) {
  const driftValue = biggestDrift
    ? `${biggestDrift.pct >= 0 ? '+' : ''}${biggestDrift.pct.toFixed(1)}%`
    : '—'
  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap:                 12,
    }}>
      <KpiCardUX
        title={`Overheads ${year}`}
        value={fmtKr(total)}
        microLabel={`${monthsCovered} month${monthsCovered === 1 ? '' : 's'} · ${subsCount} categor${subsCount === 1 ? 'y' : 'ies'}`}
      />
      <KpiCardUX
        title="% of revenue"
        value={overheadsPctOfRev != null ? fmtPct(overheadsPctOfRev) : '—'}
        variant={overheadsPctOfRev != null ? 'targetBand' : 'plain'}
        targetBand={overheadsPctOfRev != null ? {
          actualPct:    Math.min(100, overheadsPctOfRev),
          targetMinPct: 10,
          targetMaxPct: 25,
        } : undefined}
        microLabel="Target 10-25%"
      />
      <KpiCardUX
        title="YoY drift"
        value={driftValue}
        deltaGood={false}
        delta={biggestDrift ? `${biggestDrift.deltaKr >= 0 ? '+' : '−'}${fmtKr(Math.abs(biggestDrift.deltaKr))}` : null}
        microLabel={biggestDrift ? biggestDrift.label : 'No prior-year data'}
      />
      <KpiCardUX
        title={pendingCount > 0 ? 'Pending review' : 'Largest category'}
        value={pendingCount > 0
          ? String(pendingCount)
          : (topSub ? fmtKr(topSub.total_kr) : '—')}
        deltaGood={pendingCount === 0}
        delta={pendingCount > 0 ? `~${fmtKr(potentialMonthly)}/mo` : null}
        microLabel={pendingCount > 0 ? 'Potential savings' : (topSub?.label ?? '')}
      />
    </div>
  )
}

// ── Cost-review CTA banner ─────────────────────────────────────────
function CostReviewBanner({ pending, potential, onClick }: { pending: number; potential: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background:    UXP.lavFill,
        border:        `0.5px solid ${UXP.lavMid}`,
        borderRadius:  UXP.r_lg,
        padding:       '12px 16px',
        display:       'flex',
        alignItems:    'center',
        justifyContent: 'space-between',
        gap:           12,
        cursor:        'pointer',
        fontFamily:    'inherit',
        textAlign:     'left' as const,
        color:         UXP.lavText,
      }}
    >
      <div>
        <div style={{ fontSize: 12, fontWeight: 500 }}>
          {pending} flag{pending === 1 ? '' : 's'} pending review
        </div>
        <div style={{ fontSize: 10, marginTop: 2, color: UXP.lavText, opacity: 0.85 }}>
          {potential > 0 ? `~${fmtKr(potential)}/mo potential savings if dismissed.` : 'Open the queue to confirm or dismiss.'}
        </div>
      </div>
      <span style={{ fontSize: 11, fontWeight: 500 }}>Review →</span>
    </button>
  )
}

// ── Month filter ───────────────────────────────────────────────────
function MonthFilter({ value, onChange, availableMonths }: any) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
      <FilterPill active={value === 'all'} onClick={() => onChange('all')}>All months</FilterPill>
      {availableMonths.map((m: number) => (
        <FilterPill key={m} active={value === m} onClick={() => onChange(m)}>
          {MONTHS_SHORT[m - 1]}
        </FilterPill>
      ))}
    </div>
  )
}

function FilterPill({ active, onClick, children }: any) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding:      '4px 10px',
        background:   active ? UXP.lavFill : UXP.cardBg,
        color:        active ? UXP.lavText : UXP.ink2,
        border:       `0.5px solid ${active ? UXP.lav : UXP.border}`,
        borderRadius: 999,
        fontSize:     10,
        fontWeight:   500,
        fontFamily:   'inherit',
        cursor:       'pointer',
        letterSpacing: '0.02em',
      }}
    >
      {children}
    </button>
  )
}

// ── Subcategory breakdown ──────────────────────────────────────────
// 6-month trend column derives a per-subcategory monthly series from the
// raw line-item rows of the current year. We pick the LAST 6 months of
// data we actually have rows for so the sparkline shows the recent
// trajectory rather than zero-padded leading months.
//
// The "Invoices" column opens a drawer that fetches the Fortnox
// drilldown for the current month-filter selection (year + month +
// category=other_cost) and shows the invoices touching that subcategory
// with one-click PDF buttons — same pattern as /suppliers.
function SubcategoryBreakdown({
  subs, prevSubs, benchmarks, total, monthsCovered,
  allRows, bizId, year, monthFilter,
}: any) {
  const [openSub, setOpenSub] = useState<any>(null)

  // Build the per-subcategory 6-month series.
  // We bucket allRows by (subcategory_key, month) and emit the last 6
  // months that have ANY data across all subs (so all sparklines share
  // the same x-axis). Computed BEFORE any early-return so hook order is
  // stable across renders (rules-of-hooks).
  const trendBySub = useMemo(() => {
    const monthsWithData = new Set<number>()
    const byKey: Record<string, Record<number, number>> = {}
    for (const r of (allRows ?? [])) {
      const key = r.subcategory ?? r.label_sv ?? 'other'
      const m = r.period_month
      monthsWithData.add(m)
      if (!byKey[key]) byKey[key] = {}
      byKey[key][m] = (byKey[key][m] ?? 0) + Number(r.amount ?? 0)
    }
    const sortedMonths = Array.from(monthsWithData).sort((a, b) => a - b)
    const sliceMonths  = sortedMonths.slice(-6) // trailing 6
    const out: Record<string, { months: number[]; series: number[] }> = {}
    for (const [k, bucket] of Object.entries(byKey)) {
      const series = sliceMonths.map(m => bucket[m] ?? 0)
      out[k] = { months: sliceMonths, series }
    }
    return out
  }, [allRows])

  if (!subs || subs.length === 0) return null
  const top = subs.slice(0, 12)

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Subcategory breakdown</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          Ranked by spend · 6-mo trend · YoY chip · click invoices for PDF
        </div>
      </div>
      <BreakdownTable
        columns={[
          { key: 'label', header: 'Category', align: 'left', render: (r: any) => (
            <span style={{ color: UXP.ink1, fontWeight: 500, textTransform: 'capitalize' as const }}>{r.label}</span>
          ) },
          { key: 'bar', header: 'Share', align: 'right', render: (r: any) => {
            const pct = total > 0 ? (r.total_kr / total) * 100 : 0
            return (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                <span style={{
                  display: 'inline-block', width: 80, height: 4, background: UXP.lavFill,
                  borderRadius: 2, overflow: 'hidden',
                }}>
                  <span style={{ display: 'block', height: '100%', width: `${Math.min(100, pct)}%`, background: UXP.lav }} />
                </span>
                <span style={{ fontSize: 10, color: UXP.ink2, fontVariantNumeric: 'tabular-nums' as const, minWidth: 36, textAlign: 'right' as const }}>
                  {pct.toFixed(1)}%
                </span>
              </span>
            )
          } },
          { key: 'amount', header: 'Amount', align: 'right', render: (r: any) => fmtKr(r.total_kr) },
          { key: 'months', header: 'Months', align: 'right', render: (r: any) => `${r.months_seen} of ${monthsCovered}` },
          { key: 'trend', header: '6-mo trend', align: 'right', render: (r: any) => {
            const t = trendBySub[r.key]
            if (!t || t.series.length < 2) return <span style={{ color: UXP.ink4 }}>—</span>
            // Tone: compare last value to mean of earlier values.
            const last = t.series[t.series.length - 1]
            const earlier = t.series.slice(0, -1)
            const mean = earlier.reduce((s, v) => s + v, 0) / Math.max(1, earlier.length)
            const tone: 'good' | 'bad' | 'warning' | 'neutral' =
              mean === 0                        ? 'neutral'
              : last > mean * 1.10              ? 'bad'
              : last < mean * 0.90              ? 'good'
              :                                   'warning'
            return (
              <span style={{ display: 'inline-block' }}>
                <Sparkline points={t.series} tone={tone} width={88} height={20} />
              </span>
            )
          } },
          { key: 'yoy', header: 'YoY', align: 'right', render: (r: any) => {
            const prev = prevSubs?.find((p: any) => p.key === r.key)
            if (!prev || prev.total_kr === 0) return <span style={{ color: UXP.ink4 }}>—</span>
            const pct = ((r.total_kr - prev.total_kr) / prev.total_kr) * 100
            return <DeltaChip value={`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`} positiveIsGood={false} />
          } },
          { key: 'bench', header: 'vs median', align: 'right', render: (r: any) => {
            const bm = benchmarks?.[r.subcategory ?? '']
            if (!bm || !bm.sample_size) return <span style={{ color: UXP.ink4 }}>—</span>
            const median = bm.median_kr
            const diff = median > 0 ? ((r.total_kr - median) / median) * 100 : 0
            const tone = Math.abs(diff) < 15 ? 'good' : diff > 0 ? 'bad' : 'good'
            return (
              <span style={{
                display:      'inline-block',
                fontSize:     9,
                fontWeight:   500,
                padding:      '2px 7px',
                borderRadius: 6,
                background:   tone === 'good' ? UXP.greenFill : UXP.roseFill,
                color:        tone === 'good' ? UXP.greenDeep : UXP.roseText,
                fontVariantNumeric: 'tabular-nums' as const,
              }}>
                {diff >= 0 ? '+' : ''}{diff.toFixed(0)}%
              </span>
            )
          } },
          { key: 'invoices', header: '', align: 'right', render: (r: any) => (
            <button
              type="button"
              onClick={() => setOpenSub(r)}
              style={{
                padding:      '3px 8px',
                background:   UXP.lavFill,
                color:        UXP.lavText,
                border:       'none',
                borderRadius: 999,
                fontSize:     9,
                fontWeight:   500,
                fontFamily:   'inherit',
                cursor:       'pointer',
                letterSpacing: '0.02em',
              }}
            >
              Invoices →
            </button>
          ) },
        ]}
        sections={[{ rows: top }]}
        footer={{
          label: 'Total',
          cells: {
            bar:      '',
            amount:   fmtKr(total),
            months:   '',
            trend:    '',
            yoy:      '',
            bench:    '',
            invoices: '',
          },
        }}
        rowKey={(row: any) => row.key}
      />
      {openSub && (
        <OverheadInvoiceDrawer
          sub={openSub}
          bizId={bizId}
          year={year}
          monthFilter={monthFilter}
          monthlySeries={trendBySub[openSub.key] ?? null}
          onClose={() => setOpenSub(null)}
        />
      )}
    </div>
  )
}

// ── Line-item table ────────────────────────────────────────────────
function LineItemTable({ rows, total }: { rows: LineItem[]; total: number }) {
  if (!rows || rows.length === 0) return null
  const sorted = [...rows].sort((a, b) => {
    if (a.period_year !== b.period_year) return b.period_year - a.period_year
    if (a.period_month !== b.period_month) return b.period_month - a.period_month
    return Number(b.amount ?? 0) - Number(a.amount ?? 0)
  })
  // Cap at 80 visible to keep render light
  const visible = sorted.slice(0, 80)
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Line items</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          {sorted.length} item{sorted.length === 1 ? '' : 's'}
          {sorted.length > visible.length ? ` · showing top ${visible.length}` : ''}
        </div>
      </div>
      <BreakdownTable<LineItem>
        columns={[
          { key: 'month', header: 'Month', align: 'left', render: (r) => (
            <span style={{ color: UXP.ink2 }}>{MONTHS_SHORT[r.period_month - 1]}</span>
          ) },
          { key: 'label', header: 'Description', align: 'left', render: (r) => (
            <span>
              <span style={{ color: UXP.ink1, fontWeight: 500 }}>{r.label_sv ?? '—'}</span>
              {r.subcategory && (
                <span style={{ display: 'block', fontSize: 9, color: UXP.ink4, marginTop: 1, textTransform: 'capitalize' as const }}>
                  {r.subcategory}
                </span>
              )}
            </span>
          ) },
          { key: 'account', header: 'BAS', align: 'right', render: (r) =>
            r.fortnox_account ? <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, color: UXP.ink3 }}>{r.fortnox_account}</span> : <span style={{ color: UXP.ink4 }}>—</span>
          },
          { key: 'amount', header: 'Amount', align: 'right', render: (r) => fmtKr(Number(r.amount ?? 0)) },
        ]}
        sections={[{ rows: visible }]}
        footer={{
          label: 'Total (visible)',
          cells: {
            label:   '',
            account: '',
            amount:  fmtKr(visible.reduce((s, r) => s + Number(r.amount ?? 0), 0)),
          },
        }}
        rowKey={(row, idx) => row.id ?? String(idx)}
      />
    </div>
  )
}

// ── Attention card (AI insights + reconciliation) ──────────────────
function AttentionCard({ title, items }: { title: string; items: Array<{ tone: 'good' | 'warning' | 'bad'; entity: string; message: string }> }) {
  if (!items || items.length === 0) return null
  return (
    <div style={cardStyle()}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>{title}</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          {items.length} item{items.length === 1 ? '' : 's'}
        </div>
      </div>
      {items.map((it, idx) => {
        const palette = it.tone === 'good' ? { bar: UXP.green, fg: UXP.greenDeep }
                       : it.tone === 'bad' ? { bar: UXP.rose,  fg: UXP.roseText  }
                       :                      { bar: UXP.coral, fg: UXP.coral    }
        return (
          <div key={idx} style={{
            display:             'grid',
            gridTemplateColumns: '4px auto 1fr',
            gap:                 12,
            alignItems:          'center',
            padding:             '10px 0',
            borderBottom:        idx < items.length - 1 ? `0.5px solid ${UXP.borderSoft}` : 'none',
          }}>
            <span style={{ width: 4, height: '100%', minHeight: 24, background: palette.bar, borderRadius: 2 }} />
            <span style={{
              fontSize:      9,
              fontWeight:    600,
              letterSpacing: '0.04em',
              color:         palette.fg,
              textTransform: 'uppercase' as const,
              minWidth:      72,
            }}>{it.entity}</span>
            <span style={{ fontSize: 11, color: UXP.ink2, lineHeight: 1.4 }}>{it.message}</span>
          </div>
        )
      })}
    </div>
  )
}

// ── VAT projection ─────────────────────────────────────────────────
function VatCard({ vat }: { vat: any }) {
  return (
    <div style={cardStyle()}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>VAT projection</div>
          <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
            {vat.period_label ?? 'Next filing'}
          </div>
        </div>
        <span style={{
          fontFamily:         'var(--font-display)',
          fontSize:           20,
          fontWeight:         500,
          color:              Number(vat.net_due ?? 0) >= 0 ? UXP.rose : UXP.green,
          letterSpacing:      '-0.02em',
          fontVariantNumeric: 'tabular-nums' as const,
        }}>
          {Number(vat.net_due ?? 0) >= 0 ? '−' : '+'}{fmtKr(Math.abs(Number(vat.net_due ?? 0)))}
        </span>
      </div>
      <div style={{
        display:             'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
        gap:                 10,
      }}>
        <MiniStat label="Out-VAT (sales)" value={vat.out_vat != null ? fmtKr(vat.out_vat) : '—'} />
        <MiniStat label="In-VAT (costs)"  value={vat.in_vat  != null ? fmtKr(vat.in_vat)  : '—'} />
        {vat.notes && (
          <div style={{ gridColumn: '1 / -1', fontSize: 11, color: UXP.ink3, lineHeight: 1.5 }}>
            {vat.notes}
          </div>
        )}
      </div>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: UXP.subtleBg, padding: '8px 10px', borderRadius: 8 }}>
      <div style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{label}</div>
      <div style={{
        fontSize:           14,
        fontWeight:         500,
        color:              UXP.ink1,
        marginTop:          2,
        fontVariantNumeric: 'tabular-nums' as const,
      }}>{value}</div>
    </div>
  )
}

// ── Invoice drilldown drawer ───────────────────────────────────────
// Mirror of the /suppliers InvoiceDrawer pattern. On open: POST to the
// existing /api/integrations/fortnox/drilldown for each month covered
// (cached server-side at 5min TTL so subsequent opens are cheap), then
// filter the supplier-invoice list to those touching THIS subcategory.
//
// PDF buttons stream through the existing /api/integrations/fortnox/file
// proxy in an inline iframe modal — never link out to Fortnox web.
function OverheadInvoiceDrawer({
  sub, bizId, year, monthFilter, monthlySeries, onClose,
}: {
  sub: any
  bizId: string | null
  year: number
  monthFilter: 'all' | number
  monthlySeries: { months: number[]; series: number[] } | null
  onClose: () => void
}) {
  const [loading,    setLoading]    = useState(false)
  const [invoices,   setInvoices]   = useState<any[]>([])
  const [error,      setError]      = useState<string | null>(null)
  const [pdfModal,   setPdfModal]   = useState<{ url: string; title: string } | null>(null)
  // Progress: months loaded so far (out of monthsToQuery.length). Lets
  // us show "Loaded 2 of 5 months" so a slow first-fetch doesn't look
  // like a frozen modal. First-load can take 60–120s per month; cached
  // for 5 min after, so subsequent opens are instant.
  const [loadedCount, setLoadedCount] = useState(0)

  // Months to query: respect monthFilter when set, else hit every month
  // in monthlySeries.months (the months we know have data — typically
  // the trailing 6). Each is a separate cached drilldown call.
  const monthsToQuery = useMemo(() => {
    if (monthFilter !== 'all') return [monthFilter]
    return monthlySeries?.months ?? []
  }, [monthFilter, monthlySeries])

  useEffect(() => {
    if (!bizId || monthsToQuery.length === 0) {
      setInvoices([])
      setLoadedCount(0)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setInvoices([])
    setLoadedCount(0)

    const targetKey   = sub.subcategory ?? sub.label ?? sub.key
    const targetKeyLc = String(targetKey ?? '').toLowerCase().trim()
    const labelLc     = String(sub.label ?? '').toLowerCase().trim()

    // Stream per-month — accumulate invoices as each response lands so
    // the modal shows what we have so far while the slower months are
    // still in flight. Otherwise a single slow month (60-120s on first
    // load) gates the entire modal under "Loading from Fortnox…".
    const acc: any[] = []
    let firstError: string | null = null

    // Per-fetch hard timeout via AbortController so a hung Vercel
    // function or browser-level stall can't leave the modal at "0 of 5
    // done" forever. 180s is generous given the function's own 300s cap
    // — if anything completes, it does so faster than this.
    const FETCH_TIMEOUT_MS = 180_000
    function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
      const ctrl = new AbortController()
      const id = setTimeout(() => ctrl.abort(), timeoutMs)
      return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(id))
    }

    console.log('[drilldown] starting', { bizId, year, months: monthsToQuery, sub: sub.key })

    const monthFetches = monthsToQuery.map(month => {
      const start = Date.now()
      console.log('[drilldown] fetch start', { month })
      return fetchWithTimeout('/api/integrations/fortnox/drilldown', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ business_id: bizId, year, month, category: 'other_cost' }),
        cache:   'no-store',
      }, FETCH_TIMEOUT_MS)
        .then(r => {
          console.log('[drilldown] fetch resp', { month, status: r.status, ms: Date.now() - start })
          return r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))
        })
        .then(resp => {
          if (cancelled) return
          for (const supplier of (resp?.suppliers ?? [])) {
            for (const inv of (supplier.invoices ?? [])) {
              // Match the subcategory by description / account-description
              // substring. tracker_line_items.subcategory is derived from
              // classify.ts; matching by description is the most reliable
              // client-side filter.
              const desc  = String(inv.description ?? '').toLowerCase()
              const accD  = String(inv.account_description ?? '').toLowerCase()
              const accNo = String(inv.account ?? '')
              if (
                desc.includes(targetKeyLc) ||
                desc.includes(labelLc) ||
                accD.includes(targetKeyLc) ||
                accD.includes(labelLc) ||
                accNo === targetKeyLc
              ) {
                acc.push({ ...inv, _supplier_name: supplier.supplier_name })
              }
            }
          }
          // Sort newest first; replace state with a fresh copy so the
          // modal repaints after each month lands.
          const sorted = [...acc].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
          setInvoices(sorted)
        })
        .catch(e => {
          // Capture only the first error so we don't spam the UI; later
          // months still get a chance.
          console.warn('[drilldown] fetch error', { month, message: e?.message ?? String(e), ms: Date.now() - start })
          if (!firstError) {
            firstError = e?.name === 'AbortError'
              ? `Timed out after ${Math.round(FETCH_TIMEOUT_MS / 1000)} s — Fortnox may be slow or the connection may be down.`
              : e?.message ?? String(e)
          }
        })
        .finally(() => {
          if (!cancelled) setLoadedCount(c => c + 1)
        })
    })

    Promise.allSettled(monthFetches).then(() => {
      if (cancelled) return
      // Always surface the first error if we hit one — even if SOME
      // months returned data we want the chef to know others didn't.
      if (firstError) setError(firstError)
      setLoading(false)
    })

    return () => { cancelled = true }
  }, [bizId, year, monthsToQuery.join(','), sub.key])

  const totalShown = invoices.reduce((s, i) => s + Number(i.amount ?? 0), 0)

  return (
    <div role="dialog" aria-label={`Invoices for ${sub.label}`} style={{
      position:   'fixed' as const,
      top:        0, right: 0, bottom: 0,
      width:      'min(460px, 100%)',
      background: UXP.cardBg,
      borderLeft: `0.5px solid ${UXP.border}`,
      boxShadow:  '-8px 0 24px rgba(58,53,80,0.08)',
      padding:    '18px 22px',
      overflow:   'auto' as const,
      zIndex:     50,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 4 }}>
            Subcategory
          </div>
          <div style={{ fontSize: 17, fontWeight: 500, color: UXP.ink1, textTransform: 'capitalize' as const }}>{sub.label}</div>
          <div style={{ fontSize: 11, color: UXP.ink4, marginTop: 4 }}>
            {monthFilter === 'all'
              ? `${monthsToQuery.length} month${monthsToQuery.length === 1 ? '' : 's'} · ${year}`
              : `${MONTHS[monthFilter - 1]} ${year}`}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: UXP.ink3, fontSize: 16 }}
        >×</button>
      </div>

      {/* Summary stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 14 }}>
        <DrawerStat label="Year total" value={fmtKr(sub.total_kr)} />
        <DrawerStat label="Shown" value={loading ? '…' : fmtKr(totalShown)} />
        <DrawerStat label="Invoices" value={loading ? '…' : String(invoices.length)} />
      </div>

      {/* Invoice list */}
      <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500, marginBottom: 6 }}>
        Invoices touching this subcategory
      </div>
      {loading && (
        <div style={{ padding: '12px 14px', background: UXP.subtleBg, border: `0.5px solid ${UXP.border}`,
                      borderRadius: 6, marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>
            Loading from Fortnox… <span style={{ color: UXP.ink4 }}>
              {monthsToQuery.length > 1
                ? `${loadedCount} of ${monthsToQuery.length} months done`
                : '(this can take 60–120s on first load)'}
            </span>
          </div>
          {/* Mini progress bar — fills as months land. */}
          {monthsToQuery.length > 1 && (
            <div style={{ marginTop: 6, height: 4, background: UXP.cardBg, borderRadius: 2, overflow: 'hidden' as const }}>
              <div style={{
                height: '100%',
                width: `${Math.round((loadedCount / monthsToQuery.length) * 100)}%`,
                background: UXP.lavDeep,
                transition: 'width 200ms ease',
              }} />
            </div>
          )}
          <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 6 }}>
            Cached 5 min after first load — subsequent opens are instant. Invoices appear as each month finishes.
          </div>
        </div>
      )}
      {error && !loading && (
        <div style={{ padding: '10px 12px', background: UXP.roseFill, border: `0.5px solid ${UXP.rose}`, borderRadius: 6, fontSize: 11, color: UXP.roseText, marginBottom: 10 }}>
          {error}
        </div>
      )}
      {!loading && !error && invoices.length === 0 && (
        <div style={{ fontSize: 11, color: UXP.ink4, padding: '14px 0' }}>
          No matching invoices for this subcategory in the queried month(s). Try selecting a different month from the filter above.
        </div>
      )}
      {!loading && invoices.length > 0 && (
        <div style={{ display: 'grid', gap: 0 }}>
          {invoices.slice(0, 30).map((inv, idx) => (
            <div key={`${inv.source_id}-${idx}`} style={{
              display:             'grid',
              gridTemplateColumns: '1fr auto auto',
              gap:                 12,
              padding:             '10px 0',
              borderBottom:        idx < Math.min(invoices.length, 30) - 1 ? `0.5px solid ${UXP.borderSoft}` : 'none',
              alignItems:          'center',
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, color: UXP.ink1, fontWeight: 500, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
                  {inv._supplier_name ?? 'Manual journal'}
                </div>
                <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 1, fontFamily: 'ui-monospace, monospace' }}>
                  #{inv.invoice_number} · {inv.date} · BAS {inv.account}
                </div>
              </div>
              <span style={{
                fontSize:           11,
                fontWeight:         500,
                color:              UXP.ink1,
                fontVariantNumeric: 'tabular-nums' as const,
                minWidth:           80,
                textAlign:          'right' as const,
              }}>
                {fmtKr(Number(inv.amount ?? 0))}
              </span>
              {bizId && inv.file_id ? (
                <button
                  type="button"
                  onClick={() => {
                    const url = `/api/integrations/fortnox/file?business_id=${encodeURIComponent(bizId)}&file_id=${encodeURIComponent(inv.file_id)}`
                    setPdfModal({ url, title: `${inv._supplier_name ?? 'Invoice'} — #${inv.invoice_number}` })
                  }}
                  style={{
                    padding:        '4px 10px',
                    background:     UXP.lavFill,
                    color:          UXP.lavText,
                    border:         'none',
                    borderRadius:   999,
                    fontSize:       10,
                    fontWeight:     500,
                    cursor:         'pointer',
                    fontFamily:     'inherit',
                  }}
                >PDF</button>
              ) : inv.fortnox_url ? (
                <a
                  href={inv.fortnox_url} target="_blank" rel="noopener noreferrer"
                  style={{
                    padding: '4px 10px', background: 'transparent',
                    color: UXP.ink3, border: `0.5px solid ${UXP.border}`,
                    borderRadius: 999, fontSize: 10, fontWeight: 500,
                    textDecoration: 'none', fontFamily: 'inherit',
                  }}
                >Fortnox ↗</a>
              ) : (
                <span style={{ color: UXP.ink4, fontSize: 10 }}>—</span>
              )}
            </div>
          ))}
          {invoices.length > 30 && (
            <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 8, textAlign: 'center' as const }}>
              {invoices.length - 30} more invoices not shown — filter by a single month to narrow.
            </div>
          )}
        </div>
      )}

      {pdfModal && (
        <OverheadPdfModal url={pdfModal.url} title={pdfModal.title} onClose={() => setPdfModal(null)} />
      )}
    </div>
  )
}

function DrawerStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: UXP.subtleBg, padding: '8px 10px', borderRadius: 8 }}>
      <div style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{label}</div>
      <div style={{
        fontSize:           13,
        fontWeight:         500,
        color:              UXP.ink1,
        marginTop:          2,
        fontVariantNumeric: 'tabular-nums' as const,
      }}>{value}</div>
    </div>
  )
}

// Inline PDF viewer — embedded iframe of /api/integrations/fortnox/file.
// Esc closes. Footer has 'Open in new tab' fallback for browsers that
// don't render PDFs in iframes (rare mobile Chrome).
function OverheadPdfModal({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div onClick={onClose}
      style={{
        position: 'fixed' as const, inset: 0, background: 'rgba(20,18,40,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 200, padding: 16,
      }}>
      <div onClick={e => e.stopPropagation()}
        style={{
          width: 'min(960px, 100%)', height: '90vh',
          background: '#fff', borderRadius: 8, overflow: 'hidden' as const,
          display: 'flex', flexDirection: 'column' as const,
          boxShadow: '0 20px 60px rgba(0,0,0,0.40)',
        }}>
        <div style={{
          padding: '10px 14px', borderBottom: `0.5px solid ${UXP.borderSoft}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
        }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
            {title}
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <a href={url} target="_blank" rel="noopener noreferrer"
              style={{
                padding: '5px 10px', fontSize: 11, fontWeight: 500,
                background: 'transparent', color: UXP.ink3,
                border: `0.5px solid ${UXP.border}`, borderRadius: 4,
                textDecoration: 'none', fontFamily: 'inherit',
              }}>Open in new tab ↗</a>
            <button onClick={onClose}
              style={{
                padding: '5px 12px', fontSize: 11, fontWeight: 600,
                background: UXP.ink1, color: '#fff',
                border: 'none', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
              }}>Close (Esc)</button>
          </div>
        </div>
        <iframe src={url} title="Invoice PDF"
          style={{ flex: 1, border: 'none', width: '100%', background: '#fff' }} />
      </div>
    </div>
  )
}

// ── Atoms ──────────────────────────────────────────────────────────
function cardStyle(): React.CSSProperties {
  return {
    background:    UXP.cardBg,
    border:        `0.5px solid ${UXP.border}`,
    borderRadius:  UXP.r_lg,
    padding:       '14px 16px',
  }
}

function EmptyCard({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       40,
      textAlign:     'center' as const,
    }}>
      <div style={{ fontSize: 14, fontWeight: 500, color: UXP.ink1, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 11, color: UXP.ink3, maxWidth: 480, margin: '0 auto', lineHeight: 1.5 }}>{body}</div>
    </div>
  )
}
