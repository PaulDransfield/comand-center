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

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale } from 'next-intl'
import { useRouter, useSearchParams } from 'next/navigation'
import dynamicImport from 'next/dynamic'

const AskAI = dynamicImport(() => import('@/components/AskAI'), { ssr: false, loading: () => null })

import { createClient } from '@/lib/supabase/client'
import AppShell from '@/components/AppShell'
import { PageContainer } from '@/components/ui/Layout'
import { ResponsiveChart } from '@/components/ui/ResponsiveChart'
import { PdfButton } from '@/components/ui/PdfButton'
import KpiCardUX from '@/components/ux/KpiCard'
import { ProvenancePopover, type Metric as ProvMetric } from '@/components/ProvenancePopover'
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

// ── Weather icon (lucide-style inline SVG) ────────────────────────────
// Replaces the previous emoji set. Emoji rendering varies wildly across
// OSes (Segoe UI Emoji on Windows reads chunky / cartoonish; Apple Color
// Emoji on Mac doesn't match the editorial palette of the dashboard) and
// also breaks the brand no-emoji rule. One-weight line icons keep the
// dashboard sharp at any DPR and inherit currentColor / size cleanly.
function WeatherIcon({ code, size = 14, color = 'currentColor' }: {
  code?: number; size?: number; color?: string
}) {
  if (code == null) return null
  const which =
    code === 0                   ? 'sun'              :
    code <= 3                    ? 'cloud-sun'        :
    code === 45 || code === 48   ? 'cloud-fog'        :
    code >= 51 && code <= 57     ? 'cloud-drizzle'    :
    code >= 61 && code <= 67     ? 'cloud-rain'       :
    code >= 71 && code <= 77     ? 'snowflake'        :
    code >= 80 && code <= 82     ? 'cloud-rain'       :
    code >= 85 && code <= 86     ? 'snowflake'        :
    code >= 95                   ? 'cloud-lightning'  :
    null
  if (!which) return null
  const attrs = {
    width:           size,
    height:          size,
    viewBox:         '0 0 24 24',
    fill:            'none' as const,
    stroke:          color,
    strokeWidth:     1.75,
    strokeLinecap:   'round'  as const,
    strokeLinejoin:  'round'  as const,
    'aria-hidden':   true     as const,
    style: { display: 'inline-block', verticalAlign: 'middle' as const, flexShrink: 0 },
  }
  if (which === 'sun') return (
    <svg {...attrs}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  )
  if (which === 'cloud-sun') return (
    <svg {...attrs}>
      <path d="M12 2v2M4.93 4.93l1.41 1.41M20 12h2M19.07 4.93l-1.41 1.41" />
      <path d="M15.95 12.65a4 4 0 0 0-5.93-4.13" />
      <path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z" />
    </svg>
  )
  if (which === 'cloud-fog') return (
    <svg {...attrs}>
      <path d="M5 17a4 4 0 0 1 0-8 6 6 0 0 1 11.41-1.5A4.5 4.5 0 1 1 17 17" />
      <path d="M16 17H7M17 21H9" />
    </svg>
  )
  if (which === 'cloud-drizzle') return (
    <svg {...attrs}>
      <path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24" />
      <path d="M8 19v1M8 14v1M16 19v1M16 14v1M12 21v1M12 16v1" />
    </svg>
  )
  if (which === 'cloud-rain') return (
    <svg {...attrs}>
      <path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24" />
      <path d="M16 14v6M8 14v6M12 16v6" />
    </svg>
  )
  if (which === 'snowflake') return (
    <svg {...attrs}>
      <path d="M12 2v20M4 6l16 12M4 18 20 6" />
    </svg>
  )
  if (which === 'cloud-lightning') return (
    <svg {...attrs}>
      <path d="M6 16.33A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.97" />
      <path d="m13 12-3 5h4l-3 5" />
    </svg>
  )
  return null
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
  const [dataQuality,   setDataQuality]   = useState<any>(null)
  const [forecastRecent, setForecastRecent] = useState<any>(null)
  const [forecastByDay, setForecastByDay] = useState<Record<string, number>>({})
  const [latestPeriod, setLatestPeriod] = useState<{ year: number; month: number } | null>(null)
  const autoJumpedRef = useRef(false)
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
  // Extracted to a useCallback so the ColdStartBanner (and any other
  // surface that triggers a fresh load) can call it imperatively after
  // an action — e.g. after "Sync now" completes, we want the dashboard
  // numbers to refresh without a page reload.
  const loadDashboard = useCallback(() => {
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
  }, [bizId, viewMode, weekOffset, monthOffset])

  useEffect(() => { loadDashboard() }, [loadDashboard])

  // ── Auto-land on the latest month WITH data ───────────────────────
  // Businesses with no daily feed (Fortnox-only / Caspeco) have an empty
  // current month, so the dashboard would land blank. Fetch the latest month
  // that actually has data (closed Fortnox P&L or POS revenue) and jump there
  // on first load — unless the URL pins a specific period.
  useEffect(() => {
    if (!bizId) return
    autoJumpedRef.current = false
    setLatestPeriod(null)
    fetch(`/api/metrics/latest-period?business_id=${bizId}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(j => setLatestPeriod(j?.latest ?? null))
      .catch(() => {})
  }, [bizId])

  useEffect(() => {
    if (!bizId || autoJumpedRef.current || !latestPeriod) return
    autoJumpedRef.current = true
    // Respect an explicit period chosen via the URL — don't override it.
    const p = new URLSearchParams(window.location.search)
    if (p.get('offset') != null) return
    const now = new Date()
    const isCurrent = latestPeriod.year === now.getFullYear() && latestPeriod.month === (now.getMonth() + 1)
    if (isCurrent) return
    const off = (latestPeriod.year - now.getFullYear()) * 12 + (latestPeriod.month - (now.getMonth() + 1))
    setViewMode('month')
    setMonthOffset(off)
    writeUrl({ view: 'month', offset: off })
  }, [bizId, latestPeriod])

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

  // ── Per-day AI forecast for the viewed period (for the chart tooltip) ──
  // Unlike the scheduling AI suggestion above (current/future only), this
  // reads daily_forecast_outcomes, so hovering any day — including past
  // months — shows what we predicted for it.
  useEffect(() => {
    if (!bizId) return
    let cancelled = false
    const period = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
    fetch(`/api/forecast/by-period?business_id=${bizId}&from=${period.from}&to=${period.to}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (!cancelled) setForecastByDay(j && j.days && !j.error ? j.days : {}) })
      .catch(() => { if (!cancelled) setForecastByDay({}) })
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
      fetch(`/api/data-quality/score?business_id=${bizId}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/forecast/recent?business_id=${bizId}&days=14`, { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([ov, dm, bp, cf, ri, rt, dq, fr]) => {
      if (cancelled) return
      setOverheadProj(ov && !ov.error ? ov : null)
      setDemand(dm && !dm.error ? dm : null)
      setBankPos(bp && !bp.error ? bp : null)
      setCashFlow(cf && !cf.error ? cf : null)
      setRecentInv(ri && !ri.error ? ri : null)
      setReviewThemes(rt && !rt.error ? rt : null)
      setDataQuality(dq && !dq.error ? dq : null)
      setForecastRecent(fr && !fr.error ? fr : null)
    })
    return () => { cancelled = true }
  }, [bizId])

  // ── Derived numbers ──────────────────────────────────────────────
  const now      = new Date()
  const curr     = getWeekBounds(weekOffset)
  const currM    = getMonthBounds(monthOffset)
  const period   = viewMode === 'week' ? curr : currM
  const dayCount = viewMode === 'week' ? 7 : currM.daysInMonth

  const dailyRev    = dailyRows.reduce((s, r) => s + r.revenue,    0)
  const dailyLabour = dailyRows.reduce((s, r) => s + r.staff_cost, 0)
  // Closed-month principle: when the API marks the month as closed in Fortnox
  // (summary.source='fortnox_closed'), the official P&L figure WINS over the
  // daily POS sum — the month is reported with corrected numbers. The current
  // open month (source='daily') keeps the live daily totals.
  const fortnoxMonthly = (currSummary as any)?.source === 'fortnox_closed'
  const totalRev    = fortnoxMonthly ? Number(currSummary?.total_revenue    ?? 0)
    : (dailyRev    > 0 ? dailyRev    : Number(currSummary?.total_revenue    ?? 0))
  const totalLabour = fortnoxMonthly ? Number(currSummary?.total_staff_cost ?? 0)
    : (dailyLabour > 0 ? dailyLabour : Number(currSummary?.total_staff_cost ?? 0))
  const hasDailyShape = dailyRev > 0
  // Real net margin from the closed Fortnox P&L (after ALL costs). Null for
  // POS/open months, where we only have revenue + labour to work with.
  const fortnoxNetMargin = (fortnoxMonthly && (currSummary as any)?.net_margin_pct != null)
    ? Number((currSummary as any).net_margin_pct) : null
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
          predicted: forecastByDay[ds] ?? null,
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
        predicted: forecastByDay[ds] ?? null,
      }
    })
  }, [viewMode, weekOffset, monthOffset, dailyRows, aiSched, forecastByDay])

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
      <PageContainer>
      <div style={{ display: 'grid', gap: 14 }}>

        {showUpgrade && (
          <UpgradeBanner plan={upgradePlan} onClose={() => setShowUpgrade(false)} />
        )}

        <ColdStartBanner
          loading={loading}
          dailyRows={dailyRows}
          selectedBiz={selectedBiz}
          onSyncComplete={loadDashboard}
        />
        <StaleDataBanner dataAsOf={dataAsOf} loading={loading} viewMode={viewMode} weekOffset={weekOffset} monthOffset={monthOffset} />

        {/* W/M toggle — sits at top right of the page, separate from the
            toolbar's date stepper. The pastel pills mirror the toolbar style. */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <ViewModeToggle value={viewMode} onChange={v => {
            setViewMode(v)
            writeUrl({ view: v, offset: v === 'month' ? monthOffset : weekOffset })
          }} />
        </div>

        {/* Fortnox-monthly source note — shown when the figures come from the
            monthly P&L (no daily POS/staff feed for this business). */}
        {fortnoxMonthly && (
          <div style={{
            padding: '8px 14px', background: UXP.lavFill, border: `0.5px solid ${UXP.lavMid}`,
            borderRadius: 8, fontSize: 11.5, color: UXP.lavText, lineHeight: 1.5,
          }}>
            Headline figures are the <strong>officially closed Fortnox P&amp;L</strong> for {periodLabel} — the
            month is reported and corrected, so these supersede the live POS totals.
            {hasDailyShape
              ? ' The chart below shows the day-by-day POS activity.'
              : ' Connect a POS or staff system for the day-by-day breakdown.'}{' '}
            Full monthly detail is on <a href="/financials/performance" style={{ color: UXP.lavText, fontWeight: 600 }}>Financials → Performance</a>.
          </div>
        )}

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
          netMarginPct={fortnoxNetMargin}
          bizId={bizId}
          from={period.from}
          to={period.to}
        />

        {/* ── Demand outlook (next 7 days) ──────────────────────── */}
        {demand?.days?.length > 0 && (
          <DemandOutlookStrip demand={demand} />
        )}

        {/* ── Performance chart ─────────────────────────────────── */}
        <ChartCard days={days} loading={loading} monthlyOnly={fortnoxMonthly && !hasDailyShape} />

        {/* ── Forecast check (predicted vs actual) ──────────────── */}
        {forecastRecent?.n > 0 && (
          <ForecastCheckCard recent={forecastRecent} />
        )}

        {/* ── Attention panel ───────────────────────────────────── */}
        {attentionItems.length > 0 && (
          <AttentionCard items={attentionItems} />
        )}

        {/* ── Data trust ────────────────────────────────────────── */}
        {dataQuality && (
          <DataTrustTile dq={dataQuality} />
        )}

        {/* ── Money flow row ────────────────────────────────────── */}
        <MoneyFlowRow bankPos={bankPos} cashFlow={cashFlow} recentInv={recentInv} bizId={bizId} />

        {/* ── Review themes ─────────────────────────────────────── */}
        {reviewThemes?.top_themes?.length > 0 && (
          <ReviewThemesCard themes={reviewThemes} />
        )}
      </div>
      </PageContainer>

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
  netMarginPct, bizId, from, to,
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

  // Two very different things:
  //   · netMarginPct (when present) = the REAL net margin from the closed
  //     Fortnox P&L — after food, labour, overheads, depreciation. This is the
  //     true bottom-line margin.
  //   · grossMargin = revenue − labour only (the best we can do from POS data
  //     alone, when there's no closed P&L). Labelled so it's never mistaken
  //     for net margin.
  const grossMargin   = totalRev > 0 ? ((totalRev - totalLabour) / totalRev) * 100 : 0
  const marginIsNet   = netMarginPct != null
  const marginValue   = marginIsNet ? Number(netMarginPct) : grossMargin
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

  // A1.10 — each KPI tile gets a corner ProvenancePopover that lazy-fetches
  // /api/audit/provenance on first open. KpiCardUX has no slot for a
  // corner affordance, so each card is wrapped in a relative-positioned
  // div with an absolute-positioned popover trigger.
  const provWrap = (children: React.ReactNode, metric: ProvMetric, label: string) => (
    <div style={{ position: 'relative' as const }}>
      {children}
      {bizId && from && to && (
        <div style={{ position: 'absolute' as const, top: 12, right: 12, zIndex: 5 }}>
          <ProvenancePopover businessId={bizId} metric={metric} from={from} to={to} label={label} />
        </div>
      )}
    </div>
  )

  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap:                 12,
    }}>
      {provWrap(
        <KpiCardUX
          title="Revenue"
          value={totalRev > 0 ? fmtKr(totalRev) : '—'}
          delta={revDelta}
          deltaGood
          variant="channels"
          channels={channels}
          microLabel={periodLabel}
        />,
        'revenue', 'Revenue',
      )}
      {provWrap(
        <KpiCardUX
          title={marginIsNet ? 'Net margin' : 'Margin'}
          value={totalRev > 0 ? fmtPct(marginValue) : '—'}
          delta={marginIsNet ? null : marginDelta}
          deltaGood
          variant="stacked"
          microLabel={marginIsNet ? 'After all costs (Fortnox)' : 'Revenue − labour only'}
          stackedBars={[
            { label: 'Current', value: Math.max(0, marginValue), max: 100, color: UXP.lav   },
            { label: 'Target',  value: TARGET_MARGIN,            max: 100, color: UXP.green },
          ]}
        />,
        'net_profit', 'Margin',
      )}
      {provWrap(
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
        />,
        'staff_cost', 'Labour',
      )}
      {provWrap(
        <KpiCardUX
          title="Covers"
          value={totalCovers > 0 ? totalCovers.toLocaleString('sv-SE') : '—'}
          delta={coversDelta}
          deltaGood
          microLabel={totalCovers > 0 && totalRev > 0 ? `${fmtKr(Math.round(totalRev / totalCovers))} per cover` : ''}
        />,
        'covers', 'Covers',
      )}
    </div>
  )
}

