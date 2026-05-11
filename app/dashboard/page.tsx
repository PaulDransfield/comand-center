'use client'
// @ts-nocheck
// app/dashboard/page.tsx — CommandCenter main dashboard
// Week-first layout inspired by Personalkollen: KPIs → chart → dept table + P&L

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import AppShell from '@/components/AppShell'
import { OverheadReviewCard } from '@/components/OverheadReviewCard'
// OrgNumberBanner / OrgNumberGate removed in M046 — onboarding now requires
// org_number upfront, so the 30-day grace banner + lockout are dead code.
import dynamicImport from 'next/dynamic'
// AskAI is a floating button + slide-in panel — only used after the user
// clicks. Lazy-load it (FIXES §0ll) so its ~30 KB doesn't sit in this
// page's First Load JS for users who never open it. ssr:false because
// it reads localStorage at mount.
const AskAI = dynamicImport(() => import('@/components/AskAI'), { ssr: false, loading: () => null })
import OverviewChart, { PeriodOption } from '@/components/dashboard/OverviewChart'
import { getUpcomingHolidays, getHolidaysForCountry } from '@/lib/holidays'
import PageHero from '@/components/ui/PageHero'
import SupportingStats from '@/components/ui/SupportingStats'
import AttentionPanel, { AttentionItem } from '@/components/ui/AttentionPanel'
import WeatherDemandWidget from '@/components/dashboard/WeatherDemandWidget'
import DashboardHeader from '@/components/dashboard/DashboardHeader'
import DemandOutlook from '@/components/dashboard/DemandOutlook'
import RecentInvoicesFeed from '@/components/dashboard/RecentInvoicesFeed'
import CashPositionTile from '@/components/dashboard/CashPositionTile'
import Sparkline from '@/components/ui/Sparkline'
import { UX } from '@/lib/constants/tokens'
import { fmtKr, fmtPct } from '@/lib/format'

// ── Formatters ────────────────────────────────────────────────────────────────
// Format a Date as YYYY-MM-DD using local timezone (NOT UTC — avoids off-by-one in CET/CEST)
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const DAYS   = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']

// ── Week / month helpers ───────────────────────────────────────────────────────
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

function getISOWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day  = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const y1   = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - y1.getTime()) / 86400000 + 1) / 7)
}

function getWeekBounds(offset = 0) {
  const today  = new Date()
  const dow    = today.getDay()
  const mon    = new Date(today)
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

function delta(cur: number, prev: number) {
  if (!prev) return null
  const p = ((cur - prev) / prev) * 100
  return { pct: Math.round(p * 10) / 10, up: p >= 0 }
}

// ── Sub-components ────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, deltaVal, ok, href }: any) {
  const card = (
    <div style={{
      background: 'white', borderRadius: 12, padding: '18px 20px',
      border: `1px solid ${ok === false ? '#fecaca' : '#e5e7eb'}`,
      cursor: href ? 'pointer' : 'default',
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 10 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: '#111', marginBottom: 6, letterSpacing: '-0.5px' }}>{value}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 18 }}>
        {deltaVal !== null && deltaVal !== undefined && (
          <span style={{
            fontSize: 12, fontWeight: 700,
            color: deltaVal.up ? '#16a34a' : '#dc2626',
          }}>
            {deltaVal.up ? '↑' : '↓'} {Math.abs(deltaVal.pct)}%
          </span>
        )}
        {sub && <span style={{ fontSize: 12, color: '#9ca3af' }}>{sub}</span>}
      </div>
    </div>
  )
  return href ? <a href={href} style={{ textDecoration: 'none' }}>{card}</a> : card
}

// ── Main page ─────────────────────────────────────────────────────────────────
// Next 14 requires any client component using useSearchParams to sit inside a
// <Suspense> boundary or the static prerender bails out at build time.
// Shared styles for the scheduling card (predictive + retrospective modes
// use the same layout). FIXES §0ww.
const schedCardLink: React.CSSProperties = {
  display:        'flex',
  flexDirection:  'column' as const,
  justifyContent: 'space-between',
  background:     UX.cardBg,
  border:         `1px solid ${UX.border}`,
  borderLeft:     `4px solid ${UX.greenInk}`,
  borderRadius:   UX.r_lg,
  padding:        '18px 20px',
  textDecoration: 'none',
  color:          'inherit',
  cursor:         'pointer',
  transition:     'box-shadow 0.15s',
}
const schedCardEyebrow: React.CSSProperties = {
  fontSize:      10,
  fontWeight:    500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
  color:         UX.ink4,
}
const schedCardCta: React.CSSProperties = {
  marginTop:    14,
  display:      'inline-flex',
  alignItems:   'center',
  gap:          6,
  color:        UX.greenInk,
  fontSize:     13,
  fontWeight:   500,
}

// ─────────────────────────────────────────────────────────────────────────────
// Pillar card styles — shared between the labour scheduling card (inline)
// and OverheadReviewCard (separate file imports its own copy). v8 redesign:
// header strip with status pill, big 38px before/after, context paragraph,
// 3-cell mini stat row, dark CTA button.
// ─────────────────────────────────────────────────────────────────────────────
function pillarCardLink(stripe: 'green' | 'amber' | 'navy'): React.CSSProperties {
  const stripeColor =
    stripe === 'amber' ? UX.amberInk :
    stripe === 'navy'  ? UX.ink1     :
                         UX.greenInk
  return {
    background:     UX.cardBg,
    border:         `1px solid ${UX.border}`,
    borderLeft:     `4px solid ${stripeColor}`,
    borderRadius:   12,
    padding:        0,
    overflow:       'hidden' as const,
    textDecoration: 'none',
    color:          'inherit',
    cursor:         'pointer',
    transition:     'box-shadow 0.15s',
    display:        'flex',
    flexDirection:  'column' as const,
    minWidth:       0,
  }
}
const pillarHeadStyle: React.CSSProperties = {
  padding:        '18px 24px 14px',
  borderBottom:   `1px solid ${UX.borderSoft}`,
  display:        'flex',
  justifyContent: 'space-between',
  alignItems:     'center',
  gap:            8,
}
const pillarHLabelStyle: React.CSSProperties = {
  fontSize:      11,
  color:         UX.ink4,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
  fontWeight:    500,
  whiteSpace:    'nowrap' as const,
  overflow:      'hidden' as const,
  textOverflow:  'ellipsis' as const,
}
const pillarStatusStyle: React.CSSProperties = {
  fontSize:      10,
  padding:       '3px 9px',
  borderRadius:  999,
  fontWeight:    600,
  letterSpacing: '0.04em',
  whiteSpace:    'nowrap' as const,
}
const pillarBodyStyle: React.CSSProperties = {
  padding:       '18px 24px 22px',
  flex:          1,
  display:       'flex',
  flexDirection: 'column' as const,
}
const baRowStyle: React.CSSProperties = {
  display:    'flex',
  alignItems: 'baseline',
  gap:        16,
  marginBottom: 8,
  flexWrap:   'wrap' as const,
}
const baCurrentStyle: React.CSSProperties = {
  fontSize:      38,
  fontWeight:    700,
  color:         UX.ink1,
  letterSpacing: '-0.025em',
  lineHeight:    1,
}
const baArrowStyle: React.CSSProperties = {
  fontSize:   22,
  color:      UX.ink4,
  fontWeight: 300,
}
const baProjectedStyle: React.CSSProperties = {
  fontSize:      38,
  fontWeight:    700,
  color:         UX.greenInk,
  letterSpacing: '-0.025em',
  lineHeight:    1,
}
const baSuffixStyle: React.CSSProperties = {
  fontSize:   14,
  color:      UX.ink3,
  fontWeight: 500,
}
const pillarContextStyle: React.CSSProperties = {
  fontSize:    13,
  color:       UX.ink3,
  lineHeight:  1.5,
  margin:      '0 0 16px 0',
}
const pillarStrongStyle: React.CSSProperties = {
  color:      UX.ink1,
  fontWeight: 700,
}
const pillarStatsStyle: React.CSSProperties = {
  display:             'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap:                 1,
  background:          UX.borderSoft,
  border:              `1px solid ${UX.borderSoft}`,
  borderRadius:        8,
  overflow:            'hidden' as const,
  marginBottom:        18,
}
const pillarStatCellStyle: React.CSSProperties = {
  background: UX.cardBg,
  padding:    '12px 14px',
  minWidth:   0,
}
const pillarStatLabelStyle: React.CSSProperties = {
  fontSize:      10,
  color:         UX.ink4,
  letterSpacing: '0.06em',
  textTransform: 'uppercase' as const,
  fontWeight:    500,
  marginBottom:  4,
}
const pillarStatValueStyle: React.CSSProperties = {
  fontSize:      16,
  fontWeight:    700,
  color:         UX.ink1,
  letterSpacing: '-0.01em',
  whiteSpace:    'nowrap' as const,
  overflow:      'hidden' as const,
  textOverflow:  'ellipsis' as const,
}
const pillarCtaStyle: React.CSSProperties = {
  background:   UX.ink1,
  color:        'white',
  border:       'none',
  padding:      '11px 22px',
  borderRadius: 999,
  fontSize:     13,
  fontWeight:   600,
  cursor:       'pointer',
  fontFamily:   'inherit',
  display:      'inline-flex',
  alignItems:   'center',
  gap:          8,
  alignSelf:    'flex-start',
  marginTop:    'auto',
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardLoadingFallback />}>
      <DashboardInner />
    </Suspense>
  )
}

