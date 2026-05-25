'use client'
// @ts-nocheck
// app/dashboard/page.tsx — CommandCenter dashboard, full rebuild
//
// Phase 8 (the rebuild commit) — every surface on this page is built
// from `components/ux/*` and `UXP` tokens. The legacy dashboard helpers
// (DemandOutlook, OverheadReviewCard, WhyThisWeekCard, WeekScorecardCard,
// WhatHappenedCard, ReviewThemesCard, CashPositionTile,
// CashFlowProjectionTile, DashboardHeader, WeatherDemandWidget) are
// deleted; only OverviewChart survives in-tree because /departments/[id]
// still drill-downs through it.
//
// Data sources (all unchanged from the previous revision):
//   /api/businesses                      — biz list / picker
//   /api/metrics/daily (curr + prev)     — revenue + labour + covers
//   /api/departments                     — per-dept rollup
//   /api/alerts                          — anomaly badges
//   /api/scheduling/ai-suggestion        — AI labour cuts + per-day forecast
//   /api/overheads/projection            — review queue + savings
//   /api/weather/demand-forecast         — 7-day demand outlook
//   /api/finance/bank-position           — cash position
//   /api/finance/cash-flow-projection    — 12-week cash projection
//   /api/integrations/fortnox/recent-inv — recent supplier invoices
//   /api/reviews/themes                  — review themes
//
// Visual contract:
//   - background: UXP.pageBg, all cards UXP.cardBg + 0.5px UXP.border
//   - typography: Spline Sans body / Fraunces display (root layout)
//   - numbers: fontVariantNumeric: 'tabular-nums', letterSpacing -0.02em
//   - hairlines: 0.5px, never 1px
//   - colour decisions: labourTier() (never inline thresholds)

export const dynamic = 'force-dynamic'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useLocale } from 'next-intl'
import { useRouter, useSearchParams } from 'next/navigation'
import dynamicImport from 'next/dynamic'

const AskAI = dynamicImport(() => import('@/components/AskAI'), { ssr: false, loading: () => null })

import AppShell from '@/components/AppShell'
import KpiCardUX from '@/components/ux/KpiCard'
import PairedBarChart from '@/components/ux/PairedBarChart'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'

import { UXP } from '@/lib/constants/tokens'
import { fmtKr, fmtPct } from '@/lib/format'
import { labourTier, DEFAULT_TIER_CONFIG } from '@/lib/utils/labourTier'
import { getHolidaysForCountry } from '@/lib/holidays'

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
  const sun = new Date(mon)
  sun.setDate(mon.getDate() + 6)
  const wk    = getISOWeek(mon)
  const mStr  = localDate(mon)
  const sStr  = localDate(sun)
  const mMon  = MONTHS[mon.getMonth()]
  const sMon  = MONTHS[sun.getMonth()]
  const label = mMon === sMon
    ? `${mon.getDate()}–${sun.getDate()} ${mMon}`
    : `${mon.getDate()} ${mMon} – ${sun.getDate()} ${sMon}`
  return { from: mStr, to: sStr, weekNum: wk, year: mon.getFullYear(), label, mon }
}