// ── Demand outlook (horizontal strip) ────────────────────────────────
//
// Each of the 7 days needs ~120px to be legible, so 7-up only fits
// from ~880px viewport-width up. Below that we keep the same row but
// let it scroll horizontally inside the Card — the page stays at the
// container width and the user swipes through the week. Above tablet
// width all 7 days fit side-by-side as before.
function DemandOutlookStrip({ demand }: { demand: any }) {
  const days = demand.days as any[]
  return (
    <Card title="Demand outlook" subtitle={`Next ${days.length} days — weather × revenue correlation`}>
      <div style={{
        overflowX: 'auto' as const,
        WebkitOverflowScrolling: 'touch' as const,
        margin:  '0 -16px',                 // bleed into card padding so the scroll fills it
        padding: '0 16px',
      }}>
      <div style={{
        display:             'grid',
        gridTemplateColumns: `repeat(${Math.min(days.length, 7)}, minmax(120px, 1fr))`,
        gap:                 8,
        minWidth:            `${Math.min(days.length, 7) * 120}px`,
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
                boxShadow:    UXP.shadowSoft,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500, letterSpacing: '0.02em' }}>
                  {d.weekday}
                </span>
                <WeatherIcon code={d.weather?.code} size={14} color={UXP.ink2} />
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
      </div>
    </Card>
  )
}

