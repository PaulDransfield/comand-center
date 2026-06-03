'use client'
// @ts-nocheck
// app/revenue/page.tsx — full rebuild on the new system
//
// Same treatment as the dashboard + staff rebuilds: every surface is
// UXP + KpiCardUX / PairedBarChart / BreakdownTable. The legacy
// PageHero / SupportingStats / SegmentedToggle / TopBar / inline
// stacked-bar SVG are deleted; period nav lives in the AppShell
// toolbar's date stepper.
//
// Data:
//   /api/revenue-detail?from&to&business_id   — daily revenue + covers +
//                                                food/bev + dine-in/takeaway
//   /api/covers (POST)                         — manual cover-entry form

export const dynamic = 'force-dynamic'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import dynamicImport from 'next/dynamic'

const AskAI = dynamicImport(() => import('@/components/AskAI'), { ssr: false, loading: () => null })

import AppShell from '@/components/AppShell'
import { PageContainer } from '@/components/ui/Layout'
import KpiCardUX from '@/components/ux/KpiCard'
import PairedBarChart from '@/components/ux/PairedBarChart'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'

import { UXP } from '@/lib/constants/tokens'
import { fmtKr, fmtPct } from '@/lib/format'

// ── Period helpers ────────────────────────────────────────────────────
const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const DAYS   = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']

function getISOWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day  = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const y1   = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - y1.getTime()) / 86400000 + 1) / 7)
}
function getWeekBounds(offset = 0) {
  const today = new Date()
  const dow   = today.getDay()
  const mon   = new Date(today)
  mon.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1) + offset * 7)
  mon.setHours(0, 0, 0, 0)
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
  const wk    = getISOWeek(mon)
  const mMon  = MONTHS[mon.getMonth()]
  const sMon  = MONTHS[sun.getMonth()]
  const label = mMon === sMon
    ? `${mon.getDate()}–${sun.getDate()} ${mMon}`
    : `${mon.getDate()} ${mMon} – ${sun.getDate()} ${sMon}`
  return { from: localDate(mon), to: localDate(sun), weekNum: wk, label, mon }
}
function getMonthBounds(offset = 0) {
  const now  = new Date()
  const d    = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return {
    from:        localDate(d),
    to:          localDate(last),
    label:       `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
    firstDay:    d,
    daysInMonth: last.getDate(),
  }
}

// ── Page wrapper ──────────────────────────────────────────────────────
export default function RevenuePage() {
  return (
    <Suspense fallback={<div style={{ padding: 60, textAlign: 'center' as const, color: UXP.ink3 }}>Loading…</div>}>
      <RevenueInner />
    </Suspense>
  )
}

function RevenueInner() {
  const searchParams = useSearchParams()
  const [bizId,       setBizId]       = useState<string | null>(null)
  const [weekOffset,  setWeekOffset]  = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  // Default to month — week view early in the week is empty.
  const [viewMode,    setViewMode]    = useState<'week' | 'month'>('month')
  const [revData,     setRevData]     = useState<any>(null)
  const [prevRev,     setPrevRev]     = useState<any>(null)
  const [loading,     setLoading]     = useState(true)

  // Log-covers form state
  const [showForm,    setShowForm]    = useState(false)
  const [form,        setForm]        = useState<any>({ date: localDate(new Date()), total: '', revenue: '' })
  const [saving,      setSaving]      = useState(false)

  // URL hydration
  useEffect(() => {
    const v   = searchParams?.get('view')   as 'week' | 'month' | null
    const off = searchParams?.get('offset')
    if (v === 'week' || v === 'month') setViewMode(v)
    if (off != null && !Number.isNaN(Number(off))) {
      if (v === 'month') setMonthOffset(Number(off))
      else               setWeekOffset(Number(off))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function writeUrl(next: { view?: string; offset?: number }) {
    const p = new URLSearchParams()
    const v   = next.view   ?? viewMode
    const off = next.offset ?? (v === 'month' ? monthOffset : weekOffset)
    if (v !== 'month') p.set('view', v)
    if (off !== 0)    p.set('offset', String(off))
    const qs = p.toString()
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
  }

  // Business sync
  useEffect(() => {
    const sync = () => { const s = localStorage.getItem('cc_selected_biz'); if (s) setBizId(s) }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  // Data fetch
  useEffect(() => {
    if (!bizId) return
    setLoading(true)
    const biz  = `business_id=${bizId}`
    const curr = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
    const prev = viewMode === 'week' ? getWeekBounds(weekOffset - 1) : getMonthBounds(monthOffset - 1)

    Promise.all([
      fetch(`/api/revenue-detail?${biz}&from=${curr.from}&to=${curr.to}`).then(r => r.json()).catch(() => ({})),
      fetch(`/api/revenue-detail?${biz}&from=${prev.from}&to=${prev.to}`).then(r => r.json()).catch(() => ({})),
    ]).then(([cur, prv]) => {
      setRevData(cur)
      setPrevRev(prv)
      setLoading(false)
    })
  }, [bizId, weekOffset, monthOffset, viewMode])

  // Save covers (manual entry)
  async function saveCovers() {
    setSaving(true)
    await fetch('/api/covers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, business_id: bizId }),
    })
    setSaving(false)
    setShowForm(false)
    setForm({ date: localDate(new Date()), total: '', revenue: '' })
    // Trigger refetch
    if (viewMode === 'week') setWeekOffset(o => o)
    else                     setMonthOffset(o => o)
  }

  // Derived values
  const now      = new Date()
  const curr     = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
  const dayCount = viewMode === 'week' ? 7 : (curr as any).daysInMonth ?? 30

  const rows    = revData?.rows ?? []
  const sum     = revData?.summary ?? {}
  const prevSum = prevRev?.summary ?? {}

  const totalRev    = sum.total_revenue ?? 0
  const totalCovers = sum.total_covers ?? 0
  const avgRpc      = totalCovers > 0 ? totalRev / totalCovers : 0
  const totalTips   = sum.total_tips ?? 0
  const foodRev     = sum.total_food_revenue ?? 0
  const bevRev      = sum.total_bev_revenue ?? 0
  const dineIn      = sum.total_dine_in ?? 0
  const takeaway    = sum.total_takeaway ?? 0

  const prevTotalRev    = prevSum.total_revenue ?? 0
  const prevTotalCovers = prevSum.total_covers  ?? 0
  const prevAvgRpc      = prevTotalCovers > 0 ? prevTotalRev / prevTotalCovers : 0

  // Best / worst day by revenue
  const best = useMemo(() => {
    const real = rows.filter((r: any) => Number(r.revenue ?? 0) > 0)
    if (real.length === 0) return null
    return [...real].sort((a, b) => Number(b.revenue ?? 0) - Number(a.revenue ?? 0))[0]
  }, [rows])
  const worst = useMemo(() => {
    const real = rows.filter((r: any) => Number(r.revenue ?? 0) > 0)
    if (real.length < 2) return null
    return [...real].sort((a, b) => Number(a.revenue ?? 0) - Number(b.revenue ?? 0))[0]
  }, [rows])

  // Chart days
  const chartDays = useMemo(() => {
    return Array.from({ length: dayCount }, (_, i) => {
      const d = viewMode === 'week' ? new Date((curr as any).mon) : new Date((curr as any).firstDay)
      d.setDate(d.getDate() + i)
      const ds  = localDate(d)
      const row = rows.find((r: any) => r.date === ds)
      const dayIdx = (d.getDay() + 6) % 7
      return {
        date:    ds,
        dayName: viewMode === 'week' ? DAYS[dayIdx] : String(i + 1),
        revenue: row?.revenue ?? 0,
        covers:  row?.covers ?? 0,
        food:    row?.food_revenue ?? 0,
        bev:     row?.bev_revenue  ?? 0,
        dine_in: row?.dine_in_revenue  ?? 0,
        takeaway: row?.takeaway_revenue ?? 0,
        tips:    row?.tip_revenue ?? 0,
        isToday:  ds === localDate(now),
        isFuture: d > now,
      }
    })
  }, [viewMode, weekOffset, monthOffset, rows, dayCount])

  // Period stepper
  const periodLabel = viewMode === 'week'
    ? `Week ${(curr as any).weekNum} · ${curr.label}`
    : curr.label
  function step(dir: -1 | 1) {
    if (viewMode === 'week') {
      const next = weekOffset + dir; setWeekOffset(next); writeUrl({ view: 'week', offset: next })
    } else {
      const next = monthOffset + dir; setMonthOffset(next); writeUrl({ view: 'month', offset: next })
    }
  }
  const canStepNext = viewMode === 'week' ? weekOffset < 0 : monthOffset < 0

  return (
    <AppShell
      dateLabel={periodLabel}
      onPrev={() => step(-1)}
      onNext={canStepNext ? () => step(1) : undefined}
    >
      <PageContainer style={{ display: 'grid', gap: 14 }}>

        {/* Header row — W/M toggle + Log covers action */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
          <ViewModeToggle value={viewMode} onChange={v => {
            setViewMode(v)
            writeUrl({ view: v, offset: v === 'month' ? monthOffset : weekOffset })
          }} />
          <button
            type="button"
            onClick={() => setShowForm(s => !s)}
            style={{
              padding:      '5px 12px',
              background:   showForm ? UXP.lavFill : UXP.cardBg,
              color:        showForm ? UXP.lavText : UXP.ink1,
              border:       `0.5px solid ${UXP.border}`,
              borderRadius: 999,
              fontSize:     11,
              fontWeight:   500,
              fontFamily:   'inherit',
              cursor:       'pointer',
            }}
          >
            + Log covers
          </button>
        </div>

        {showForm && (
          <CoversForm
            form={form}
            saving={saving}
            onChange={setForm}
            onSave={saveCovers}
            onCancel={() => setShowForm(false)}
          />
        )}

        {/* ── KPI strip ───────────────────────────────────────────── */}
        <KpiStrip
          totalRev={totalRev}
          prevTotalRev={prevTotalRev}
          totalCovers={totalCovers}
          prevTotalCovers={prevTotalCovers}
          avgRpc={avgRpc}
          prevAvgRpc={prevAvgRpc}
          dineIn={dineIn}
          takeaway={takeaway}
          foodRev={foodRev}
          bevRev={bevRev}
          totalTips={totalTips}
          periodLabel={periodLabel}
        />

        {/* ── Best / worst day ───────────────────────────────────── */}
        {best && (
          <BestWorstStrip best={best} worst={worst} />
        )}

        {/* ── Revenue chart ──────────────────────────────────────── */}
        <ChartCard days={chartDays} loading={loading} />

        {/* ── Daily breakdown ────────────────────────────────────── */}
        <DailyBreakdown
          rows={rows}
          totalRev={totalRev}
          totalCovers={totalCovers}
          totalTips={totalTips}
          totalDineIn={dineIn}
          totalTakeaway={takeaway}
          totalFood={foodRev}
          totalBev={bevRev}
        />
      </PageContainer>

      <AskAI
        page="revenue"
        context={revData ? [
          `Period: ${periodLabel}`,
          `Revenue ${fmtKr(totalRev)}, covers ${totalCovers}, per cover ${fmtKr(Math.round(avgRpc))}.`,
          (dineIn > 0 || takeaway > 0) ? `Dine-in ${fmtKr(dineIn)}, takeaway ${fmtKr(takeaway)}.` : null,
          totalTips > 0 ? `Tips ${fmtKr(totalTips)}.` : null,
        ].filter(Boolean).join('\n') : 'No revenue data'}
      />
    </AppShell>
  )
}

// ════════════════════════════════════════════════════════════════════
// Sub-components
// ════════════════════════════════════════════════════════════════════

function KpiStrip({
  totalRev, prevTotalRev, totalCovers, prevTotalCovers, avgRpc, prevAvgRpc,
  dineIn, takeaway, foodRev, bevRev, totalTips, periodLabel,
}: any) {
  let channels: { label: string; value: number; share: number; color: string }[]
  if (dineIn > 0 || takeaway > 0) {
    channels = [
      { label: 'Dine-in',  value: dineIn,   share: 0, color: UXP.lav    },
      { label: 'Takeaway', value: takeaway, share: 0, color: UXP.lavMid },
    ].filter(c => c.value > 0)
  } else if (foodRev > 0 || bevRev > 0) {
    channels = [
      { label: 'Food',     value: foodRev, share: 0, color: UXP.lav    },
      { label: 'Beverage', value: bevRev,  share: 0, color: UXP.lavMid },
    ].filter(c => c.value > 0)
  } else {
    channels = [{ label: 'Total', value: totalRev || 1, share: 1, color: UXP.lav }]
  }

  const revDelta = prevTotalRev > 0
    ? `${totalRev - prevTotalRev >= 0 ? '+' : ''}${(((totalRev - prevTotalRev) / prevTotalRev) * 100).toFixed(1)}%`
    : null
  const coversDelta = prevTotalCovers > 0
    ? `${totalCovers - prevTotalCovers >= 0 ? '+' : ''}${(((totalCovers - prevTotalCovers) / prevTotalCovers) * 100).toFixed(1)}%`
    : null
  const rpcDelta = prevAvgRpc > 0
    ? `${avgRpc - prevAvgRpc >= 0 ? '+' : ''}${(((avgRpc - prevAvgRpc) / prevAvgRpc) * 100).toFixed(1)}%`
    : null

  const takeawayPct = (dineIn + takeaway) > 0 ? (takeaway / (dineIn + takeaway)) * 100 : null

  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap:                 12,
    }}>
      <KpiCardUX
        title="Revenue"
        value={totalRev > 0 ? fmtKr(totalRev) : '—'}
        delta={revDelta}
        deltaGood
        variant="channels"
        channels={channels}
        microLabel={periodLabel}
      />
      <KpiCardUX
        title="Covers"
        value={totalCovers > 0 ? totalCovers.toLocaleString('sv-SE') : '—'}
        delta={coversDelta}
        deltaGood
        microLabel={totalCovers > 0 ? `${totalCovers} guests served` : 'No cover data'}
      />
      <KpiCardUX
        title="Per cover"
        value={avgRpc > 0 ? fmtKr(Math.round(avgRpc)) : '—'}
        delta={rpcDelta}
        deltaGood
        microLabel={prevAvgRpc > 0 ? `was ${fmtKr(Math.round(prevAvgRpc))}` : ''}
      />
      <KpiCardUX
        title={takeawayPct != null ? 'Takeaway share' : 'Tips'}
        value={takeawayPct != null
          ? fmtPct(takeawayPct)
          : (totalTips > 0 ? fmtKr(totalTips) : '—')}
        microLabel={takeawayPct != null
          ? '6% VAT bucket'
          : (totalTips > 0 ? `${totalRev > 0 ? ((totalTips / totalRev) * 100).toFixed(1) : 0}% of revenue` : 'No tips logged')}
      />
    </div>
  )
}

// ── Best / worst day ─────────────────────────────────────────────────
function BestWorstStrip({ best, worst }: { best: any; worst: any }) {
  const cards: Array<{ kind: 'best' | 'worst'; row: any }> = [{ kind: 'best', row: best }]
  if (worst && worst !== best) cards.push({ kind: 'worst', row: worst })
  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: `repeat(${cards.length}, minmax(0, 1fr))`,
      gap:                 12,
    }}>
      {cards.map(({ kind, row }) => {
        const palette = kind === 'best'
          ? { bg: UXP.greenFill, fg: UXP.greenDeep, accent: UXP.green }
          : { bg: UXP.roseFill,  fg: UXP.roseText,  accent: UXP.rose  }
        const dateLabel = new Date(row.date).toLocaleDateString('en-GB', {
          weekday: 'short', day: 'numeric', month: 'short',
        })
        const rpc = (row.covers ?? 0) > 0 ? Number(row.revenue) / Number(row.covers) : null
        return (
          <div key={kind} style={{
            background:   UXP.cardBg,
            border:       `0.5px solid ${UXP.border}`,
            borderRadius: UXP.r_lg,
            padding:      '14px 16px',
            display:      'flex',
            alignItems:   'center',
            gap:          12,
          }}>
            <span style={{
              padding:       '4px 10px',
              background:    palette.bg,
              color:         palette.fg,
              borderRadius:  999,
              fontSize:      9,
              fontWeight:    600,
              letterSpacing: '0.04em',
              textTransform: 'uppercase' as const,
            }}>
              {kind === 'best' ? 'Top day' : 'Quietest'}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12, color: UXP.ink1, fontWeight: 500 }}>{dateLabel}</div>
              <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 1 }}>
                {row.covers > 0 ? `${row.covers} covers` : '—'}
                {rpc != null && <span> · {fmtKr(Math.round(rpc))} per cover</span>}
              </div>
            </div>
            <span style={{
              fontFamily:         'var(--font-display)',
              fontSize:           22,
              fontWeight:         500,
              color:              palette.accent,
              letterSpacing:      '-0.02em',
              fontVariantNumeric: 'tabular-nums' as const,
            }}>
              {fmtKr(Number(row.revenue ?? 0))}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Chart card ───────────────────────────────────────────────────────
function ChartCard({ days, loading }: { days: any[]; loading: boolean }) {
  return (
    <Card title="Daily revenue" subtitle="Bars · covers as a line overlay">
      {loading ? (
        <div style={{ padding: 60, textAlign: 'center' as const, color: UXP.ink3 }}>Loading…</div>
      ) : (
        <PairedBarChart
          groups={days.map(d => d.dayName)}
          series={[
            { label: 'Revenue', data: days.map(d => Number(d.revenue ?? 0)), color: UXP.lav },
          ]}
          lines={[{
            label:  'Covers',
            data:   days.map(d => d.covers > 0 ? Number(d.covers) : null),
            color:  UXP.coral,
            dashed: false,
          }]}
          width={typeof window !== 'undefined' ? Math.min(window.innerWidth - 120, 1200) : 1100}
          height={260}
        />
      )}
    </Card>
  )
}

// ── Daily breakdown ──────────────────────────────────────────────────
function DailyBreakdown({
  rows, totalRev, totalCovers, totalTips, totalDineIn, totalTakeaway, totalFood, totalBev,
}: any) {
  if (!rows || rows.length === 0) {
    return (
      <Card title="Daily breakdown" subtitle="No revenue rows in this period">
        <Empty>No data logged yet.</Empty>
      </Card>
    )
  }

  const sorted = [...rows].sort((a: any, b: any) => a.date.localeCompare(b.date))
  const showChannels = totalDineIn > 0 || totalTakeaway > 0
  const showFoodBev  = !showChannels && (totalFood > 0 || totalBev > 0)
  const showTips     = totalTips > 0

  const columns: any[] = [
    { key: 'date', header: 'Date', align: 'left', render: (r: any) => (
      <span>
        <span style={{ color: UXP.ink1, fontWeight: 500 }}>
          {new Date(r.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
        </span>
        {r.is_closed && (
          <span style={{ display: 'block', fontSize: 9, color: UXP.ink4, marginTop: 1 }}>Closed</span>
        )}
      </span>
    ) },
    { key: 'revenue', header: 'Revenue', align: 'right', render: (r: any) => fmtKr(Number(r.revenue ?? 0)) },
    { key: 'covers',  header: 'Covers',  align: 'right', render: (r: any) => (r.covers ?? 0) > 0 ? r.covers : <span style={{ color: UXP.ink4 }}>—</span> },
    { key: 'rpc',     header: 'Per cover', align: 'right', render: (r: any) => {
      const rev = Number(r.revenue ?? 0); const cov = Number(r.covers ?? 0)
      return cov > 0 ? fmtKr(Math.round(rev / cov)) : <span style={{ color: UXP.ink4 }}>—</span>
    } },
  ]
  if (showChannels) {
    columns.push(
      { key: 'dine',    header: 'Dine-in',  align: 'right', render: (r: any) =>
        (r.dine_in_revenue ?? 0) > 0 ? fmtKr(r.dine_in_revenue) : <span style={{ color: UXP.ink4 }}>—</span> },
      { key: 'takeaway', header: 'Takeaway', align: 'right', render: (r: any) =>
        (r.takeaway_revenue ?? 0) > 0 ? fmtKr(r.takeaway_revenue) : <span style={{ color: UXP.ink4 }}>—</span> },
    )
  } else if (showFoodBev) {
    columns.push(
      { key: 'food', header: 'Food',     align: 'right', render: (r: any) =>
        (r.food_revenue ?? 0) > 0 ? fmtKr(r.food_revenue) : <span style={{ color: UXP.ink4 }}>—</span> },
      { key: 'bev',  header: 'Beverage', align: 'right', render: (r: any) =>
        (r.bev_revenue ?? 0)  > 0 ? fmtKr(r.bev_revenue)  : <span style={{ color: UXP.ink4 }}>—</span> },
    )
  }
  if (showTips) {
    columns.push({ key: 'tips', header: 'Tips', align: 'right', render: (r: any) =>
      (r.tip_revenue ?? 0) > 0 ? fmtKr(r.tip_revenue) : <span style={{ color: UXP.ink4 }}>—</span> })
  }
  columns.push({ key: 'share', header: '% of period', align: 'right', render: (r: any) => {
    const rev = Number(r.revenue ?? 0)
    const pct = totalRev > 0 ? (rev / totalRev) * 100 : 0
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
        <span style={{
          display: 'inline-block', width: 60, height: 3, background: UXP.lavFill,
          borderRadius: 2, overflow: 'hidden',
        }}>
          <span style={{ display: 'block', height: '100%', width: `${Math.min(100, pct)}%`, background: UXP.lav }} />
        </span>
        <span style={{ fontSize: 10, color: UXP.ink2, fontVariantNumeric: 'tabular-nums' as const, minWidth: 30, textAlign: 'right' as const }}>
          {pct.toFixed(1)}%
        </span>
      </span>
    )
  } })

  const footer: any = {
    revenue: fmtKr(totalRev),
    covers:  totalCovers > 0 ? totalCovers.toLocaleString('sv-SE') : '—',
    rpc:     totalCovers > 0 ? fmtKr(Math.round(totalRev / totalCovers)) : '—',
    share:   '100%',
  }
  if (showChannels) {
    footer.dine     = fmtKr(totalDineIn)
    footer.takeaway = fmtKr(totalTakeaway)
  } else if (showFoodBev) {
    footer.food = fmtKr(totalFood)
    footer.bev  = fmtKr(totalBev)
  }
  if (showTips) footer.tips = fmtKr(totalTips)

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Daily breakdown</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          {sorted.length} {sorted.length === 1 ? 'day' : 'days'} with data
        </div>
      </div>
      <BreakdownTable
        columns={columns}
        sections={[{ rows: sorted }]}
        footer={{ label: 'Total', cells: footer }}
        rowKey={(row: any) => row.date}
      />
    </div>
  )
}

// ── Manual covers form ───────────────────────────────────────────────
function CoversForm({ form, saving, onChange, onSave, onCancel }: any) {
  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       '12px 16px',
    }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' as const }}>
        <FormField label="Date">
          <input type="date"
                 value={form.date}
                 onChange={e => onChange({ ...form, date: e.target.value })}
                 style={formInput} />
        </FormField>
        <FormField label="Covers">
          <input type="number"
                 value={form.total}
                 onChange={e => onChange({ ...form, total: e.target.value })}
                 placeholder="0"
                 style={{ ...formInput, width: 90 }} />
        </FormField>
        <FormField label="Revenue (kr)">
          <input type="number"
                 value={form.revenue}
                 onChange={e => onChange({ ...form, revenue: e.target.value })}
                 placeholder="0"
                 style={{ ...formInput, width: 120 }} />
        </FormField>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          style={{
            padding:      '6px 14px',
            background:   UXP.lavDeep,
            color:        '#fff',
            border:       'none',
            borderRadius: 999,
            fontSize:     11,
            fontWeight:   500,
            cursor:       saving ? 'not-allowed' : 'pointer',
            opacity:      saving ? 0.6 : 1,
            fontFamily:   'inherit',
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding:      '6px 12px',
            background:   'transparent',
            color:        UXP.ink3,
            border:       'none',
            borderRadius: 999,
            fontSize:     11,
            cursor:       'pointer',
            fontFamily:   'inherit',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 3 }}>
      <span style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{label}</span>
      {children}
    </label>
  )
}

const formInput: React.CSSProperties = {
  padding:      '6px 10px',
  background:   UXP.cardBg,
  color:        UXP.ink1,
  border:       `0.5px solid ${UXP.border}`,
  borderRadius: 7,
  fontSize:     11,
  fontFamily:   'inherit',
}

// ── Shared primitives ────────────────────────────────────────────────
function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       '14px 16px',
    }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{subtitle}</div>}
      </div>
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: UXP.ink4, padding: '8px 0' }}>{children}</div>
}

function ViewModeToggle({ value, onChange }: { value: 'week' | 'month'; onChange: (v: 'week' | 'month') => void }) {
  return (
    <div style={{
      display:      'inline-flex',
      gap:          2,
      background:   UXP.cardBg,
      border:       `0.5px solid ${UXP.border}`,
      borderRadius: 7,
      padding:      2,
    }}>
      {(['week', 'month'] as const).map(v => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          style={{
            padding:       '4px 12px',
            background:    value === v ? UXP.lavFill : 'transparent',
            color:         value === v ? UXP.lavText : UXP.ink3,
            border:        'none',
            borderRadius:  5,
            fontSize:      10,
            fontWeight:    500,
            fontFamily:    'inherit',
            cursor:        'pointer',
            letterSpacing: '0.04em',
            textTransform: 'uppercase' as const,
          }}
        >
          {v === 'week' ? 'W' : 'M'}
        </button>
      ))}
    </div>
  )
}