function getMonthBounds(offset = 0) {
  const now  = new Date()
  const d    = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return {
    from:        localDate(d),
    to:          localDate(last),
    label:       `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
    year:        d.getFullYear(),
    month:       d.getMonth() + 1,
    firstDay:    d,
    daysInMonth: last.getDate(),
  }
}

// ── Weather emoji map ─────────────────────────────────────────────────
function weatherIcon(code?: number): string {
  if (code == null) return ''
  if (code === 0)              return '☀️'
  if (code <= 3)               return '⛅'
  if (code === 45 || code === 48) return '🌫️'
  if (code >= 51 && code <= 57)   return '🌦️'
  if (code >= 61 && code <= 67)   return '🌧️'
  if (code >= 71 && code <= 77)   return '❄️'
  if (code >= 80 && code <= 82)   return '🌦️'
  if (code >= 85 && code <= 86)   return '🌨️'
  if (code >= 95)                 return '⛈️'
  return ''
}

// ── Suspense wrapper ──────────────────────────────────────────────────
export default function DashboardPage() {
  return (
    <Suspense fallback={<div style={{ padding: 60, textAlign: 'center' as const, color: UXP.ink3 }}>Loading…</div>}>
      <DashboardInner />
    </Suspense>
  )
}

// ── Main ──────────────────────────────────────────────────────────────
function DashboardInner() {
  const router       = useRouter()
  const searchParams = useSearchParams()

  // ── State ────────────────────────────────────────────────────────
  const [businesses,    setBusinesses]    = useState<any[]>([])
  const [bizId,         setBizId]         = useState<string | null>(null)
  const [dataAsOf,      setDataAsOf]      = useState<string | null>(null)
  const [weekOffset,    setWeekOffset]    = useState(0)
  const [monthOffset,   setMonthOffset]   = useState(0)
  const [viewMode,      setViewMode]      = useState<'week' | 'month'>('week')
  const [dailyRows,     setDailyRows]     = useState<any[]>([])
  const [prevDailyRows, setPrevDailyRows] = useState<any[]>([])
  const [currSummary,   setCurrSummary]   = useState<any>(null)
  const [prevSummary,   setPrevSummary]   = useState<any>(null)
  const [depts,         setDepts]         = useState<any>(null)
  const [alerts,        setAlerts]        = useState<any[]>([])
  const [aiSched,       setAiSched]       = useState<any>(null)
  const [overheadProj,  setOverheadProj]  = useState<any>(null)
  const [demand,        setDemand]        = useState<any>(null)
  const [bankPos,       setBankPos]       = useState<any>(null)
  const [cashFlow,      setCashFlow]      = useState<any>(null)
  const [recentInv,     setRecentInv]     = useState<any>(null)
  const [reviewThemes,  setReviewThemes]  = useState<any>(null)
  const [loading,       setLoading]       = useState(true)
  const [showUpgrade,   setShowUpgrade]   = useState(false)
  const [upgradePlan,   setUpgradePlan]   = useState('')

  // ── URL → state hydration ────────────────────────────────────────
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
    if (v !== 'week') p.set('view', v)
    if (off !== 0)    p.set('offset', String(off))
    const qs = p.toString()
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
  }

  // ── Stripe-redirect upgrade banner ───────────────────────────────
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    if (p.get('upgrade') === 'success') {
      setUpgradePlan(p.get('plan') ?? '')
      setShowUpgrade(true)
      setTimeout(() => setShowUpgrade(false), 8000)
    }
  }, [])

  // ── Business list + selection ─────────────────────────────────────
  useEffect(() => {
    fetch('/api/businesses').then(r => r.json()).then((data: any[]) => {
      if (!Array.isArray(data) || !data.length) return
      setBusinesses(data)
      const saved = localStorage.getItem('cc_selected_biz')
      const biz   = (saved && data.find(b => b.id === saved)) ? saved : data[0].id
      setBizId(biz)
      localStorage.setItem('cc_selected_biz', biz)
    }).catch(() => {})
    function onStorage() {
      const s = localStorage.getItem('cc_selected_biz')
      if (s) setBizId(s)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // ── Period-bound fetches ─────────────────────────────────────────
  useEffect(() => {
    if (!bizId) return
    setLoading(true)
    setDailyRows([]); setCurrSummary(null); setPrevSummary(null); setDepts(null)

    const biz  = `business_id=${bizId}`
    const curr = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
    const prev = viewMode === 'week' ? getWeekBounds(weekOffset - 1) : getMonthBounds(monthOffset - 1)

    Promise.all([
      fetch(`/api/metrics/daily?from=${curr.from}&to=${curr.to}&${biz}`).then(r => r.json()).catch(() => ({})),
      fetch(`/api/metrics/daily?from=${prev.from}&to=${prev.to}&${biz}`).then(r => r.json()).catch(() => ({})),
      fetch(`/api/departments?from=${curr.from}&to=${curr.to}&${biz}`).then(r => r.json()).catch(() => ({})),
      fetch('/api/alerts').then(r => r.json()).catch(() => []),
    ]).then(([currRes, prevRes, deptRes, alertRes]) => {
      const rows = (currRes.rows ?? []).map((r: any) => ({ ...r, staff_pct: r.labour_pct }))
      setDailyRows(rows)
      setCurrSummary(currRes.summary ?? null)
      setPrevSummary(prevRes.summary ?? null)
      setPrevDailyRows(prevRes.rows ?? [])
      setDepts(deptRes ?? null)
      setAlerts(Array.isArray(alertRes) ? alertRes : [])
      setLoading(false)
      const latest = rows.reduce((m: string, r: any) => r.date > m ? r.date : m, '')
      setDataAsOf(latest || null)
    })
  }, [bizId, weekOffset, monthOffset, viewMode])

  // ── Independent fetches ───────────────────────────────────────────
  useEffect(() => {
    if (!bizId) return
    let cancelled = false
    const today = localDate(new Date())
    const period = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
    if (period.to >= today) {
      fetch(`/api/scheduling/ai-suggestion?business_id=${bizId}&from=${period.from}&to=${period.to}`, { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then(j => { if (!cancelled && j && !j.error) setAiSched(j) })
        .catch(() => {})
    } else {
      setAiSched(null)
    }
    return () => { cancelled = true }
  }, [bizId, viewMode, weekOffset, monthOffset])

  useEffect(() => {
    if (!bizId) return
    let cancelled = false
    Promise.all([
      fetch(`/api/overheads/projection?business_id=${bizId}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/weather/demand-forecast?business_id=${bizId}&days=7`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/finance/bank-position?business_id=${bizId}&months=12`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/finance/cash-flow-projection?business_id=${bizId}&days=30`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/integrations/fortnox/recent-invoices?business_id=${bizId}&days=14`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/reviews/themes?business_id=${bizId}&window=90`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([ov, dm, bp, cf, ri, rt]) => {
      if (cancelled) return
      setOverheadProj(ov && !ov.error ? ov : null)
      setDemand(dm && !dm.error ? dm : null)
      setBankPos(bp && !bp.error ? bp : null)
      setCashFlow(cf && !cf.error ? cf : null)
      setRecentInv(ri && !ri.error ? ri : null)
      setReviewThemes(rt && !rt.error ? rt : null)
    })
    return () => { cancelled = true }
  }, [bizId])

  // ── Derived numbers ──────────────────────────────────────────────
  const now      = new Date()
  const curr     = getWeekBounds(weekOffset)
  const currM    = getMonthBounds(monthOffset)
  const period   = viewMode === 'week' ? curr : currM
  const dayCount = viewMode === 'week' ? 7 : currM.daysInMonth

  const totalRev    = dailyRows.reduce((s, r) => s + r.revenue,    0)
  const totalLabour = dailyRows.reduce((s, r) => s + r.staff_cost, 0)
  const labourPct   = totalRev > 0 ? (totalLabour / totalRev) * 100 : 0
  const totalHours  = depts?.summary?.total_hours ?? 0
  const totalCovers = Number(currSummary?.total_covers ?? 0)

  const prevRev    = prevSummary?.total_revenue    ?? 0
  const prevLabour = prevSummary?.total_staff_cost ?? 0
  const prevLabPct = prevRev > 0 && prevLabour > 0 ? (prevLabour / prevRev) * 100 : null
  const prevCovers = Number(prevSummary?.total_covers ?? 0)

  // Period-stepper wiring for the AppShell toolbar
  const periodLabel = viewMode === 'week'
    ? `Week ${curr.weekNum} · ${curr.label}`
    : currM.label
  function step(dir: -1 | 1) {
    if (viewMode === 'week') {
      const next = weekOffset + dir
      setWeekOffset(next)
      writeUrl({ view: 'week', offset: next })
    } else {
      const next = monthOffset + dir
      setMonthOffset(next)
      writeUrl({ view: 'month', offset: next })
    }
  }
  const canStepNext = viewMode === 'week' ? weekOffset < 0 : monthOffset < 0

  // Day grid for chart
  const predByDate: Record<string, any> = {}
  if (aiSched?.suggested) {
    for (const s of aiSched.suggested) {
      predByDate[s.date] = s
    }
  }
  const days = useMemo(() => {
    if (viewMode === 'week') {
      return Array.from({ length: 7 }, (_, i) => {
        const d = new Date(curr.mon); d.setDate(curr.mon.getDate() + i)
        const ds  = localDate(d)
        const row = dailyRows.find(r => r.date === ds)
        return {
          date:     ds,
          dayName:  DAYS[i],
          revenue:  row?.revenue    ?? 0,
          staff_cost: row?.staff_cost ?? 0,
          isToday:  ds === localDate(now),
          isFuture: d > now,
          pred:     predByDate[ds] ?? null,
        }
      })
    }
    return Array.from({ length: currM.daysInMonth }, (_, i) => {
      const d = new Date(currM.firstDay); d.setDate(i + 1)
      const ds  = localDate(d)
      const row = dailyRows.find(r => r.date === ds)
      return {
        date:     ds,
        dayName:  String(i + 1),
        revenue:  row?.revenue    ?? 0,
        staff_cost: row?.staff_cost ?? 0,
        isToday:  ds === localDate(now),
        isFuture: d > now,
        pred:     predByDate[ds] ?? null,
      }
    })
  }, [viewMode, weekOffset, monthOffset, dailyRows, aiSched])

  const selectedBiz = businesses.find(b => b.id === bizId)

  // ── Attention items — derived from aiSched + overheadProj + alerts + setup health
  const attentionItems = useMemo(() => buildAttentionItems({
    aiSched, overheadProj, alerts, dailyRows, totalRev, totalLabour, labourPct, dayCount,
    setupHealth: selectedBiz?.setup_health_summary ?? null,
    selectedBizId: bizId,
  }), [aiSched, overheadProj, alerts, dailyRows, totalRev, totalLabour, labourPct, dayCount, selectedBiz, bizId])

  // ── Render ───────────────────────────────────────────────────────
  return (
    <AppShell
      dateLabel={periodLabel}
      onPrev={() => step(-1)}
      onNext={canStepNext ? () => step(1) : undefined}
    >
      <div style={{ display: 'grid', gap: 14, maxWidth: 1280 }}>

        {showUpgrade && (
          <UpgradeBanner plan={upgradePlan} onClose={() => setShowUpgrade(false)} />
        )}

        <StaleDataBanner dataAsOf={dataAsOf} loading={loading} viewMode={viewMode} weekOffset={weekOffset} monthOffset={monthOffset} />

        {/* W/M toggle — sits at top right of the page, separate from the
            toolbar's date stepper. The pastel pills mirror the toolbar style. */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <ViewModeToggle value={viewMode} onChange={v => {
            setViewMode(v)
            writeUrl({ view: v, offset: v === 'month' ? monthOffset : weekOffset })
          }} />
        </div>

        {/* ── KPI strip ─────────────────────────────────────────── */}
        <KpiStrip
          totalRev={totalRev}
          prevRev={prevRev}
          totalLabour={totalLabour}
          labourPct={labourPct}
          prevLabPct={prevLabPct}
          totalCovers={totalCovers}
          prevCovers={prevCovers}
          depts={depts?.departments ?? []}
          periodLabel={periodLabel}
        />

        {/* ── Demand outlook (next 7 days) ──────────────────────── */}
        {demand?.days?.length > 0 && (
          <DemandOutlookStrip demand={demand} />
        )}

        {/* ── Performance chart ─────────────────────────────────── */}
        <ChartCard days={days} loading={loading} />

        {/* ── Attention panel ───────────────────────────────────── */}
        {attentionItems.length > 0 && (
          <AttentionCard items={attentionItems} />
        )}

        {/* ── Money flow row ────────────────────────────────────── */}
        <MoneyFlowRow bankPos={bankPos} cashFlow={cashFlow} recentInv={recentInv} bizId={bizId} />

        {/* ── Review themes ─────────────────────────────────────── */}
        {reviewThemes?.top_themes?.length > 0 && (
          <ReviewThemesCard themes={reviewThemes} />
        )}
      </div>

      <AskAI
        page="dashboard"
        context={selectedBiz ? [
          `Period: ${periodLabel}`,
          `Business: ${selectedBiz.name}`,
          `Revenue ${fmtKr(totalRev)}, labour ${fmtKr(totalLabour)} (${fmtPct(labourPct)}), covers ${totalCovers}.`,
        ].join('\n') : 'No business selected'}
      />
    </AppShell>
  )
}

// ════════════════════════════════════════════════════════════════════
// Sub-components — all UXP, all 0.5px hairlines, all tabular-nums
// ════════════════════════════════════════════════════════════════════

// ── KPI strip ────────────────────────────────────────────────────────
function KpiStrip({
  totalRev, prevRev, totalLabour, labourPct, prevLabPct, totalCovers, prevCovers, depts, periodLabel,
}: any) {
  const channels = (depts && depts.length > 0
    ? [...depts]
        .sort((a: any, b: any) => Number(b.revenue ?? 0) - Number(a.revenue ?? 0))
        .slice(0, 3)
        .map((d: any, i: number) => ({
          label: d.name ?? `Dept ${i + 1}`,
          value: Number(d.revenue ?? 0),
          share: 0,
          color: [UXP.lav, UXP.lavMid, UXP.lavPale][i] ?? UXP.lav,
        }))
    : [{ label: 'Total', value: totalRev, share: 1, color: UXP.lav }]
  )

  const grossMargin = totalRev > 0 ? ((totalRev - totalLabour) / totalRev) * 100 : 0
  const TARGET_MARGIN = 12

  const tier = labourTier(totalRev > 0 ? labourPct : null)
  const tierLabel = tier === 'no-data' ? 'No data' : tier.replace('-', ' ')

  const revDeltaPct = prevRev > 0 ? ((totalRev - prevRev) / prevRev) * 100 : null
  const revDelta = revDeltaPct != null ? `${revDeltaPct >= 0 ? '+' : ''}${revDeltaPct.toFixed(1)}%` : null

  const labDelta = prevLabPct != null
    ? `${labourPct - prevLabPct >= 0 ? '+' : ''}${(labourPct - prevLabPct).toFixed(1)}pp`
    : null

  const coversDelta = prevCovers > 0
    ? `${totalCovers - prevCovers >= 0 ? '+' : ''}${(((totalCovers - prevCovers) / prevCovers) * 100).toFixed(1)}%`
    : null

  // gross margin = revenue − labour, so prev margin ≈ 100 − prevLabPct.
  // Comparing the two pp values gives a clean "+1.2pp / −0.4pp" delta.
  const marginDelta = prevLabPct != null && totalRev > 0
    ? (() => {
        const prevMarginPct = 100 - prevLabPct
        const diff = grossMargin - prevMarginPct
        return `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}pp`
      })()
    : null

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
        title="Margin"
        value={totalRev > 0 ? fmtPct(grossMargin) : '—'}
        delta={marginDelta}
        deltaGood
        variant="stacked"
        stackedBars={[
          { label: 'Current', value: grossMargin,   max: 100, color: UXP.lav   },
          { label: 'Target',  value: TARGET_MARGIN, max: 100, color: UXP.green },
        ]}
      />
      <KpiCardUX
        title="Labour"
        value={totalRev > 0 ? fmtPct(labourPct) : '—'}
        delta={labDelta}
        deltaGood={false}
        variant="targetBand"
        targetBand={{
          actualPct:    Math.min(100, labourPct),
          targetMinPct: DEFAULT_TIER_CONFIG.targetMin,
          targetMaxPct: DEFAULT_TIER_CONFIG.targetMax,
        }}
        microLabel={tierLabel}
      />
      <KpiCardUX
        title="Covers"
        value={totalCovers > 0 ? totalCovers.toLocaleString('sv-SE') : '—'}
        delta={coversDelta}
        deltaGood
        microLabel={totalCovers > 0 && totalRev > 0 ? `${fmtKr(Math.round(totalRev / totalCovers))} per cover` : ''}
      />
    </div>
  )
}

// ── Demand outlook (horizontal strip) ────────────────────────────────
function DemandOutlookStrip({ demand }: { demand: any }) {
  const days = demand.days as any[]
  return (
    <Card title="Demand outlook" subtitle={`Next ${days.length} days — weather × revenue correlation`}>
      <div style={{
        display:             'grid',
        gridTemplateColumns: `repeat(${Math.min(days.length, 7)}, minmax(120px, 1fr))`,
        gap:                 8,
      }}>
        {days.slice(0, 7).map((d: any) => {
          const isHoliday = d.is_holiday
          const tone: 'good' | 'bad' | 'warning' | 'neutral' =
            d.delta_pct == null              ? 'neutral'
            : d.delta_pct >=  10             ? 'good'
            : d.delta_pct <= -10             ? 'bad'
            :                                  'warning'
          const tonePalette = {
            good:    { bg: UXP.greenFill, fg: UXP.greenDeep },
            bad:     { bg: UXP.roseFill,  fg: UXP.roseText  },
            warning: { bg: UXP.lavFill,   fg: UXP.lavText   },
            neutral: { bg: UXP.subtleBg,  fg: UXP.ink3      },
          }[tone]
          return (
            <div
              key={d.date}
              style={{
                background:   UXP.cardBg,
                border:       `0.5px solid ${isHoliday ? UXP.coral : UXP.border}`,
                borderRadius: UXP.r_md,
                padding:      '10px 12px',
                display:      'flex',
                flexDirection: 'column' as const,
                gap:          4,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500, letterSpacing: '0.02em' }}>
                  {d.weekday}
                </span>
                <span style={{ fontSize: 14 }} aria-hidden>{weatherIcon(d.weather?.code)}</span>
              </div>
              <div style={{
                fontSize:           17,
                fontWeight:         500,
                color:              UXP.ink1,
                fontFamily:         'var(--font-display)',
                fontVariantNumeric: 'tabular-nums' as const,
                letterSpacing:      '-0.02em',
                lineHeight:         1.1,
              }}>
                {fmtKr(d.predicted_revenue ?? 0)}
              </div>
              {d.delta_pct != null && (
                <span style={{
                  display:        'inline-block',
                  fontSize:       9,
                  padding:        '2px 6px',
                  borderRadius:   6,
                  background:     tonePalette.bg,
                  color:          tonePalette.fg,
                  alignSelf:      'flex-start' as const,
                  fontVariantNumeric: 'tabular-nums' as const,
                }}>
                  {d.delta_pct >= 0 ? '+' : ''}{Math.round(d.delta_pct)}% vs baseline
                </span>
              )}
              {isHoliday && d.holiday_name && (
                <span style={{ fontSize: 9, color: UXP.coral, fontWeight: 500 }}>
                  {d.holiday_name}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ── Chart card ───────────────────────────────────────────────────────
function ChartCard({ days, loading }: { days: any[]; loading: boolean }) {
  // Colour scheme:
  //   - Revenue:        UXP.lav     (light lavender)
  //   - Labour (closed days): UXP.lavDeep (darker lavender — clear contrast vs revenue)
  //   - Labour (today): pastel peach (scheduled, not final)
  const LAB_TODAY_FILL   = '#f4c39a'
  const LAB_TODAY_STROKE = '#d68b58'
  const labourColors = days.map(d => d.isToday && Number(d.staff_cost ?? 0) > 0 ? LAB_TODAY_FILL   : null)
  const labourStroke = days.map(d => d.isToday && Number(d.staff_cost ?? 0) > 0 ? LAB_TODAY_STROKE : null)
  return (
    <Card title="Revenue & labour" subtitle="Daily bars · labour as % of revenue · today in peach (scheduled, not final)">
      {loading ? (
        <div style={{ padding: 60, textAlign: 'center' as const, color: UXP.ink3 }}>Loading…</div>
      ) : (
        <PairedBarChart
          groups={days.map(d => d.dayName)}
          series={[
            { label: 'Revenue', data: days.map(d => Number(d.revenue ?? 0)),    color: UXP.lav },
            {
              label: 'Labour',
              data: days.map(d => Number(d.staff_cost ?? 0)),
              color: UXP.lavDeep,
              colorOverrides:  labourColors,
              strokeOverrides: labourStroke,
            },
          ]}
          lines={[{
            label:  'Labour %',
            data:   days.map(d => {
              const r = Number(d.revenue ?? 0)
              return r > 0 ? (Number(d.staff_cost ?? 0) / r) * 100 : null
            }),
            color:  UXP.coral,
            dashed: false,
          }]}
          rightMax={100}
          width={typeof window !== 'undefined' ? Math.min(window.innerWidth - 120, 1200) : 1100}
          height={260}
        />
      )}
    </Card>
  )
}

// ── Attention items ──────────────────────────────────────────────────
interface AttentionItem {
  id:       string
  tone:     'good' | 'warning' | 'bad'
  title:    string
  detail:   string
  cta?:     { label: string; href: string }
}

function buildAttentionItems({
  aiSched, overheadProj, alerts, dailyRows, totalRev, totalLabour, labourPct, dayCount,
  setupHealth, selectedBizId,
}: any): AttentionItem[] {
  const items: AttentionItem[] = []

  // Setup health — surface first when not green. Owner sees data-quality
  // issues before treating dashboard numbers as fact.
  if (setupHealth && setupHealth.overall && setupHealth.overall !== 'ok') {
    const counts = setupHealth.counts ?? {}
    const failCount = (counts.fail ?? 0)
    const warnCount = (counts.warn ?? 0)
    const pending   = (counts.pending ?? 0)
    const total     = (counts.ok ?? 0) + failCount + warnCount + pending
    const tone: AttentionItem['tone'] = failCount > 0 ? 'bad' : warnCount > 0 ? 'warning' : 'warning'
    const titleSuffix =
      failCount > 0 ? `${failCount} kritiska${failCount === 1 ? '' : ' problem'}` :
      warnCount > 0 ? `${warnCount} observation${warnCount === 1 ? '' : 'er'}` :
                      `${pending} pågående kontroll${pending === 1 ? '' : 'er'}`
    items.push({
      id:     'setup-health',
      tone,
      title:  `Setup-status — ${titleSuffix}`,
      detail: `${counts.ok ?? 0} av ${total} kontroller godkända. Visa detaljer i Inställningar.`,
      cta:    { label: 'Öppna →', href: `/settings/setup-health?business_id=${selectedBizId ?? ''}` },
    })
  }

  const saving = Number(aiSched?.summary?.saving_kr ?? 0)
  if (saving > 0) {
    items.push({
      id: 'labour',
      tone: 'warning',
      title: `Cut labour by ${fmtKr(saving)} this period`,
      detail: `AI-suggested schedule reduces labour by ${Math.round(Number(aiSched.summary.current_hours ?? 0) - Number(aiSched.summary.suggested_hours ?? 0))}h.`,
      cta: { label: 'Open scheduling →', href: '/scheduling' },
    })
  }

  const pending = Number(overheadProj?.pending_count ?? 0)
  const potSavings = Number(overheadProj?.savings?.total_sek ?? 0)
  if (pending > 0) {
    items.push({
      id: 'overhead',
      tone: pending > 3 ? 'bad' : 'warning',
      title: `${pending} cost flag${pending === 1 ? '' : 's'} pending review`,
      detail: potSavings > 0 ? `~${fmtKr(potSavings)}/mo potential savings.` : 'Review the queue to confirm or dismiss.',
      cta: { label: 'Review overheads →', href: '/overheads/review' },
    })
  }

  const tier = labourTier(totalRev > 0 ? labourPct : null)
  if (tier === 'over') {
    items.push({
      id: 'labour-tier',
      tone: 'bad',
      title: `Labour at ${fmtPct(labourPct)} — over target`,
      detail: `Target ${DEFAULT_TIER_CONFIG.targetMin}–${DEFAULT_TIER_CONFIG.targetMax}%. Cutting to the top of band saves ~${fmtKr(Math.max(0, totalLabour - totalRev * (DEFAULT_TIER_CONFIG.targetMax / 100)))}.`,
      cta: { label: 'Open scheduling →', href: '/scheduling' },
    })
  } else if (tier === 'on-target') {
    items.push({
      id: 'labour-tier',
      tone: 'good',
      title: `Labour at ${fmtPct(labourPct)} — on target`,
      detail: `Within ${DEFAULT_TIER_CONFIG.targetMin}–${DEFAULT_TIER_CONFIG.targetMax}%. Hold the line.`,
    })
  }

  const recentAlerts = alerts.filter((a: any) => !a.is_dismissed && (a.severity === 'high' || a.severity === 'critical')).slice(0, 1)
  for (const a of recentAlerts) {
    items.push({
      id: `alert-${a.id}`,
      tone: a.severity === 'critical' ? 'bad' : 'warning',
      title: a.title ?? 'Anomaly flagged',
      detail: a.summary ?? '',
      cta: { label: 'Open alerts →', href: '/alerts' },
    })
  }

  return items.slice(0, 5)
}

function AttentionCard({ items }: { items: AttentionItem[] }) {
  return (
    <Card title="What needs attention" subtitle={`${items.length} item${items.length === 1 ? '' : 's'}`}>
      <div style={{ display: 'grid', gap: 0 }}>
        {items.map((it, idx) => {
          const toneColor =
            it.tone === 'good'    ? UXP.green
            : it.tone === 'bad'   ? UXP.rose
            :                       UXP.coral
          const toneBg =
            it.tone === 'good'    ? UXP.greenFill
            : it.tone === 'bad'   ? UXP.roseFill
            :                       UXP.lavFill
          return (
            <div
              key={it.id}
              style={{
                display:        'grid',
                gridTemplateColumns: '4px 1fr auto',
                gap:            12,
                padding:        '12px 0',
                borderBottom:   idx < items.length - 1 ? `0.5px solid ${UXP.borderSoft}` : 'none',
                alignItems:     'center',
              }}
            >
              <span style={{ width: 4, height: '100%', minHeight: 32, background: toneColor, borderRadius: 2, alignSelf: 'stretch' as const }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: UXP.ink1, marginBottom: 2 }}>{it.title}</div>
                <div style={{ fontSize: 11, color: UXP.ink3, lineHeight: 1.4 }}>{it.detail}</div>
              </div>
              {it.cta && (
                <a
                  href={it.cta.href}
                  style={{
                    padding:      '5px 10px',
                    background:   toneBg,
                    color:        toneColor,
                    border:       `0.5px solid ${toneColor}22`,
                    borderRadius: 999,
                    fontSize:     10,
                    fontWeight:   500,
                    textDecoration: 'none',
                    whiteSpace:   'nowrap' as const,
                  }}
                >
                  {it.cta.label}
                </a>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ── Money flow row ──────────────────────────────────────────────────
function MoneyFlowRow({ bankPos, cashFlow, recentInv, bizId }: any) {
  const locale = useLocale()
  const [pdfModal, setPdfModal] = useState<{ url: string; title: string } | null>(null)
  const cashPosition = Number(bankPos?.summary?.current_position_since_tracking ?? 0)
  const cashMtd      = Number(bankPos?.summary?.this_month_change ?? 0)
  const absBalance   = bankPos?.summary?.absolute_balance != null ? Number(bankPos.summary.absolute_balance) : null

  const cashFlowDays = Array.isArray(cashFlow?.daily) ? cashFlow.daily : []
  const cashFlowEnd  = cashFlowDays.length > 0 ? Number(cashFlowDays[cashFlowDays.length - 1].cumulative ?? 0) : null

  const invoices = Array.isArray(recentInv?.invoices) ? recentInv.invoices.slice(0, 4) : []

  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
      gap:                 12,
    }}>
      {/* Cash position */}
      <Card
        title="Cash position"
        subtitle={absBalance != null ? 'Absolute balance' : 'Net since tracking'}
        info={
          absBalance != null
            ? (locale === 'sv'
                ? `Summa av Fortnox-konton 1900–1989 (kassa, bank, kortinlösen, betalleverantörer) per senaste bokförda verifikation. Visar exakt det som Fortnox visar i webbappen — uppdateras när bokföringen rör sig. Kan släpa efter den faktiska banksaldot om bokföraren ligger efter.`
                : `Sum of Fortnox accounts 1900–1989 (cash, bank, card-acquirer + payment-provider settlement) as of the latest booked voucher. Matches what Fortnox shows in their web app — refreshes as bookkeeping moves. May lag the real bank balance if the bookkeeper is behind.`)
            : (locale === 'sv'
                ? `Nettoförändring sedan vi började synka data. Vi har inga ingående balanser från Fortnox ännu — så detta är bara förändringen, inte den absoluta positionen. Anslut Fortnox för att se det verkliga saldot.`
                : `Net change since we began syncing data. We don't have opening balances from Fortnox yet — this is the delta, not the absolute position. Connect Fortnox to see the real balance.`)
        }
      >
        {bankPos ? (
          <div>
            <BigNumber value={fmtKr(absBalance ?? cashPosition)} tone={(absBalance ?? cashPosition) >= 0 ? 'ink' : 'rose'} />
            <DeltaRow label="This month" value={cashMtd} />
          </div>
        ) : (
          <Empty>No bank data yet.</Empty>
        )}
      </Card>

      {/* Cash flow projection */}
      <Card title="Cash flow" subtitle="30-day projection">
        {cashFlowDays.length > 0 ? (
          <div>
            <BigNumber
              value={cashFlowEnd != null ? fmtKr(cashFlowEnd) : '—'}
              tone={(cashFlowEnd ?? 0) >= 0 ? 'ink' : 'rose'}
            />
            <MiniSparkline points={cashFlowDays.map((d: any) => Number(d.cumulative ?? 0))} />
          </div>
        ) : (
          <Empty>No projection yet.</Empty>
        )}
      </Card>

      {/* Recent invoices */}
      <Card title="Recent invoices" subtitle={`Last ${recentInv?.days_window ?? 14} days`}>
        {invoices.length > 0 ? (
          <div style={{ display: 'grid', gap: 0 }}>
            {invoices.map((inv: any, idx: number) => {
              // PDF resolution: prefer direct file_id → file proxy URL.
              // Else hit invoice-pdf (does just-in-time detail fetch +
              // 302 to file proxy). Both render inline in the modal —
              // stay in app, never link out to Fortnox's web UI.
              const pdfUrl = bizId && (inv.file_id
                ? `/api/integrations/fortnox/file?business_id=${encodeURIComponent(bizId)}&file_id=${encodeURIComponent(inv.file_id)}`
                : inv.given_number
                  ? `/api/integrations/fortnox/invoice-pdf?business_id=${encodeURIComponent(bizId)}&given_number=${encodeURIComponent(inv.given_number)}`
                  : null)
              return (
                <div key={inv.given_number ?? idx} style={{
                  display:             'grid',
                  gridTemplateColumns: '1fr auto auto',
                  gap:                 8,
                  padding:             '8px 0',
                  borderBottom:        idx < invoices.length - 1 ? `0.5px solid ${UXP.borderSoft}` : 'none',
                  alignItems:          'baseline',
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 500, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
                      {inv.supplier_name}
                    </div>
                    <div style={{ fontSize: 9, color: UXP.ink4 }}>{inv.invoice_date}</div>
                  </div>
                  <div style={{
                    fontSize:           11,
                    fontWeight:         500,
                    color:              UXP.ink1,
                    fontVariantNumeric: 'tabular-nums' as const,
                  }}>
                    {inv.total != null ? fmtKr(inv.total) : '—'}
                  </div>
                  {pdfUrl ? (
                    <button
                      type="button"
                      onClick={() => setPdfModal({ url: pdfUrl, title: `${inv.supplier_name} — ${inv.invoice_number ?? ''}` })}
                      title="View invoice PDF in-app"
                      style={{
                        padding:        '2px 8px',
                        background:     UXP.lavFill,
                        color:          UXP.lavText,
                        border:         'none',
                        borderRadius:   999,
                        fontSize:       9,
                        fontWeight:     500,
                        cursor:         'pointer',
                        fontFamily:     'inherit',
                        letterSpacing:  '0.02em',
                      }}
                    >PDF</button>
                  ) : <span />}
                </div>
              )
            })}
          </div>
        ) : (
          <Empty>No recent invoices.</Empty>
        )}
      </Card>

      {pdfModal && <DashboardPdfModal url={pdfModal.url} title={pdfModal.title} onClose={() => setPdfModal(null)} />}
    </div>
  )
}