// ── Chart card ───────────────────────────────────────────────────────
function ChartCard({ days, loading, monthlyOnly }: { days: any[]; loading: boolean; monthlyOnly?: boolean }) {
  // Fortnox-only month: there's no daily data to draw, so show a clear note
  // instead of an empty 30-bar grid.
  if (monthlyOnly) {
    return (
      <Card title="Revenue & labour" subtitle="Daily breakdown">
        <div style={{
          minHeight: 200, display: 'flex', flexDirection: 'column' as const, gap: 8,
          alignItems: 'center', justifyContent: 'center', textAlign: 'center' as const,
          color: UXP.ink3, fontSize: 13, lineHeight: 1.6, padding: '24px 16px',
        }}>
          <div style={{ fontWeight: 600, color: UXP.ink2 }}>No day-by-day breakdown for this month</div>
          <div style={{ maxWidth: 460, fontSize: 12 }}>
            The headline figures above are the <strong>closed Fortnox monthly P&amp;L</strong> — an official total,
            not daily data. The day-by-day chart fills in once a POS / staff system feeds daily sales and labour.
            Full monthly detail is on <a href="/financials/performance" style={{ color: UXP.lavText, fontWeight: 600 }}>Financials → Performance</a>.
          </div>
        </div>
      </Card>
    )
  }
  // Colour scheme:
  //   - Revenue:        UXP.lav     (light lavender)
  //   - Labour (closed days): UXP.lavDeep (darker lavender — clear contrast vs revenue)
  //   - Labour (today): pastel peach (scheduled, not final)
  const LAB_TODAY_FILL   = '#f4c39a'
  const LAB_TODAY_STROKE = '#d68b58'
  const labourColors = days.map(d => d.isToday && Number(d.staff_cost ?? 0) > 0 ? LAB_TODAY_FILL   : null)
  const labourStroke = days.map(d => d.isToday && Number(d.staff_cost ?? 0) > 0 ? LAB_TODAY_STROKE : null)

  // AI forecast for the hover tooltip. `predicted` per day comes from
  // daily_forecast_outcomes (covers past months too). We also compute the
  // actual-vs-forecast variance for days that already have real revenue, so
  // looking back you can see at a glance whether you beat or missed forecast.
  const hasForecast = days.some(d => d.predicted != null)
  const forecastData = days.map(d => (d.predicted != null ? Number(d.predicted) : null))
  const varianceData = days.map(d => {
    const rev = Number(d.revenue ?? 0)
    return (d.predicted && rev > 0) ? ((rev - Number(d.predicted)) / Number(d.predicted)) * 100 : null
  })
  const tooltipExtras = hasForecast ? [
    { label: 'AI forecast', data: forecastData, color: UXP.lavDeep, fmt: 'kr' as const },
    { label: 'vs forecast', data: varianceData, fmt: 'pct' as const, signed: true },
  ] : []

  return (
    <Card title="Revenue & labour" subtitle="Daily bars · labour as % of revenue · today in peach (scheduled, not final)">
      {loading ? (
        // Reserve the chart's height during reload (when the owner
        // clicks Week/Month) so the card doesn't collapse to a thin
        // "Loading…" strip and then expand back when data arrives.
        // The visible height shift used to read as a "page flips to a
        // different layout" jump — keeping the box at 260px eliminates
        // the layout shift entirely.
        <div style={{
          minHeight: 260,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: UXP.ink3, fontSize: 12,
        }}>Loading…</div>
      ) : (
        // Container-aware width via <ResponsiveChart> — replaces the
        // earlier `window.innerWidth - 120` hack so the chart resizes
        // on rotate/sidebar-toggle/window-resize.
        <ResponsiveChart minHeight={260} maxWidth={1200}>
          {(width) => (
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
              tooltipExtras={tooltipExtras}
              rightMax={100}
              width={width}
              height={260}
            />
          )}
        </ResponsiveChart>
      )}
    </Card>
  )
}