function DashboardLoadingFallback() {
  const tCommon = useTranslations('common')
  return (
    <div style={{ padding: 60, textAlign: 'center' as const, color: '#9ca3af' }}>
      {tCommon('state.loading')}
    </div>
  )
}

function DashboardInner() {
  const tDash    = useTranslations('dashboard')
  const tCommon  = useTranslations('common')
  // Localised short month/day arrays, sourced from common.json.
  // MONTHS/DAYS at module scope stay in English — they're used by the
  // bounds helpers to build YYYY-MM-DD strings and labels we recompute
  // here for display. Anything user-visible passes through these.
  const monthsLocal = (tCommon.raw('time.monthsShort') as string[]) ?? MONTHS
  // Build a localised label from a bounds object — week or month — using
  // the same shape as getWeekBounds/getMonthBounds but with translated
  // month names.
  function formatMonthLabel(b: { year: number; month?: number; firstDay?: Date }): string {
    const idx = b.month ? b.month - 1 : (b.firstDay?.getMonth() ?? 0)
    return `${monthsLocal[idx]} ${b.year}`
  }
  function formatWeekRange(b: { mon: Date; year: number }): string {
    const sun = new Date(b.mon)
    sun.setDate(b.mon.getDate() + 6)
    const mMon = monthsLocal[b.mon.getMonth()]
    const sMon = monthsLocal[sun.getMonth()]
    return mMon === sMon
      ? `${b.mon.getDate()}–${sun.getDate()} ${mMon}`
      : `${b.mon.getDate()} ${mMon} – ${sun.getDate()} ${sMon}`
  }
  const [businesses,  setBusinesses]  = useState<any[]>([])
  const [bizId,       setBizId]       = useState<string | null>(null)
  const [dataAsOf,    setDataAsOf]    = useState<string | null>(null)
  const [weekOffset,  setWeekOffset]  = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  const [viewMode,    setViewMode]    = useState<'week'|'month'>('week')
  const [dailyRows,   setDailyRows]   = useState<any[]>([])
  const [currSummary, setCurrSummary] = useState<any>(null)
  const [prevSummary, setPrevSummary] = useState<any>(null)
  const [depts,       setDepts]       = useState<any>(null)
  const [alerts,      setAlerts]      = useState<any[]>([])
  const [loading,     setLoading]     = useState(true)
  const [showUpgrade, setShowUpgrade] = useState(false)
  const [upgradePlan, setUpgradePlan] = useState('')
  const [aiSched,     setAiSched]     = useState<any>(null)
  const [overheadProj, setOverheadProj] = useState<any>(null)
  // Previous-period daily_metrics rows — used for per-day "Prev" whiskers
  // + per-day deltas in the OverviewChart.
  const [prevDailyRows, setPrevDailyRows] = useState<any[]>([])

  // URL-param-controlled chart state. OverviewChart reads these and calls
  // back when the user interacts; we persist into the URL so refreshes and
  // shared links keep the same view. Kept in state too for instant render.
  const router       = useRouter()
  const searchParams = useSearchParams()
  const [selectedDates, setSelectedDates] = useState<string[]>([])
  const [compareMode,   setCompareMode]   = useState<'none'|'prev'|'ai'>('ai')

  // Upgrade banner on Stripe redirect
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    if (p.get('upgrade') === 'success') {
      setUpgradePlan(p.get('plan') ?? '')
      setShowUpgrade(true)
      setTimeout(() => setShowUpgrade(false), 8000)
    }
  }, [])

  // ── Hydrate chart controls from URL on first render ──────────────────────
  useEffect(() => {
    const v   = searchParams?.get('view')   as 'week' | 'month' | null
    const off = searchParams?.get('offset')
    const cmp = searchParams?.get('cmp')    as 'none' | 'prev' | 'ai' | null
    const d   = searchParams?.get('days')
    if (v === 'week' || v === 'month') setViewMode(v)
    if (off != null && !Number.isNaN(Number(off))) {
      if (v === 'month') setMonthOffset(Number(off))
      else               setWeekOffset(Number(off))
    }
    if (cmp === 'none' || cmp === 'prev' || cmp === 'ai') setCompareMode(cmp)
    if (d) setSelectedDates(d.split(',').filter(Boolean))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Helper — write the current control set back to the URL without dropping
  // the user at the top of the page. Uses history.replaceState so the URL
  // updates but Next.js doesn't trigger a full rerender.
  function writeUrl(next: { view?: string; offset?: number; cmp?: string; days?: string[] }) {
    const p = new URLSearchParams()
    const v   = next.view   ?? viewMode
    const off = next.offset ?? (v === 'month' ? monthOffset : weekOffset)
    const cmp = next.cmp    ?? compareMode
    const d   = next.days   ?? selectedDates
    if (v !== 'week') p.set('view', v)
    if (off !== 0)    p.set('offset', String(off))
    if (cmp !== 'ai') p.set('cmp', cmp)
    if (d.length)     p.set('days', d.join(','))
    const qs = p.toString()
    const path = window.location.pathname + (qs ? `?${qs}` : '')
    window.history.replaceState(null, '', path)
  }

  // Load businesses + restore selection
  useEffect(() => {
    fetch('/api/businesses').then(r => r.json()).then((data: any[]) => {
      if (!Array.isArray(data) || !data.length) return
      setBusinesses(data)
      const saved = localStorage.getItem('cc_selected_biz')
      const biz   = (saved && data.find((b: any) => b.id === saved)) ? saved : data[0].id
      setBizId(biz)
      localStorage.setItem('cc_selected_biz', biz)
    }).catch(() => {})
    window.addEventListener('storage', () => {
      const s = localStorage.getItem('cc_selected_biz')
      if (s) setBizId(s)
    })
  }, [])

  // AI prediction for the selected period — fills future days on the chart
  // (this-week remainder, or a future week/month). Skipped entirely for past
  // periods since we already have actuals for every day.
  useEffect(() => {
    if (!bizId) { setAiSched(null); return }
    const period = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
    const todayIso = localDate(new Date())
    // No predictions needed if the entire period is in the past.
    if (period.to < todayIso) { setAiSched(null); return }
    let cancelled = false
    const qs = `business_id=${bizId}&from=${period.from}&to=${period.to}`
    fetch(`/api/scheduling/ai-suggestion?${qs}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (!cancelled && j && !j.error) setAiSched(j) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [bizId, viewMode, weekOffset, monthOffset])

  // FIXES §0ap: overhead-review projection. Independent of view mode —
  // always reads current calendar month since flags are tied to Fortnox
  // upload periods, not the dashboard's week/month nav.
  useEffect(() => {
    if (!bizId) { setOverheadProj(null); return }
    let cancelled = false
    fetch(`/api/overheads/projection?business_id=${bizId}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (!cancelled && j && !j.error) setOverheadProj(j) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [bizId])

  // Load data whenever biz, period, or view changes
  useEffect(() => {
    if (!bizId) return
    setLoading(true)
    setDailyRows([])
    setCurrSummary(null)
    setPrevSummary(null)
    setDepts(null)

    const biz  = `business_id=${bizId}`

    const curr = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
    const prev = viewMode === 'week' ? getWeekBounds(weekOffset - 1) : getMonthBounds(monthOffset - 1)

    // FIXES §0bb (Sprint 1.5): the four endpoints below now return
    // Cache-Control: private, max-age=15, stale-while-revalidate=60.
    // Browser handles bounded freshness — back-button + tab-switch are
    // instant, worst-case staleness window is 15s (shorter than any
    // aggregator-run cycle). cache: 'no-store' on the client would
    // override the server header, so it's removed here.
    Promise.all([
      // Pre-computed daily metrics (reads from summary tables)
      fetch(`/api/metrics/daily?from=${curr.from}&to=${curr.to}&${biz}`).then(r => r.json()).catch(() => ({})),
      fetch(`/api/metrics/daily?from=${prev.from}&to=${prev.to}&${biz}`).then(r => r.json()).catch(() => ({})),
      // Departments (still reads from raw tables — has per-dept breakdown)
      fetch(`/api/departments?from=${curr.from}&to=${curr.to}&${biz}`).then(r => r.json()).catch(() => ({})),
      fetch('/api/alerts').then(r => r.json()).catch(() => []),
    ]).then(([curr_, prev_, deptRes, alertRes]) => {
      // Map daily_metrics field names to what the dashboard expects
      const rows = (curr_.rows ?? []).map((r: any) => ({ ...r, staff_pct: r.labour_pct }))
      setDailyRows(rows)
      setCurrSummary(curr_.summary ?? null)
      setPrevSummary(prev_.summary ?? null)
      setPrevDailyRows(prev_.rows ?? [])
      setDepts(deptRes ?? null)
      setAlerts(Array.isArray(alertRes) ? alertRes : [])
      setLoading(false)
      // Track the freshest date in loaded rows for the stale-data banner
      const latest = rows.reduce((m: string, r: any) => r.date > m ? r.date : m, '')
      setDataAsOf(latest || null)
    })
  }, [bizId, weekOffset, monthOffset, viewMode])

  // ── Derived values (week mode) ──────────────────────────────────────────────
  const curr        = getWeekBounds(weekOffset)
  const totalRev    = dailyRows.reduce((s, r) => s + r.revenue,    0)
  const totalLabour = dailyRows.reduce((s, r) => s + r.staff_cost, 0)
  const labourPct   = totalRev > 0 ? (totalLabour / totalRev) * 100 : 0
  const totalHours  = depts?.summary?.total_hours ?? 0
  const revPerHour  = totalHours > 0 ? totalRev / totalHours : 0

  const prevRev     = prevSummary?.total_revenue    ?? 0
  const prevLabour  = prevSummary?.total_staff_cost ?? 0
  const prevLabPct  = prevRev > 0 && prevLabour > 0 ? (prevLabour / prevRev) * 100 : null

  // ── Derived values (shared) ─────────────────────────────────────────────────
  const now = new Date()
  const currM = getMonthBounds(monthOffset)

  // ── AI prediction lookup ────────────────────────────────────────────────────
  // Keyed by date (YYYY-MM-DD). Populated for next week if the AI suggestion
  // fetch succeeded. Used to fill future bars on the chart + tooltip.
  const predByDate: Record<string, any> = {}
  if (aiSched?.suggested) {
    for (const s of aiSched.suggested) {
      const c = aiSched.current?.find((x: any) => x.date === s.date)
      predByDate[s.date] = {
        est_revenue:  s.est_revenue,
        planned_cost: c?.est_cost ?? 0,
        ai_cost:      s.est_cost,
        delta_cost:   s.delta_cost,
        weather:      s.weather,
        bucket_days:  s.bucket_days_seen,
        under_staffed_note: s.under_staffed_note,
      }
    }
  }

  // Map WMO code → emoji for the bar overlay. Kept terse — owner just needs
  // "will it rain" at a glance, not a meteorological read.
  const weatherIcon = (code?: number): string => {
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

  // ── Build day grid — 7 days (week) or full month ───────────────────────────
  // Each day gets a matching `prevDay` — same weekday-index offset in the
  // previous period. Lets the chart render per-day "Prev" whiskers / deltas
  // without another fetch.
  // FIXES §0xx (2026-04-28): track hasActualData + isClosed per day so the
  // chart can distinguish CLOSED past days from FUTURE days. Both have
  // revenue=0; without this distinction the gross-margin line falls
  // through to predicted values for closed days (Apr 3-4 of any month
  // showed phantom 100k+ gross). Closed = past day with no daily_metrics
  // row at all (the aggregator only writes rows when there's revenue or
  // staff_cost > 0). Today gets a grace pass — PK might not have synced
  // yet — so isClosed = !isFuture && !isToday && !hasActualData.
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d   = new Date(curr.mon)
    d.setDate(curr.mon.getDate() + i)
    const ds  = localDate(d)
    const found = dailyRows.find(r => r.date === ds)
    const row = found ?? { date: ds, revenue: 0, staff_cost: 0, staff_pct: null }
    const isToday   = ds === localDate(now)
    const isFuture  = d > now
    const hasActualData = !!found
    const isClosed  = !isFuture && !isToday && !hasActualData
    const pred      = predByDate[ds] ?? null
    // Matching day one week earlier
    const prev = getWeekBounds(weekOffset - 1)
    const pd   = new Date(prev.mon); pd.setDate(prev.mon.getDate() + i)
    const pds  = localDate(pd)
    const pRow = prevDailyRows.find(r => r.date === pds)
    const prevDay = pRow ? { revenue: pRow.revenue ?? 0, staff_cost: pRow.staff_cost ?? 0 } : null
    return { ...row, dayName: DAYS[i], dateStr: ds, isToday, isFuture, hasActualData, isClosed, pred, prevDay }
  })

  const monthDays = Array.from({ length: currM.daysInMonth }, (_, i) => {
    const d   = new Date(currM.firstDay)
    d.setDate(i + 1)
    const ds  = localDate(d)
    const found = dailyRows.find(r => r.date === ds)
    const row = found ?? { date: ds, revenue: 0, staff_cost: 0, staff_pct: null }
    const isToday  = ds === localDate(now)
    const isFuture = d > now
    const hasActualData = !!found
    const isClosed  = !isFuture && !isToday && !hasActualData
    const dayIdx   = (d.getDay() + 6) % 7 // 0=Mon
    const pred     = predByDate[ds] ?? null
    // Matching day in previous month (same calendar day; last day if prev is shorter)
    const prevM  = getMonthBounds(monthOffset - 1)
    const prevLastDom = new Date(prevM.firstDay.getFullYear(), prevM.firstDay.getMonth() + 1, 0).getDate()
    const prevDom = Math.min(i + 1, prevLastDom)
    const prevDate = `${prevM.year}-${String(prevM.month).padStart(2, '0')}-${String(prevDom).padStart(2, '0')}`
    const pRow = prevDailyRows.find(r => r.date === prevDate)
    const prevDay = pRow ? { revenue: pRow.revenue ?? 0, staff_cost: pRow.staff_cost ?? 0 } : null
    return { ...row, dayName: String(i + 1), dateStr: ds, isToday, isFuture, hasActualData, isClosed, dayIdx, pred, prevDay }
  })


  // ── Available periods for the chart's dropdown ──────────────────────────
  // 6 past + current = 7 weeks, and 6 past + current = 7 months. Offsets
  // captured in the key so onPeriodChange can restore exact state.
  const availablePeriods: PeriodOption[] = useMemo(() => {
    const out: PeriodOption[] = []
    for (let off = 0; off >= -6; off--) {
      const w = getWeekBounds(off)
      out.push({
        key: `w:${off}`,
        label: tDash('period.weekLabel', { num: w.weekNum, range: formatWeekRange(w) }),
        view: 'week',
        dateFrom: w.from,
        dateTo: w.to,
      })
    }
    for (let off = 0; off >= -6; off--) {
      const m = getMonthBounds(off)
      out.push({
        key: `m:${off}`,
        label: formatMonthLabel(m),
        view: 'month',
        dateFrom: m.from,
        dateTo: m.to,
      })
    }
    return out
  // monthsLocal changes per locale, so include tDash to refresh labels.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tDash])

  function handlePeriodChange(key: string) {
    const [kind, offStr] = key.split(':')
    const off = Number(offStr)
    if (kind === 'w') {
      setViewMode('week')
      setWeekOffset(off)
      writeUrl({ view: 'week', offset: off })
    } else if (kind === 'm') {
      setViewMode('month')
      setMonthOffset(off)
      writeUrl({ view: 'month', offset: off })
    }
  }
  function handleViewModeChange(v: 'week'|'month') {
    setViewMode(v)
    writeUrl({ view: v, offset: v === 'month' ? monthOffset : weekOffset })
  }
  function handleCompareChange(m: 'none'|'prev'|'ai') {
    setCompareMode(m)
    writeUrl({ cmp: m })
  }
  function handleSelectedDatesChange(next: string[]) {
    setSelectedDates(next)
    writeUrl({ days: next })
  }
  // Scaffold for future click-to-drill — route doesn't exist yet, so no-op
  // until /dashboard/day/[date] ships.
  function handleDayClick(day: any) {
    // router.push(`/dashboard/day/${day.date}`)  // enable when route exists
  }

  const selectedBiz = businesses.find(b => b.id === bizId)
  const targetPct   = (selectedBiz as any)?.target_staff_pct ?? 35

  // Holiday set spanning the visible week + month windows so the chart
  // can colour the X-axis labels red (alongside Sat/Sun). Cheap pure
  // compute via lib/holidays — no fetch, no DB. Country comes from the
  // selected business; defaults to 'SE' if not yet set. Sits below
  // selectedBiz because the lookup depends on it.
  const holidayDateSet = useMemo(() => {
    const set = new Set<string>()
    try {
      const country = (selectedBiz as any)?.country ?? 'SE'
      const wkStart = weekDays[0]?.date ?? curr.from
      const wkEnd   = weekDays[weekDays.length - 1]?.date ?? curr.to
      const mStart  = monthDays[0]?.date ?? `${currM.year}-${String(currM.month).padStart(2,'0')}-01`
      const mEnd    = monthDays[monthDays.length - 1]?.date ?? mStart
      const earliest = wkStart < mStart ? wkStart : mStart
      const latest   = wkEnd   > mEnd   ? wkEnd   : mEnd
      const years = new Set<number>([
        Number(earliest.slice(0, 4)),
        Number(latest.slice(0, 4)),
      ])
      for (const y of years) {
        for (const h of getHolidaysForCountry(country, y)) {
          if (h.date >= earliest && h.date <= latest) set.add(h.date)
        }
      }
    } catch { /* never block chart render on holiday lookup */ }
    return set
  }, [selectedBiz, weekDays, monthDays, curr, currM])

  return (
    <AppShell>
      <div className="page-wrap">

        {/* ── Upgrade banner ──────────────────────────────────────────────── */}
        {showUpgrade && (
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 12, padding: '14px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 20 }}>🎉</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#15803d' }}>
                  {upgradePlan
                    ? tDash('upgrade.title', { plan: upgradePlan })
                    : tDash('upgrade.titleNoPlan')}
                </div>
                <div style={{ fontSize: 12, color: '#4b7c59' }}>{tDash('upgrade.subtitle')}</div>
              </div>
            </div>
            <button onClick={() => setShowUpgrade(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#15803d', fontSize: 20 }}>×</button>
          </div>
        )}

        {/* Stale data warning — shown when the freshest loaded row is before
            yesterday, meaning the hourly catchup hasn't synced recent sales.
            FIXES §0vv (2026-04-28): only trigger when viewing the CURRENT
            period. Without this gate, navigating to last week / last month
            falsely flags the data as stale because the displayed period's
            data is legitimately N days old by definition. */}
        {(() => {
          if (!dataAsOf || loading) return null
          const isCurrentPeriod = (viewMode === 'week' && weekOffset === 0) || (viewMode === 'month' && monthOffset === 0)
          if (!isCurrentPeriod) return null
          const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
          if (dataAsOf >= yesterday) return null
          const daysOld = Math.floor((Date.now() - new Date(dataAsOf + 'T23:59:59Z').getTime()) / 86_400_000)
          return (
            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '12px 16px', marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontSize: 13, color: '#92400e' }}>
                <strong>{daysOld === 1 ? tDash('stale.yesterday') : tDash('stale.daysAgo', { days: daysOld })}</strong> — {tDash('stale.instruction')}
              </div>
            </div>
          )
        })()}

        {/* Outer header removed in Phase 1 — the business selector is now in
            the sidebar (SidebarV2) and the period navigator + W/M toggle are
            inside OverviewChart's own control row. Keeping both would be the
            exact duplication the redesign is trying to eliminate. */}

        {/* ── Dashboard header — replaces the legacy yellow alert banner.
              Pulses a small anomaly pill linking to /alerts; same filter
              the banner used (severity high/critical, top row only). */}
        <DashboardHeader
          breadcrumb={tDash('header.breadcrumb', { biz: selectedBiz?.name ?? '' })}
          pageTitle={tDash('header.title')}
          alerts={alerts as any[]}
        />

        {/* ─── PageHero + chart + supporting row ─────────────────────────────
            One consolidated view for both week and month — the chart's own
            W/M toggle drives viewMode state, so a single render path serves
            both. Spec: DESIGN.md § 1. Overview. */}
        {loading ? (
          <div style={{ padding: 80, textAlign: 'center' as const, color: UX.ink4, fontSize: UX.fsBody }}>{tCommon('state.loading')}</div>
        ) : (
          <>
            {/* Demand outlook — moved to top of dashboard so the 7-day
                forward view (weather × holidays × AI sales pattern) sets
                context BEFORE the retrospective week/month numbers. The
                widget fetches its own data so it can render before
                anything else is computed. */}
            <DemandOutlook
              bizId={bizId}
              cutHoursByDate={(() => {
                const map: Record<string, number> = {}
                if (aiSched?.suggested) {
                  for (const s of aiSched.suggested) {
                    if (typeof s.delta_hours === 'number') map[s.date] = s.delta_hours
                  }
                }
                return map
              })()}
            />

            {/*
              FIXES §0tt (2026-04-28): top-of-dashboard split — week summary
              (left) sits next to AI scheduling savings card (right).
              When AI has no saving (saving_kr <= 0) the right slot is null
              and OverviewHero takes the full grid width via grid-column.
              On narrow viewports the grid wraps to a single column.
            */}
            {(() => {
              // Labour-ratio scheduling card. Two modes:
              //   1. Current period + AI recommendation → predictive shift
              //      (e.g. 47% → 35%, save X kr)
              //   2. Past period → retrospective (labour was X% of Y%
              //      target — could have saved Z kr by hitting target)
              // Card always renders so the user has continuity across
              // period navigation. FIXES §0ww (2026-04-28).
              const isCurrentPeriod = (viewMode === 'week' && weekOffset === 0) || (viewMode === 'month' && monthOffset === 0)
              const aiSaving = Number(aiSched?.summary?.saving_kr ?? 0)
              const aiCutH   = Number(aiSched?.summary?.current_hours ?? 0) - Number(aiSched?.summary?.suggested_hours ?? 0)
              const sugg     = (aiSched?.suggested as any[] | undefined) ?? []
              const cur      = (aiSched?.current   as any[] | undefined) ?? []
              const weekRev  = sugg.reduce((s, r) => s + Number(r.est_revenue ?? 0), 0)
              const weekCur  = cur.reduce((s, r) => s + Number(r.est_cost ?? 0), 0)
              const weekAi   = sugg.reduce((s, r) => s + Number(r.est_cost ?? 0), 0)
              const curPct   = weekRev > 0 ? (weekCur / weekRev) * 100 : null
              const aiPct    = weekRev > 0 ? (weekAi  / weekRev) * 100 : null
              const hasPredictive = isCurrentPeriod && aiSaving > 0 && curPct != null && aiPct != null
              // Retrospective metrics — actual labour for the displayed
              // period (already computed for OverviewHero). We only show
              // the retrospective card when there's actual revenue;
              // closed/empty periods get nothing.
              const hasRetrospective = !hasPredictive && totalRev > 0 && labourPct > 0
              // FIXES §0ap: overhead-review card sits alongside the labour
              // card in the right rail. Show only when there's a pending
              // queue + non-zero savings (no point telling the owner about
              // 0 kr potential — they'd ignore it).
              const hasOverheadCard = !!overheadProj
                && Number(overheadProj?.pending_count ?? 0) > 0
                && Number(overheadProj?.savings?.total_sek ?? 0) > 0
              return (
                // FIXES §0aw: 3-column auto-fit grid so hero + labour + overhead
                // cards sit as equal-size siblings instead of one wide hero +
                // a tall right rail. minmax(280px, 1fr) wraps to 2-col then
                // 1-col on narrower viewports.
                <div style={{
                  display:             'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                  gap:                 12,
                  alignItems:          'stretch',
                  marginBottom:        12,
                }}>
                  <OverviewHero
                    viewMode={viewMode}
                    curr={curr}
                    currM={currM}
                    currLabel={formatMonthLabel(currM)}
                    weekRangeLabel={formatWeekRange(curr)}
                    totalRev={totalRev}
                    totalLabour={totalLabour}
                    prevRev={prevRev}
                    prevLabour={prevLabour}
                    totalHours={totalHours}
                    revPerHour={revPerHour}
                    labourPct={labourPct}
                    targetPct={targetPct}
                    aiSaving={aiSaving}
                    fmtKr={fmtKr}
                    fmtPct={fmtPct}
                  />

                  {hasPredictive && (() => {
                    // Days flagged = days where AI proposes a cut
                    // (delta_cost < 0). Total days in window for the
                    // "N of M" context.
                    const flaggedDays = sugg.filter((s: any) => Number(s.delta_cost ?? 0) < 0).length
                    return (
                      <a
                        href="/scheduling"
                        style={pillarCardLink('green')}
                        onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.06)')}
                        onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
                      >
                        <div style={pillarHeadStyle}>
                          <span style={pillarHLabelStyle}>{tDash('labour.predictiveEyebrow')}</span>
                          <span style={{ ...pillarStatusStyle, background: UX.greenBg, color: UX.greenInk }}>
                            {tDash('labour.statusReady')}
                          </span>
                        </div>

                        <div style={pillarBodyStyle}>
                          <div style={baRowStyle}>
                            <span style={{ ...baCurrentStyle, color: UX.amberInk }}>{Math.round(curPct!)}%</span>
                            <span style={baArrowStyle}>→</span>
                            <span style={baProjectedStyle}>{Math.round(aiPct!)}%</span>
                            <span style={baSuffixStyle}>{tDash('labour.ofRevenue')}</span>
                          </div>

                          <p style={pillarContextStyle}>
                            {tDash.rich('labour.contextRich', {
                              curr:   Math.round(curPct!),
                              ai:     Math.round(aiPct!),
                              strong: (chunks: any) => <strong style={pillarStrongStyle}>{chunks}</strong>,
                            })}
                          </p>

                          <div style={pillarStatsStyle}>
                            <div style={pillarStatCellStyle}>
                              <div style={pillarStatLabelStyle}>{tDash('labour.statSaves')}</div>
                              <div style={{ ...pillarStatValueStyle, color: UX.greenInk }}>{fmtKr(aiSaving)}</div>
                            </div>
                            <div style={pillarStatCellStyle}>
                              <div style={pillarStatLabelStyle}>{tDash('labour.statHoursCut')}</div>
                              <div style={pillarStatValueStyle}>
                                {aiCutH > 0.05 ? `−${(Math.round(aiCutH * 10) / 10).toFixed(1)}h` : '—'}
                              </div>
                            </div>
                            <div style={pillarStatCellStyle}>
                              <div style={pillarStatLabelStyle}>{tDash('labour.statDaysFlagged')}</div>
                              <div style={pillarStatValueStyle}>
                                {flaggedDays} of {sugg.length || 7}
                              </div>
                            </div>
                          </div>

                          {/* Cosmetic CTA — parent anchor handles navigation. */}
                          <span style={{ ...pillarCtaStyle, background: UX.greenInk }}>
                            {tDash('labour.openScheduling')} <span aria-hidden style={{ fontSize: 14 }}>→</span>
                          </span>
                        </div>
                      </a>
                    )
                  })()}

                  {hasRetrospective && (() => {
                    const periodLabel = viewMode === 'week'
                      ? tDash('period.weekLabel', { num: curr.weekNum, range: formatWeekRange(curr) }).split(' · ')[0].toUpperCase()
                      : formatMonthLabel(currM).toUpperCase()
                    const onTarget   = labourPct <= targetPct
                    const targetCost = totalRev * (targetPct / 100)
                    const couldSave  = Math.max(0, totalLabour - targetCost)
                    const stripe: 'green' | 'amber' = onTarget ? 'green' : 'amber'
                    const accent     = onTarget ? UX.greenInk : UX.amberInk
                    return (
                      <a
                        href="/scheduling"
                        style={pillarCardLink(stripe)}
                        onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.06)')}
                        onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
                      >
                        <div style={pillarHeadStyle}>
                          <span style={pillarHLabelStyle}>{tDash('labour.retroEyebrow', { period: periodLabel })}</span>
                          <span style={{
                            ...pillarStatusStyle,
                            background: onTarget ? UX.greenBg : UX.amberBg,
                            color:      accent,
                          }}>
                            {onTarget ? tDash('labour.statusOnTarget') : tDash('labour.statusOver')}
                          </span>
                        </div>

                        <div style={pillarBodyStyle}>
                          <div style={baRowStyle}>
                            <span style={{ ...baCurrentStyle, color: accent }}>{Math.round(labourPct)}%</span>
                            <span style={baSuffixStyle}>{tDash('labour.retroVsTarget', { target: Math.round(targetPct) })}</span>
                          </div>

                          <p style={pillarContextStyle}>
                            {onTarget
                              ? tDash('labour.retroOnTarget')
                              : tDash('labour.retroOver', { pp: Math.round(labourPct - targetPct) })}
                          </p>

                          <div style={pillarStatsStyle}>
                            <div style={pillarStatCellStyle}>
                              <div style={pillarStatLabelStyle}>{tDash('labour.statActual')}</div>
                              <div style={pillarStatValueStyle}>{fmtKr(totalLabour)}</div>
                            </div>
                            <div style={pillarStatCellStyle}>
                              <div style={pillarStatLabelStyle}>{tDash('labour.statTargetCost')}</div>
                              <div style={pillarStatValueStyle}>{fmtKr(targetCost)}</div>
                            </div>
                            <div style={pillarStatCellStyle}>
                              <div style={pillarStatLabelStyle}>{onTarget ? tDash('labour.statSurplus') : tDash('labour.statMissed')}</div>
                              <div style={{ ...pillarStatValueStyle, color: onTarget ? UX.greenInk : UX.redInk }}>
                                {onTarget ? '—' : fmtKr(couldSave)}
                              </div>
                            </div>
                          </div>

                          {/* Cosmetic CTA — parent anchor handles navigation. */}
                          <span style={{ ...pillarCtaStyle, background: UX.ink1 }}>
                            {tDash('labour.openScheduling')} <span aria-hidden style={{ fontSize: 14 }}>→</span>
                          </span>
                        </div>
                      </a>
                    )
                  })()}

                  {hasOverheadCard && <OverheadReviewCard data={overheadProj} />}
                </div>
              )
            })()}

            {/* Four-stat strip on the chart header — Revenue / Labour /
                Labour margin / Covers. Lives ABOVE the chart card so the
                chart's own controls stay clean. Numbers come from
                already-loaded daily summary; covers is newly consumed
                (already in `summary.total_covers`, just unread before). */}
            <ChartHeaderStrip
              viewMode={viewMode}
              periodLabel={viewMode === 'week'
                ? tDash('period.weekLabel', { num: curr.weekNum, range: formatWeekRange(curr) })
                : formatMonthLabel(currM)}
              totalRev={totalRev}
              totalLabour={totalLabour}
              labourPct={labourPct}
              covers={Number(currSummary?.total_covers ?? 0)}
              prevRev={prevRev}
              prevLabPct={prevLabPct}
              fmtKr={fmtKr}
              fmtPct={fmtPct}
            />

            <OverviewChart
              days={viewMode === 'week' ? weekDays : monthDays}
              viewMode={viewMode}
              onViewModeChange={handleViewModeChange}
              periodLabel={viewMode === 'week'
                ? tDash('period.weekLabel', { num: curr.weekNum, range: formatWeekRange(curr) })
                : formatMonthLabel(currM)}
              businessName={selectedBiz?.name ?? ''}
              targetLabourPct={targetPct}
              availablePeriods={availablePeriods}
              onPeriodChange={handlePeriodChange}
              onDayClick={handleDayClick}
              selectedDates={selectedDates}
              onSelectedDatesChange={handleSelectedDatesChange}
              compareMode={compareMode}
              onCompareChange={handleCompareChange}
              fmtKr={fmtKr}
              fmtPct={fmtPct}
              holidayDates={holidayDateSet}
              /* v8 cleaner-chart: no inline anomaly callout. The page-
                 header pill (DashboardHeader above) is the single alert
                 surface; the chart stays clean for revenue / labour
                 reading. */
            />

            {/* Two chart footer notes — honesty about how to read the chart.
                Stack to single column at <880px. */}
            <div className="cc-chart-footer-notes" style={chartFooterNotesStyle}>
              <div style={chartFooterNoteStyle}>
                <strong style={{ color: UX.ink3 }}>{tDash('chart.notes.dayRatioTitle')}</strong>
                {' '}— {tDash('chart.notes.dayRatioBody')}
              </div>
              <div style={chartFooterNoteStyle}>
                <strong style={{ color: UX.ink3 }}>{tDash('chart.notes.readingTitle')}</strong>
                {' '}{tDash('chart.notes.readingBody')}
              </div>
              <style>{`
                @media (max-width: 880px) {
                  .cc-chart-footer-notes { grid-template-columns: 1fr !important; }
                }
              `}</style>
            </div>

            {/* Phase 5 cash visibility — net bank movement derived from
                BAS 1910-1979 voucher activity (data we already had but were
                throwing away). Honest about not being an absolute balance.
                Soft-fails when Fortnox isn't bank-linked. */}
            {bizId && (
              <div style={{ marginTop: 8 }}>
                <CashPositionTile businessId={bizId} />
              </div>
            )}

            {/* Recent invoices — operational view of supplier costs landing
                in Fortnox day-by-day. Independent of period closure status,
                so this stays useful even when April/May 2026 P&L numbers
                aren't yet booked. Pairs with the M062 provisional flag:
                P&L pages hide partial months; this widget shows what's
                actually flowing in. */}
            <RecentInvoicesFeed businessId={bizId} days={14} maxRows={20} />

            {/* Compact horizontal attention strip — was a right-rail card,
                now a single-row footer with horizontally-scrolling items.
                DepartmentsSummary removed entirely; the /departments route
                still works for direct navigation. */}
            <CompactAttentionStrip
              items={buildAttentionItems({
                depts: depts?.departments ?? [],
                aiSaving: aiSched?.summary?.saving_kr ?? 0,
                targetPct,
                labourPct,
                totalRev,
                country: (selectedBiz as any)?.country ?? 'SE',
                t: tDash,
                tCommon,
              })}
            />

          </>
        )}

      </div>

      <AskAI
        page="dashboard"
        context={selectedBiz ? [
          `Business: ${selectedBiz.name}`,
          viewMode === 'week'
            ? `Week ${curr.weekNum} (${curr.label}): revenue ${fmtKr(totalRev)}, labour cost ${fmtKr(totalLabour)} (${totalRev > 0 ? fmtPct(labourPct) : '—'}), ${Math.round(totalHours)}h`
            : `${currM.label}: revenue ${fmtKr(totalRev)}, labour cost ${fmtKr(totalLabour)} (${totalRev > 0 ? fmtPct(labourPct) : '—'}), ${Math.round(totalHours)}h`,
          depts?.summary ? `Departments: ${(depts.departments ?? []).map((d: any) => `${d.name} ${d.revenue > 0 ? fmtKr(d.revenue) : 'no revenue'}`).join(', ')}` : '',
        ].filter(Boolean).join('\n') : 'No business selected'}
      />
    </AppShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// OverviewHero — PageHero wrapping the redesigned Overview-page introduction.
// Single-sentence headline answering "am I trading ahead this week?", inline
// coloured delta, SupportingStats in the right slot.
// ─────────────────────────────────────────────────────────────────────────────
function OverviewHero({
  viewMode, curr, currM,
  currLabel, weekRangeLabel,
  totalRev, totalLabour, prevRev, prevLabour,
  totalHours, revPerHour,
  labourPct, targetPct,
  aiSaving,
  fmtKr, fmtPct,
}: any) {
  const tDash   = useTranslations('dashboard')
  const isWeek  = viewMode === 'week'
  const eyebrow = isWeek
    ? tDash('hero.eyebrowWeek',  { label: (weekRangeLabel ?? '').toUpperCase() })
    : tDash('hero.eyebrowMonth', { label: (currLabel ?? '').toUpperCase() })

  const revDelta = prevRev > 0 ? ((totalRev - prevRev) / prevRev) * 100 : null
  const margin   = Math.max(0, totalRev - totalLabour)

  // Tone the headline number on revenue movement.
  const revTone =
    revDelta == null ? UX.ink2 :
    revDelta >= 0    ? UX.greenInk :
                       UX.redInk
  const revArrow = revDelta == null ? '' : revDelta >= 0 ? '↑' : '↓'
  const revPct   = revDelta == null ? null : Math.abs(Math.round(revDelta * 10) / 10)

  const labourState: 'lean' | 'tight' | 'hot' | 'unknown' =
    totalRev <= 0 || labourPct == null ? 'unknown'
    : labourPct <= targetPct           ? 'lean'
    : labourPct <= targetPct + 5       ? 'tight'
    :                                    'hot'
  const labourColor =
    labourState === 'lean'  ? UX.greenInk :
    labourState === 'tight' ? UX.amberInk :
    labourState === 'hot'   ? UX.redInk :
                              UX.ink2

  // Body sentence — single line, mirrors the labour/overhead card body.
  const body = (() => {
    if (totalRev <= 0) return <>{tDash('hero.waiting')}</>
    if (revDelta != null) {
      const ref = isWeek ? tDash('hero.lastWeek') : tDash('hero.lastMonth')
      const pct = revPct ?? 0
      const head = revDelta >= 0
        ? tDash('hero.upOn',   { pct, ref })
        : tDash('hero.downOn', { pct, ref })
      return (
        <>
          {head}
          {labourState !== 'unknown' && (
            <>{' '}
              {labourState === 'lean'
                ? tDash('hero.labourLeanTarget', { pct: fmtPct(labourPct), target: targetPct })
                : tDash('hero.labourVsTarget',   { pct: fmtPct(labourPct), target: targetPct })}
            </>
          )}
        </>
      )
    }
    return (
      <>
        {isWeek
          ? tDash('hero.marginWeek',  { amount: fmtKr(margin) })
          : tDash('hero.marginMonth', { amount: fmtKr(margin) })}
      </>
    )
  })()

  // Footer — compact stat strip, dashed top-border like the other cards.
  const footerParts: string[] = []
  if (totalHours > 0) footerParts.push(tDash('hero.footerHours',  { hours: Math.round(totalHours) }))
  if (revPerHour > 0) footerParts.push(tDash('hero.footerRate',   { amount: fmtKr(revPerHour) }))
  if (totalRev > 0)   footerParts.push(tDash('hero.footerMargin', { amount: fmtKr(margin) }))
  const footer = footerParts.join(' · ')

  return (
    <div
      style={{
        display:        'flex',
        flexDirection:  'column' as const,
        justifyContent: 'space-between',
        background:     UX.cardBg,
        border:         `1px solid ${UX.border}`,
        borderLeft:     `4px solid ${revTone}`,
        borderRadius:   UX.r_lg,
        padding:        '18px 20px',
        minHeight:      0,
      }}
    >
      <div>
        <div style={schedCardEyebrow}>{eyebrow}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 10, flexWrap: 'wrap' as const }}>
          <span style={{ fontSize: 26, fontWeight: 500, color: revTone, letterSpacing: '-0.02em' }}>
            {totalRev > 0 ? fmtKr(totalRev) : '—'}
          </span>
          {revPct != null && (
            <span style={{ fontSize: 14, color: revTone, fontWeight: 500 }}>
              {revArrow} {revPct}%
            </span>
          )}
          <span style={{ fontSize: 12, color: UX.ink3, marginLeft: 2 }}>{tDash('hero.revenue')}</span>
        </div>
        <div style={{ fontSize: 12, color: UX.ink3, marginTop: 6, lineHeight: 1.4 }}>
          {body}
        </div>
        {footer && (
          <div style={{ fontSize: 11, color: UX.ink4, marginTop: 8, paddingTop: 6, borderTop: `1px dashed ${UX.borderSoft}` }}>
            {footer}
            {aiSaving > 0 && <span> · {tDash('hero.aiSees', { amount: fmtKr(aiSaving) })}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DepartmentsSummary — condensed list of departments for the current period.
// Spec § 1 Overview: 5 rows max, each with status dot · name · revenue · margin
// · sparkline. `View all →` routes to /departments.
// ─────────────────────────────────────────────────────────────────────────────
function DepartmentsSummary({ depts, targetPct, periodLabel, fmtKr, fmtPct }: any) {
  const tDash = useTranslations('dashboard')
  const rows = (depts ?? [])
    .filter((d: any) => Number(d.revenue ?? 0) > 0 || Number(d.staff_cost ?? 0) > 0)
    .sort((a: any, b: any) => Number(b.revenue ?? 0) - Number(a.revenue ?? 0))
    .slice(0, 5)

  return (
    <div style={{
      background:   UX.cardBg,
      border:       `0.5px solid ${UX.border}`,
      borderRadius: UX.r_lg,
      overflow:     'hidden' as const,
    }}>
      <div style={{
        padding:        '12px 16px',
        borderBottom:   `0.5px solid ${UX.borderSoft}`,
        display:        'flex',
        justifyContent: 'space-between',
        alignItems:     'baseline',
      }}>
        <div style={{ fontSize: UX.fsSection, fontWeight: UX.fwMedium, color: UX.ink1 }}>
          {tDash('departments.header', { period: periodLabel })}
        </div>
        <a href="/departments" style={{ fontSize: UX.fsLabel, color: UX.indigo, textDecoration: 'none', fontWeight: UX.fwMedium }}>
          {tDash('departments.viewAll')}
        </a>
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center' as const, fontSize: UX.fsBody, color: UX.ink4 }}>
          {tDash('departments.empty')}
        </div>
      ) : (
        <div>
          {rows.map((d: any) => {
            const margin = Number(d.revenue ?? 0) - Number(d.staff_cost ?? 0)
            const marginPct = d.revenue > 0 ? (margin / d.revenue) * 100 : null
            const marginTone: 'good' | 'bad' | 'warning' | 'neutral' =
              marginPct == null ? 'neutral'
              : marginPct >= 55 ? 'good'
              : marginPct >= 30 ? 'warning'
              :                   'bad'
            const dotColour =
              marginTone === 'good'    ? UX.greenInk :
              marginTone === 'warning' ? UX.amberInk :
              marginTone === 'bad'     ? UX.redInk   : UX.ink4
            return (
              <a
                key={d.name}
                href={`/departments/${encodeURIComponent(d.name)}`}
                style={{
                  display:        'grid',
                  gridTemplateColumns: '10px 1fr auto auto auto',
                  gap:            10,
                  alignItems:     'center',
                  padding:        '9px 16px',
                  borderBottom:   `0.5px solid ${UX.borderSoft}`,
                  textDecoration: 'none',
                  color:          UX.ink1,
                  fontSize:       UX.fsBody,
                }}
              >
                <span
                  aria-hidden
                  style={{ width: 6, height: 6, borderRadius: '50%', background: d.color ?? dotColour }}
                />
                <span style={{ fontWeight: UX.fwMedium, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
                  {d.name}
                </span>
                <span style={{ color: UX.ink2, fontVariantNumeric: 'tabular-nums' as const, whiteSpace: 'nowrap' as const }}>
                  {fmtKr(d.revenue)}
                </span>
                <span style={{
                  fontVariantNumeric: 'tabular-nums' as const,
                  fontWeight: UX.fwMedium,
                  color:
                    marginTone === 'good'    ? UX.greenInk :
                    marginTone === 'warning' ? UX.amberInk :
                    marginTone === 'bad'     ? UX.redInk   : UX.ink3,
                  whiteSpace: 'nowrap' as const,
                }}>
                  {marginPct == null ? '—' : fmtPct(marginPct)}
                </span>
                <Sparkline points={[]} tone={marginTone} dashed />
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// buildAttentionItems — synthesise up to 3 items for the AttentionPanel from
// the data already loaded on this page. Spec § 1: worst dept + trending-down
// dept + AI saving. We approximate "trending-down" with the 2nd-worst margin
// when a clear worst exists, since per-dept deltas aren't fetched yet.
// ─────────────────────────────────────────────────────────────────────────────
function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split('-').map(Number)
  const [ty, tm, td] = toYmd.split('-').map(Number)
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

function buildAttentionItems({ depts, aiSaving, targetPct, labourPct, totalRev, country, t, tCommon }: any): AttentionItem[] {
  const items: AttentionItem[] = []

  // 0. Upcoming public holiday in the next 14 days — peak (high impact)
  // gets surfaced first because it's the most actionable for staffing
  // decisions ("Midsummer Eve next Friday — book extra cover"). Quiet
  // holidays (Christmas Day, Easter Sunday) are flagged neutrally.
  // Computed client-side from the pure holiday lib — no fetch needed.
  try {
    const today    = new Date()
    const fromYmd  = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`
    const upcoming = getUpcomingHolidays(country ?? 'SE', fromYmd, 14)
    const next     = upcoming[0]
    if (next) {
      const days = Math.max(0, daysBetweenYmd(fromYmd, next.date))
      const when = days === 0 ? tCommon('time.today')
                 : days === 1 ? tCommon('time.tomorrow')
                 : tCommon('time.inDays', { days })
      const localeName = next.name_sv  // we'll let the AttentionPanel rely on the en-GB fallback for now; sv users see the Swedish name everywhere else too
      items.push({
        tone:    next.impact === 'high' ? 'good' : next.impact === 'low' ? 'warning' : 'good',
        entity:  '📅',
        message: `${localeName} — ${when}${next.impact === 'high' ? ' · expect peak demand' : next.impact === 'low' ? ' · most restaurants close' : ''}`,
      })
    }
  } catch { /* holiday lookup failure must never block the panel */ }

  // 1. AI saving (if any) — most actionable first.
  if (aiSaving > 0) {
    const kr = Math.round(aiSaving).toLocaleString('en-GB').replace(/,/g, ' ')
    items.push({
      tone:    'good',
      entity:  'AI',
      message: t('attention.aiSees', { amount: kr }),
    })
  }

  // 2. Worst department by margin %.
  const withRev = (depts ?? []).filter((d: any) => Number(d.revenue ?? 0) > 0)
  if (withRev.length) {
    const ranked = withRev.map((d: any) => {
      const margin    = Number(d.revenue ?? 0) - Number(d.staff_cost ?? 0)
      const marginPct = d.revenue > 0 ? (margin / d.revenue) * 100 : null
      return { ...d, _marginPct: marginPct }
    }).sort((a: any, b: any) => (a._marginPct ?? 1e9) - (b._marginPct ?? 1e9))

    const worst = ranked[0]
    if (worst && worst._marginPct != null && worst._marginPct < 55) {
      items.push({
        tone:    worst._marginPct < 30 ? 'bad' : 'warning',
        entity:  worst.name,
        message: t('attention.deptWorst', { pct: (Math.round(worst._marginPct * 10) / 10).toFixed(1) }),
      })
    }

    // 3. Second worst if it's also in trouble.
    const second = ranked[1]
    if (items.length < 3 && second && second._marginPct != null && second._marginPct < 40) {
      items.push({
        tone:    'warning',
        entity:  second.name,
        message: t('attention.deptSecondWorst', { pct: (Math.round(second._marginPct * 10) / 10).toFixed(1) }),
      })
    }
  }

  // 4. Group-level labour flag if nothing else.
  if (items.length === 0 && labourPct != null && totalRev > 0 && labourPct > targetPct + 5) {
    items.push({
      tone:    'warning',
      entity:  'Labour',
      message: t('attention.labour', { pct: (Math.round(labourPct * 10) / 10).toFixed(1), target: targetPct }),
    })
  }

  return items
}

// ─────────────────────────────────────────────────────────────────────────────
// ChartHeaderStrip — four-stat strip above the chart card. Revenue / Labour /
// Labour margin / Covers, label-above-value layout per v7 mockup. Re-introduced
// after the legacy KPI strip was removed in commit 63809e7 (it duplicated
// PageHero/SupportingStats); v7's design has no SupportingStats so the
// duplication risk doesn't apply.
// ─────────────────────────────────────────────────────────────────────────────
function ChartHeaderStrip({
  viewMode, periodLabel,
  totalRev, totalLabour, labourPct, covers,
  prevRev, prevLabPct,
  fmtKr, fmtPct,
}: any) {
  const tDash = useTranslations('dashboard')

  // Revenue delta vs previous period — same source the existing OverviewHero
  // already uses. Sign drives the badge tone.
  const revDelta = prevRev > 0 ? ((totalRev - prevRev) / prevRev) * 100 : null
  const revDeltaTone = revDelta == null ? 'neutral' : revDelta >= 0 ? 'good' : 'bad'

  // Labour delta in percentage POINTS (not relative). +21pp etc.
  const labDeltaPp = (labourPct != null && prevLabPct != null) ? Math.round(labourPct - prevLabPct) : null
  const labDeltaTone = labDeltaPp == null ? 'neutral' : labDeltaPp <= 0 ? 'good' : 'bad'

  // Labour margin = revenue − labour. NOT net margin (no food/overhead here).
  const labourMargin = Math.max(0, totalRev - totalLabour)
  // No reliable YoY comparison wired today — show prev-period delta if we
  // have it, else omit. Mockup's "+9pp YoY" is illustrative.
  const marginDeltaPp = (labourPct != null && prevLabPct != null) ? Math.round(prevLabPct - labourPct) : null
  const marginDeltaTone = marginDeltaPp == null ? 'neutral' : marginDeltaPp >= 0 ? 'good' : 'bad'

  return (
    <div className="cc-chart-strip" style={{
      display:        'flex',
      gap:            36,
      alignItems:     'flex-start',
      padding:        '14px 20px 16px',
      background:     UX.cardBg,
      border:         `1px solid ${UX.border}`,
      borderRadius:   12,
      marginBottom:   12,
      flexWrap:       'wrap' as const,
    }}>
      <Stat
        label={tDash('chart.strip.revenue')}
        value={fmtKr(totalRev)}
        delta={revDelta == null ? null : `${revDelta >= 0 ? '+' : ''}${(Math.round(revDelta * 10) / 10).toFixed(1)}%`}
        tone={revDeltaTone}
      />
      <Stat
        label={tDash('chart.strip.labour')}
        value={totalRev > 0 ? `${(Math.round(labourPct * 10) / 10).toFixed(1)}%` : '—'}
        delta={labDeltaPp == null ? null : `${labDeltaPp >= 0 ? '+' : ''}${labDeltaPp}pp`}
        tone={labDeltaTone}
        valueTone={labDeltaTone}
      />
      <Stat
        label={tDash('chart.strip.labourMargin')}
        value={fmtKr(labourMargin)}
        delta={marginDeltaPp == null ? null : `${marginDeltaPp >= 0 ? '+' : ''}${marginDeltaPp}pp`}
        tone={marginDeltaTone}
        valueTone={marginDeltaTone}
      />
      <Stat
        label={tDash('chart.strip.covers')}
        value={covers > 0 ? String(covers) : '—'}
      />
      <style>{`
        @media (max-width: 880px) {
          .cc-chart-strip { gap: 14px !important; padding: 12px 14px !important; }
        }
      `}</style>
    </div>
  )
}

function Stat({ label, value, delta, tone, valueTone }: {
  label:     string
  value:     string
  delta?:    string | null
  tone?:     'good' | 'bad' | 'neutral'
  valueTone?:'good' | 'bad' | 'neutral'
}) {
  const valueColor = valueTone === 'good' ? UX.greenInk : valueTone === 'bad' ? UX.redInk : UX.ink1
  const deltaPalette = tone === 'good'
    ? { bg: UX.greenBg, fg: UX.greenInk }
    : tone === 'bad'
    ? { bg: UX.redSoft, fg: UX.redInk }
    : { bg: 'transparent', fg: UX.ink4 }
  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4, minWidth: 0 }}>
      <span style={{
        fontSize:      11,
        color:         UX.ink4,
        letterSpacing: '0.08em',
        textTransform: 'uppercase' as const,
        fontWeight:    500,
        lineHeight:    1.2,
        whiteSpace:    'nowrap' as const,
      }}>
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' as const }}>
        <span style={{
          fontSize:      26,
          fontWeight:    700,
          color:         valueColor,
          letterSpacing: '-0.02em',
          lineHeight:    1,
          whiteSpace:    'nowrap' as const,
        }}>
          {value}
        </span>
        {delta && (
          <span style={{
            fontSize:    11,
            fontWeight:  700,
            padding:     '2px 8px',
            borderRadius:999,
            background:  deltaPalette.bg,
            color:       deltaPalette.fg,
            whiteSpace:  'nowrap' as const,
          }}>
            {delta}
          </span>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// CompactAttentionStrip — horizontal version of AttentionPanel for the new
// dashboard footer. Same input shape (AttentionItem[]) so the existing
// buildAttentionItems() helper feeds it unchanged.
// ─────────────────────────────────────────────────────────────────────────────
function CompactAttentionStrip({ items }: { items: AttentionItem[] }) {
  const t = useTranslations('common.attention')
  if (!items.length) return null
  return (
    <div className="cc-attention-strip" style={{
      background:   UX.cardBg,
      border:       `1px solid ${UX.border}`,
      borderRadius: 10,
      padding:      '16px 22px',
      display:      'flex',
      gap:          18,
      alignItems:   'center',
      marginTop:    16,
      marginBottom: 16,
    }}>
      <div className="cc-attention-strip-h" style={{
        fontSize:      11,
        color:         UX.ink4,
        letterSpacing: '0.08em',
        textTransform: 'uppercase' as const,
        fontWeight:    500,
        flexShrink:    0,
        paddingRight:  18,
        borderRight:   `1px solid ${UX.borderSoft}`,
      }}>
        {t('defaultTitle')}{' '}
        <span style={{
          background:   UX.ink1,
          color:        'white',
          fontSize:     10,
          fontWeight:   600,
          padding:      '1px 6px',
          borderRadius: 999,
          marginLeft:   4,
        }}>{items.length}</span>
      </div>
      <div style={{
        display:    'flex',
        gap:        22,
        flex:       1,
        overflowX:  'auto',
      }}>
        {items.slice(0, 6).map((it, i) => {
          const palette = it.tone === 'bad'
            ? { bg: UX.redSoft, fg: UX.redInk, glyph: '!' }
            : it.tone === 'warning'
            ? { bg: UX.amberSoft, fg: UX.amberInk, glyph: '⌖' }
            : { bg: UX.greenBg, fg: UX.greenInk, glyph: '→' }
          return (
            <div key={`${it.entity}-${i}`} style={{
              display:    'flex',
              alignItems: 'center',
              gap:        8,
              fontSize:   12,
              whiteSpace: 'nowrap' as const,
              minWidth:   0,
            }}>
              <span style={{
                width:        18,
                height:       18,
                borderRadius: 5,
                display:      'grid',
                placeItems:   'center',
                fontSize:     10,
                fontWeight:   700,
                background:   palette.bg,
                color:        palette.fg,
                flexShrink:   0,
              }}>{palette.glyph}</span>
              <span style={{ fontWeight: 600, color: UX.ink1 }}>{it.entity}</span>
              <span style={{ color: UX.ink4 }}>— {it.message}</span>
            </div>
          )
        })}
      </div>
      <style>{`
        @media (max-width: 880px) {
          .cc-attention-strip { flex-direction: column; align-items: flex-start; }
          .cc-attention-strip-h { border-right: none; border-bottom: 1px solid ${UX.borderSoft}; padding-right: 0; padding-bottom: 12px; width: 100%; }
        }
      `}</style>
    </div>
  )
}

const chartFooterNotesStyle: React.CSSProperties = {
  display:             'grid',
  gridTemplateColumns: '1fr 1fr',
  gap:                 12,
  marginTop:           10,
  marginBottom:        16,
}

const chartFooterNoteStyle: React.CSSProperties = {
  fontSize:    11,
  color:       UX.ink4,
  padding:     '8px 12px',
  background:  UX.subtleBg,
  borderRadius:6,
  lineHeight:  1.5,
}