// Inline PDF viewer for the dashboard's "Recent invoices" card.
// Same pattern as inventory + /invoices — stay in app, never new tab.
function DashboardPdfModal({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
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

// ── Review themes card ──────────────────────────────────────────────
function ReviewThemesCard({ themes }: { themes: any }) {
  const top = (themes.top_themes ?? []).slice(0, 4)
  return (
    <Card title="Review themes" subtitle={`Rolling ${themes.window_days ?? 90} days · ${themes.sample_size ?? 0} reviews`}>
      <div style={{ display: 'grid', gap: 0 }}>
        {top.map((t: any, idx: number) => {
          const isPositive = (t.net_sentiment ?? 0) >  0.2
          const isNegative = (t.net_sentiment ?? 0) < -0.2
          const tone = isPositive ? 'good' : isNegative ? 'bad' : 'neutral'
          const palette = {
            good:    { bg: UXP.greenFill, fg: UXP.greenDeep },
            bad:     { bg: UXP.roseFill,  fg: UXP.roseText  },
            neutral: { bg: UXP.lavFill,   fg: UXP.lavText   },
          }[tone] as { bg: string; fg: string }
          return (
            <div key={t.category} style={{
              display:             'grid',
              gridTemplateColumns: '1fr auto auto',
              gap:                 12,
              alignItems:          'center',
              padding:             '8px 0',
              borderBottom:        idx < top.length - 1 ? `0.5px solid ${UXP.borderSoft}` : 'none',
            }}>
              <span style={{ fontSize: 12, color: UXP.ink1, fontWeight: 500, textTransform: 'capitalize' as const }}>
                {t.category}
              </span>
              <span style={{ fontSize: 10, color: UXP.ink3, fontVariantNumeric: 'tabular-nums' as const }}>
                {t.total_count} mentions
              </span>
              <span style={{
                fontSize:       9,
                padding:        '2px 7px',
                borderRadius:   6,
                background:     palette.bg,
                color:          palette.fg,
              }}>
                {isPositive ? 'Positive' : isNegative ? 'Negative' : 'Mixed'}
              </span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ── Banners ─────────────────────────────────────────────────────────
function UpgradeBanner({ plan, onClose }: { plan: string; onClose: () => void }) {
  return (
    <div style={{
      background:    UXP.greenFill,
      border:        `0.5px solid ${UXP.green}`,
      borderRadius:  UXP.r_lg,
      padding:       '12px 16px',
      display:       'flex',
      alignItems:    'center',
      justifyContent: 'space-between',
      gap:           12,
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: UXP.greenDeep }}>
          🎉 Welcome to {plan || 'your new plan'}
        </div>
        <div style={{ fontSize: 11, color: UXP.greenDeep, marginTop: 2 }}>
          Your subscription is active — all features unlocked.
        </div>
      </div>
      <button onClick={onClose} aria-label="Dismiss" style={{
        background: 'transparent', border: 'none', cursor: 'pointer',
        color: UXP.greenDeep, fontSize: 16, padding: '0 4px',
      }}>×</button>
    </div>
  )
}

function StaleDataBanner({ dataAsOf, loading, viewMode, weekOffset, monthOffset }: any) {
  if (!dataAsOf || loading) return null
  const isCurrentPeriod = (viewMode === 'week' && weekOffset === 0) || (viewMode === 'month' && monthOffset === 0)
  if (!isCurrentPeriod) return null
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  if (dataAsOf >= yesterday) return null
  const daysOld = Math.floor((Date.now() - new Date(dataAsOf + 'T23:59:59Z').getTime()) / 86_400_000)
  return (
    <div style={{
      background:    UXP.lavFill,
      border:        `0.5px solid ${UXP.lav}`,
      borderRadius:  UXP.r_lg,
      padding:       '10px 14px',
      fontSize:      12,
      color:         UXP.lavText,
    }}>
      Latest synced data is <strong>{daysOld === 1 ? 'yesterday' : `${daysOld} days old`}</strong>. Hourly catchup may be running.
    </div>
  )
}

// ── Generic card primitive ──────────────────────────────────────────
function Card({ title, subtitle, info, children }: {
  title:    string
  subtitle?: string
  info?:    string                     // optional tooltip explaining the metric source
  children: React.ReactNode
}) {
  const [showInfo, setShowInfo] = useState(false)
  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       '14px 16px',
      position:      'relative' as const,
    }}>
      <div style={{ marginBottom: 10, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>{title}</div>
          {subtitle && <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{subtitle}</div>}
        </div>
        {info && (
          <button
            type="button"
            onClick={() => setShowInfo(s => !s)}
            onBlur={() => setShowInfo(false)}
            aria-label="Visa förklaring"
            title={showInfo ? 'Dölj förklaring' : 'Visa förklaring'}
            style={{
              width:         16,
              height:        16,
              borderRadius:  '50%',
              background:    showInfo ? UXP.lavFill : 'transparent',
              border:        `0.5px solid ${UXP.border}`,
              color:         UXP.ink3,
              fontSize:      10,
              fontWeight:    600,
              cursor:        'pointer',
              display:       'inline-flex',
              alignItems:    'center',
              justifyContent: 'center',
              padding:       0,
              lineHeight:    1,
              flexShrink:    0,
            }}
          >
            ?
          </button>
        )}
      </div>
      {info && showInfo && (
        <div
          role="tooltip"
          style={{
            position:     'absolute' as const,
            top:          38,
            right:        12,
            zIndex:       10,
            maxWidth:     280,
            background:   UXP.ink1,
            color:        UXP.cardBg,
            padding:      '8px 11px',
            borderRadius: 6,
            fontSize:     11,
            lineHeight:   1.55,
            boxShadow:    '0 4px 14px rgba(58,53,80,0.18)',
            whiteSpace:   'normal' as const,
          }}
        >
          {info}
        </div>
      )}
      {children}
    </div>
  )
}

function BigNumber({ value, tone = 'ink' }: { value: string; tone?: 'ink' | 'rose' }) {
  return (
    <div style={{
      fontFamily:         'var(--font-display)',
      fontSize:           24,
      fontWeight:         500,
      color:              tone === 'rose' ? UXP.roseText : UXP.ink1,
      letterSpacing:      '-0.02em',
      fontVariantNumeric: 'tabular-nums' as const,
      lineHeight:         1.1,
      marginBottom:       6,
    }}>
      {value}
    </div>
  )
}

function DeltaRow({ label, value }: { label: string; value: number }) {
  const tone = value >= 0 ? UXP.green : UXP.rose
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 10 }}>
      <span style={{ color: UXP.ink3 }}>{label}</span>
      <span style={{ color: tone, fontVariantNumeric: 'tabular-nums' as const }}>
        {value >= 0 ? '+' : '−'}{fmtKr(Math.abs(value))}
      </span>
    </div>
  )
}

function MiniSparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1
  const w = 200, h = 32
  const step = w / (points.length - 1)
  const path = points.map((v, i) => {
    const x = i * step
    const y = h - ((v - min) / range) * h
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const endNegative = points[points.length - 1] < 0
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ marginTop: 6, display: 'block' }}>
      <path d={path} stroke={endNegative ? UXP.rose : UXP.lav} strokeWidth={1.5} fill="none" />
    </svg>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, color: UXP.ink4, padding: '8px 0' }}>{children}</div>
  )
}

// ── W/M toggle ──────────────────────────────────────────────────────
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
            padding:      '4px 12px',
            background:   value === v ? UXP.lavFill : 'transparent',
            color:        value === v ? UXP.lavText : UXP.ink3,
            border:       'none',
            borderRadius: 5,
            fontSize:     10,
            fontWeight:   500,
            fontFamily:   'inherit',
            cursor:       'pointer',
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