// ── Forecast check (predicted vs actual) ─────────────────────────────
// Backward-looking companion to the forward DemandOutlook strip: shows how
// our daily revenue forecast did against reality. Headline = the latest
// resolved day (usually yesterday); below it the last ~7 days; footer the
// window-average accuracy with a link to the full /forecast breakdown.
// Data from /api/forecast/recent (resolved daily_forecast_outcomes).
function ForecastCheckCard({ recent }: { recent: any }) {
  const rows: any[] = Array.isArray(recent?.rows) ? recent.rows : []
  const latest = recent?.latest
  if (!latest) return null

  const today = localDate(new Date())
  const yest  = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return localDate(d) })()
  const dLabel = (ds: string) => {
    const d = new Date(ds + 'T00:00:00')
    const wd = DAYS[(d.getDay() + 6) % 7]
    return `${wd} ${d.getDate()} ${MONTHS[d.getMonth()]}`
  }
  const relLabel = latest.date === yest ? 'Yesterday' : latest.date === today ? 'Today' : dLabel(latest.date)

  const accTone = (a: number | null) =>
      a == null ? UXP.ink3 : a >= 90 ? UXP.green : a >= 75 ? UXP.coral : UXP.rose
  const accBg = (a: number | null) =>
      a == null ? UXP.subtleBg : a >= 90 ? UXP.greenFill : a >= 75 ? UXP.lavFill : UXP.roseFill
  const errLabel = (e: number | null) =>
      e == null ? '—' : Math.abs(e) < 0.5 ? 'spot on' : `${Math.abs(Math.round(e))}% ${e > 0 ? 'over' : 'under'}`

  const last7 = rows.slice(-7)

  return (
    <Card title="Forecast check" subtitle="What we predicted vs what you actually did">
      {/* Headline — latest resolved day */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, paddingBottom: 12, borderBottom: `0.5px solid ${UXP.borderSoft}` }}>
        <div>
          <div style={{ fontSize: 11, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{relLabel}</div>
          <div style={{ fontSize: 22, fontWeight: 600, color: UXP.ink1, fontFamily: 'var(--font-display)', fontVariantNumeric: 'tabular-nums' as const, letterSpacing: '-0.02em', lineHeight: 1.1, marginTop: 4 }}>
            {fmtKr(latest.actual)}
          </div>
          <div style={{ fontSize: 11, color: UXP.ink3, marginTop: 2 }}>
            actual · predicted <span style={{ color: UXP.ink2, fontVariantNumeric: 'tabular-nums' as const }}>{fmtKr(latest.predicted)}</span>
          </div>
        </div>
        <span style={{ padding: '4px 10px', borderRadius: 999, background: accBg(latest.accuracy_pct), color: accTone(latest.accuracy_pct), fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' as const, fontVariantNumeric: 'tabular-nums' as const }}>
          {errLabel(latest.error_pct)}
        </span>
      </div>

      {/* Last 7 resolved days */}
      <div style={{ display: 'grid', gap: 0, marginTop: 4 }}>
        {last7.map((r, idx) => (
          <div key={r.date} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 10, alignItems: 'center', padding: '6px 0', borderBottom: idx < last7.length - 1 ? `0.5px solid ${UXP.borderSoft}` : 'none' }}>
            <span style={{ fontSize: 11, color: UXP.ink2 }}>{dLabel(r.date)}</span>
            <span style={{ fontSize: 10, color: UXP.ink4, fontVariantNumeric: 'tabular-nums' as const, minWidth: 60, textAlign: 'right' as const }} title="predicted">{fmtKr(r.predicted)}</span>
            <span style={{ fontSize: 11, color: UXP.ink1, fontWeight: 500, fontVariantNumeric: 'tabular-nums' as const, minWidth: 64, textAlign: 'right' as const }} title="actual">{fmtKr(r.actual)}</span>
            <span style={{ fontSize: 10, fontWeight: 600, color: accTone(r.accuracy_pct), fontVariantNumeric: 'tabular-nums' as const, minWidth: 48, textAlign: 'right' as const }}>
              {r.error_pct == null ? '—' : `${r.error_pct > 0 ? '+' : ''}${Math.round(r.error_pct)}%`}
            </span>
          </div>
        ))}
      </div>

      {/* Footer — window accuracy + link to full breakdown */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, paddingTop: 10, borderTop: `0.5px solid ${UXP.borderSoft}` }}>
        <span style={{ fontSize: 11, color: UXP.ink3 }}>
          {recent.window_accuracy_pct != null
            ? <>Last {recent.n} days · <span style={{ color: UXP.ink1, fontWeight: 600 }}>{fmtPct(recent.window_accuracy_pct)}</span> avg accuracy</>
            : `Last ${recent.n} days`}
        </span>
        <a href="/forecast" style={{ fontSize: 11, fontWeight: 600, color: UXP.lavText, textDecoration: 'none' }}>Full accuracy →</a>
      </div>
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
// ── Data trust tile (A1.9) ──────────────────────────────────────────
// Owner-facing "can I trust the numbers" signal. Overall 0-100 score on
// the left, dimension chips on the right. Click → /data-quality drilldown.
// Score colour follows the standard tone scale: green ≥ 80, coral 50-79,
// rose < 50. When overall_score is null (zero applicable dimensions —
// brand-new business), render a "Get started" prompt instead.
function DataTrustTile({ dq }: { dq: any }) {
  const score = dq?.overall_score
  const dims  = (dq?.dimensions ?? []) as Array<any>
  const tone =
    score == null      ? UXP.ink3
    : score >= 80      ? UXP.green
    : score >= 50      ? UXP.coral
    :                    UXP.rose
  const toneBg =
    score == null      ? UXP.subtleBg
    : score >= 80      ? UXP.greenFill
    : score >= 50      ? UXP.lavFill
    :                    UXP.roseFill

  const subtitle = score == null
    ? 'Get started to start scoring'
    : `${dq.applicable} of ${dims.length} dimensions applicable`

  return (
    <Card title="Data trust" subtitle={subtitle}>
      <a href="/data-quality" style={{
        display:        'grid',
        gridTemplateColumns: 'auto 1fr',
        gap:            16,
        alignItems:     'center',
        textDecoration: 'none',
        color:          'inherit',
      }}>
        {/* Score circle */}
        <div style={{
          width:        72,
          height:       72,
          borderRadius: '50%',
          background:   toneBg,
          border:       `0.5px solid ${tone}33`,
          display:      'inline-flex',
          alignItems:   'center',
          justifyContent: 'center',
          flexDirection: 'column' as const,
        }}>
          <div style={{
            fontSize:        22,
            fontWeight:      600,
            color:           tone,
            letterSpacing:   '-0.02em',
            fontVariantNumeric: 'tabular-nums' as const,
            lineHeight:      1,
          }}>
            {score == null ? '—' : score}
          </div>
          <div style={{ fontSize: 8, color: UXP.ink4, marginTop: 3, letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>
            {score == null ? 'n/a' : 'of 100'}
          </div>
        </div>

        {/* Dimension chips */}
        <div style={{ display: 'grid', gap: 4 }}>
          {dims.map((d: any) => {
            const isApplicable = d.total > 0 && d.score !== null
            const dTone =
              !isApplicable     ? UXP.ink4
              : d.score >= 80   ? UXP.green
              : d.score >= 50   ? UXP.coral
              :                   UXP.rose
            return (
              <div key={d.key} style={{
                display:        'grid',
                gridTemplateColumns: '1fr auto auto',
                gap:            10,
                alignItems:     'center',
                padding:        '4px 0',
              }}>
                <div style={{ fontSize: 11, color: UXP.ink2, minWidth: 0, overflow: 'hidden' as const, textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                  {d.label}
                </div>
                <div style={{ fontSize: 10, color: UXP.ink4, fontVariantNumeric: 'tabular-nums' as const }}>
                  {isApplicable ? `${d.count}/${d.total}` : 'n/a'}
                </div>
                <div style={{
                  fontSize:           11,
                  fontWeight:         500,
                  color:              dTone,
                  fontVariantNumeric: 'tabular-nums' as const,
                  minWidth:           32,
                  textAlign:          'right' as const,
                }}>
                  {isApplicable ? `${d.score}%` : '—'}
                </div>
              </div>
            )
          })}
        </div>
      </a>
    </Card>
  )
}

function MoneyFlowRow({ bankPos, cashFlow, recentInv, bizId }: any) {
  const locale = useLocale()
  const [pdfModal, setPdfModal] = useState<{ url: string; title: string } | null>(null)
  const cashPosition = Number(bankPos?.summary?.current_position_since_tracking ?? 0)
  const cashMtd      = Number(bankPos?.summary?.this_month_change ?? 0)
  const absBalance   = bankPos?.summary?.absolute_balance != null ? Number(bankPos.summary.absolute_balance) : null
  const vatOwed      = bankPos?.summary?.vat_owed          != null ? Number(bankPos.summary.vat_owed)          : null
  const payables     = bankPos?.summary?.supplier_payables != null ? Number(bankPos.summary.supplier_payables) : null
  const payrollTax   = bankPos?.summary?.payroll_tax_owed  != null ? Number(bankPos.summary.payroll_tax_owed)  : null
  const spendable    = bankPos?.summary?.spendable_cash    != null ? Number(bankPos.summary.spendable_cash)    : null
  const hasCommitments = (vatOwed ?? 0) > 0 || (payables ?? 0) > 0 || (payrollTax ?? 0) > 0

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
            {/* Spendable-cash breakdown — the headline balance includes money
                already owed out (VAT to Skatteverket, unpaid supplier invoices). */}
            {hasCommitments && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: `0.5px solid ${UXP.borderSoft}`, display: 'grid', gap: 5 }}>
                {vatOwed != null && vatOwed > 0 && (
                  <CommitRow label="VAT owed (Skatteverket)" value={vatOwed} />
                )}
                {payables != null && payables > 0 && (
                  <CommitRow label="Supplier payables" value={payables} />
                )}
                {payrollTax != null && payrollTax > 0 && (
                  <CommitRow label="Payroll tax owed" value={payrollTax} />
                )}
                {spendable != null && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 3, paddingTop: 6, borderTop: `0.5px solid ${UXP.borderSoft}` }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: UXP.ink1 }}>Spendable ≈</span>
                    <span style={{ fontSize: 15, fontWeight: 700, color: spendable >= 0 ? UXP.ink1 : UXP.rose, fontVariantNumeric: 'tabular-nums' as const }}>
                      {fmtKr(spendable)}
                    </span>
                  </div>
                )}
              </div>
            )}
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
                    <PdfButton
                      size="xs"
                      title="View invoice PDF in-app"
                      onClick={() => setPdfModal({ url: pdfUrl, title: `${inv.supplier_name} — ${inv.invoice_number ?? ''}` })}
                    />
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
      boxShadow:     UXP.shadowSoft,
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: UXP.greenDeep, letterSpacing: '-0.005em' }}>
          Welcome to {plan || 'your new plan'}
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

// ── Cold-start banner ───────────────────────────────────────────────
// Shown when a fresh customer signs up, connects integrations, lands on
// the dashboard — but the nightly master-sync hasn't run yet. Without
// this, they see blank KPI cards + an empty chart and assume the product
// is broken. The banner explains the wait, shows them what's expected,
// and gives them a "Sync now" button so they don't have to wait.
//
// Renders only when:
//   - bizId is set
//   - loading is false (otherwise we'd flash the banner during initial load)
//   - dailyRows is empty (no data yet)
//   - business was created < 72h ago (older = stale-data, not cold-start)
function ColdStartBanner({ loading, dailyRows, selectedBiz, onSyncComplete }: {
  loading:        boolean
  dailyRows:      any[]
  selectedBiz:    any
  onSyncComplete: () => void
}) {
  const [syncing, setSyncing] = useState(false)
  const [result, setResult]   = useState<{ ok: boolean; message: string } | null>(null)
  // Snapshot of this business's integrations so we can tell "sync is broken"
  // (push the alarming "check integrations" copy) apart from "integrations
  // are fine, the current period just happens to have no activity" (a calm
  // hint). Without this the banner falsely accuses healthy integrations of
  // being broken any time the selected week/month has no data.
  const [integrations, setIntegrations] = useState<{ provider: string; status: string | null; last_sync_at: string | null }[] | null>(null)

  useEffect(() => {
    if (!selectedBiz?.id) { setIntegrations(null); return }
    let cancelled = false
    const supabase = createClient()
    supabase
      .from('integrations')
      .select('provider, status, last_sync_at')
      .eq('business_id', selectedBiz.id)
      .then(({ data }) => { if (!cancelled) setIntegrations((data as any) ?? []) })
    return () => { cancelled = true }
  }, [selectedBiz?.id])

  if (loading) return null
  if (!selectedBiz?.id) return null
  if (dailyRows.length > 0) return null

  const createdAt = selectedBiz?.created_at ? new Date(selectedBiz.created_at).getTime() : null
  const ageHours  = createdAt ? (Date.now() - createdAt) / 3600_000 : null
  const isFresh   = ageHours != null && ageHours < 72

  // For non-fresh businesses we need the integration probe before deciding
  // copy. Returning null briefly is fine — anything else risks flashing the
  // alarming "check integrations" message before the probe lands.
  if (!isFresh && integrations == null) return null

  const STALE_HOURS = 36
  // Daily metrics (revenue, staff_cost, covers, hours) only come from POS /
  // staff systems — never Fortnox, which is monthly P&L only. Keep this list
  // in sync with /api/sync/now's provider list (minus fortnox).
  const DAILY_METRIC_PROVIDERS = new Set(['personalkollen', 'onslip', 'ancon', 'swess', 'caspeco', 'inzii'])
  const isHealthy = (i: { status: string | null; last_sync_at: string | null }) => {
    if (i.status !== 'connected') return false
    if (!i.last_sync_at) return false
    const ageH = (Date.now() - new Date(i.last_sync_at).getTime()) / 3600_000
    return ageH < STALE_HOURS
  }
  const healthy            = (integrations ?? []).filter(isHealthy)
  const healthyCount       = healthy.length
  const healthyDailyCount  = healthy.filter(i => DAILY_METRIC_PROVIDERS.has(i.provider)).length
  const integrationCount   = (integrations ?? []).length

  // Five states (only one of these is true at a time):
  //   isFresh            — new business < 72h old → "your data is on its way"
  //   noIntegrations     — none connected to this business → prompt to connect
  //   isStale            — has integrations, none healthy → alarming "check integrations"
  //   needsDailySource   — Fortnox-only (or other monthly-only sources); no POS/staff feed → explain & prompt
  //   isEmptyPeriod      — has healthy daily-data integrations, period is just quiet → calm hint
  const noIntegrations  = !isFresh && integrationCount === 0
  const isStale         = !isFresh && integrationCount > 0 && healthyCount === 0
  const needsDailySource = !isFresh && healthyCount > 0 && healthyDailyCount === 0
  const isEmptyPeriod   = !isFresh && healthyDailyCount > 0
  const isAlarming      = noIntegrations || isStale

  async function syncNow() {
    if (syncing) return
    setSyncing(true)
    setResult(null)
    try {
      const r = await fetch('/api/sync/now', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.reason === 'no_integrations') {
        setResult({
          ok: false,
          message: j.message ?? j.error ?? 'Connect at least one integration first.',
        })
      } else {
        setResult({
          ok: true,
          message: `Synced ${j.synced_count} integration${j.synced_count === 1 ? '' : 's'} in ${Math.round((j.duration_ms ?? 0) / 1000)}s. Loading data…`,
        })
        // Give the DB a beat then reload dashboard data
        setTimeout(() => onSyncComplete(), 1500)
      }
    } catch (e: any) {
      setResult({ ok: false, message: e?.message ?? 'Sync failed — try again in a moment.' })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div style={{
      background:    isAlarming ? UXP.coral + '15' : UXP.lavFill,
      border:        `0.5px solid ${isAlarming ? UXP.coralLine : UXP.lavMid}`,
      borderRadius:  UXP.r_lg,
      padding:       '14px 18px',
      display:       'flex',
      alignItems:    'flex-start',
      gap:           14,
      boxShadow:     UXP.shadowSoft,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: isAlarming ? UXP.coral : UXP.lavText, marginBottom: 4 }}>
          {noIntegrations
            ? 'No integrations connected to this business'
            : isStale
              ? 'No data syncing for this business'
              : needsDailySource
                ? 'Connect a POS or staff system to populate this dashboard'
                : isEmptyPeriod
                  ? 'No activity recorded for this period'
                  : `Welcome${selectedBiz?.name ? `, ${selectedBiz.name}` : ''} — your data is on its way`}
        </div>
        <div style={{ fontSize: 12, color: UXP.ink2, lineHeight: 1.55 }}>
          {noIntegrations ? (
            <>
              You haven't connected any integrations to {selectedBiz?.name ?? 'this business'} yet.
              Head to <a href="/integrations" style={{ color: UXP.lavDeep, textDecoration: 'underline' }}>integrations</a> to connect Fortnox or Personalkollen so data can start flowing.
            </>
          ) : isStale ? (
            <>
              We haven't seen new data from your connected integrations in over {STALE_HOURS} hours.
              Check <a href="/integrations" style={{ color: UXP.lavDeep, textDecoration: 'underline' }}>integrations</a> for any broken connections, or click below to trigger a manual sync.
            </>
          ) : needsDailySource ? (
            <>
              Fortnox is connected and feeding monthly P&L into <a href="/financials/performance" style={{ color: UXP.lavDeep, textDecoration: 'underline' }}>Financials → Performance</a>.
              This dashboard shows daily revenue and labour, which come from your POS or staff system.
              Head to <a href="/integrations" style={{ color: UXP.lavDeep, textDecoration: 'underline' }}>integrations</a> to connect Personalkollen so the daily view fills in.
            </>
          ) : isEmptyPeriod ? (
            <>
              Your integrations are connected and synced — there just isn't any revenue or shift data recorded for this period yet.
              Try a different period using the date stepper above, or click below to pull the latest from your integrations now.
            </>
          ) : (
            <>
              Background sync runs nightly at 04:00 UTC (05:00 Stockholm) and brings in the last 90 days of Fortnox + Personalkollen data.
              Want it now? Click below — first sync takes ~30-60 seconds. While you wait, you can{' '}
              <a href="/onboarding" style={{ color: UXP.lavDeep, textDecoration: 'underline' }}>finish onboarding</a>
              {' '}or{' '}
              <a href="/integrations" style={{ color: UXP.lavDeep, textDecoration: 'underline' }}>verify your integrations</a>.
            </>
          )}
        </div>
        {result && (
          <div style={{
            marginTop: 8, padding: '6px 10px',
            background: result.ok ? UXP.greenFill : UXP.roseFill,
            color: result.ok ? UXP.greenDeep : UXP.roseText,
            border: `0.5px solid ${result.ok ? UXP.green : UXP.rose}`,
            borderRadius: 6, fontSize: 11,
          }}>
            {result.message}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={syncNow}
        disabled={syncing}
        style={{
          padding: '8px 16px', fontSize: 12, fontWeight: 500,
          background: syncing ? UXP.subtleBg : UXP.ink1,
          color: syncing ? UXP.ink3 : '#fff',
          border: 'none', borderRadius: 6,
          cursor: syncing ? 'wait' : 'pointer', fontFamily: 'inherit',
          whiteSpace: 'nowrap' as const,
        }}>
        {syncing ? 'Syncing…' : 'Sync now'}
      </button>
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
      boxShadow:     UXP.shadowSoft,
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
      boxShadow:     UXP.shadowCard,
      // CSS grid items default to `min-width: auto`, which resolves
      // to the largest descendant's min-content width. If any child
      // (e.g. the DemandOutlookStrip's 7×120px inner grid) declares a
      // min-width, it would propagate up and force this Card's grid
      // track wider than the viewport. `min-width: 0` breaks that
      // chain so an internal overflow-x:auto wrapper can actually
      // scroll without dragging the page sideways.
      minWidth:      0,
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

// One "− amount owed" row in the cash-position breakdown.
function CommitRow({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 11 }}>
      <span style={{ color: UXP.ink3 }}>{label}</span>
      <span style={{ color: UXP.coral, fontVariantNumeric: 'tabular-nums' as const }}>−{fmtKr(value)}</span>
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
