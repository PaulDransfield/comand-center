'use client'
// @ts-nocheck
// app/dashboard/page.tsx — CommandCenter main dashboard
// Week-first layout inspired by Personalkollen: KPIs → chart → dept table + P&L

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { OverheadReviewCard } from '@/components/OverheadReviewCard'
import dynamicImport from 'next/dynamic'
// AskAI is a floating button + slide-in panel — only used after the user
// clicks. Lazy-load it (FIXES §0ll) so its ~30 KB doesn't sit in this
// page's First Load JS for users who never open it. ssr:false because
// it reads localStorage at mount.
const AskAI = dynamicImport(() => import('@/components/AskAI'), { ssr: false, loading: () => null })
import OverviewChart, { PeriodOption } from '@/components/dashboard/OverviewChart'
import PageHero from '@/components/ui/PageHero'
import SupportingStats from '@/components/ui/SupportingStats'
import AttentionPanel, { AttentionItem } from '@/components/ui/AttentionPanel'
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

export default function DashboardPage() {
  return (
    <Suspense fallback={<div style={{ padding: 60, textAlign: 'center' as const, color: '#9ca3af' }}>Loading…</div>}>
      <DashboardInner />
    </Suspense>
  )
}

function DashboardInner() {
  const [businesses,  setBusinesses]  = useState<any[]>([])
  const [bizId,       setBizId]       = useState<string | null>(null)
  const [dataAsOf,    setDataAsOf]    = useState<string | null>(null)
  const [weekOffset,  setWeekOffset]  = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  const [viewMode,    setViewMode]    = useState<'week'|'month'>('week')
  const [dailyRows,   setDailyRows]   = useState<any[]>([])
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
      out.push({ key: `w:${off}`, label: `Week ${w.weekNum} · ${w.label}`, view: 'week', dateFrom: w.from, dateTo: w.to })
    }
    for (let off = 0; off >= -6; off--) {
      const m = getMonthBounds(off)
      out.push({ key: `m:${off}`, label: m.label, view: 'month', dateFrom: m.from, dateTo: m.to })
    }
    return out
  }, [/* only needs stable fn refs — dates computed from `now` at render */])

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

  return (
    <AppShell>
      <div className="page-wrap">

        {/* ── Upgrade banner ──────────────────────────────────────────────── */}
        {showUpgrade && (
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 12, padding: '14px 18px', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 20 }}>🎉</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#15803d' }}>You're now on the {upgradePlan || 'new'} plan</div>
                <div style={{ fontSize: 12, color: '#4b7c59' }}>All features are now unlocked.</div>
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
                <strong>Data last updated {daysOld === 1 ? 'yesterday' : `${daysOld} days ago`}</strong> — syncing is in progress. Click the sync dot in the sidebar to refresh now.
              </div>
            </div>
          )
        })()}

        {/* Outer header removed in Phase 1 — the business selector is now in
            the sidebar (SidebarV2) and the period navigator + W/M toggle are
            inside OverviewChart's own control row. Keeping both would be the
            exact duplication the redesign is trying to eliminate. */}

        {/* ── Alerts strip ────────────────────────────────────────────────── */}
        {alerts.filter(a => a.severity === 'high' || a.severity === 'critical').slice(0, 1).map(a => (
          <a key={a.id} href="/alerts" style={{ textDecoration: 'none', display: 'flex', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10, padding: '10px 14px', marginBottom: 16, justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#c2410c' }}>⚠ {a.title}</span>
              <span style={{ fontSize: 12, color: '#9a3412', marginLeft: 8 }}>{a.description?.slice(0, 70)}{a.description?.length > 70 ? '…' : ''}</span>
            </div>
            <span style={{ fontSize: 11, color: '#c2410c', fontWeight: 600, whiteSpace: 'nowrap' }}>View all alerts →</span>
          </a>
        ))}

        {/* ─── PageHero + chart + supporting row ─────────────────────────────
            One consolidated view for both week and month — the chart's own
            W/M toggle drives viewMode state, so a single render path serves
            both. Spec: DESIGN.md § 1. Overview. */}
        {loading ? (
          <div style={{ padding: 80, textAlign: 'center' as const, color: UX.ink4, fontSize: UX.fsBody }}>Loading…</div>
        ) : (
          <>
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
              const showCard = hasPredictive || hasRetrospective || hasOverheadCard
              return (
                <div style={{
                  display:             'grid',
                  gridTemplateColumns: showCard ? 'minmax(0, 1fr) minmax(280px, 360px)' : '1fr',
                  gap:                 12,
                  alignItems:          'stretch',
                  marginBottom:        12,
                }}>
                  <OverviewHero
                    viewMode={viewMode}
                    curr={curr}
                    currM={currM}
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

                  {showCard && (
                    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
                  {hasPredictive && (
                    <a
                      href="/scheduling"
                      style={schedCardLink}
                      onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.05)')}
                      onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
                    >
                      <div>
                        <div style={schedCardEyebrow}>NEXT WEEK · LABOUR PROJECTION</div>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 10, flexWrap: 'wrap' as const }}>
                          <span style={{ fontSize: 26, fontWeight: 500, color: UX.ink2, letterSpacing: '-0.02em' }}>
                            {Math.round(curPct!)}%
                          </span>
                          <span style={{ fontSize: 18, color: UX.ink4 }}>→</span>
                          <span style={{ fontSize: 26, fontWeight: 500, color: UX.greenInk, letterSpacing: '-0.02em' }}>
                            {Math.round(aiPct!)}%
                          </span>
                          <span style={{ fontSize: 12, color: UX.ink3, marginLeft: 2 }}>of revenue</span>
                        </div>
                        <div style={{ fontSize: 12, color: UX.ink3, marginTop: 6, lineHeight: 1.4 }}>
                          Your current schedule projects to <span style={{ color: UX.ink2, fontWeight: 500 }}>{Math.round(curPct!)}%</span> labour.{' '}
                          AI cuts bring it to <span style={{ color: UX.greenInk, fontWeight: 500 }}>{Math.round(aiPct!)}%</span>.
                        </div>
                        <div style={{ fontSize: 11, color: UX.ink4, marginTop: 8, paddingTop: 6, borderTop: `1px dashed ${UX.borderSoft}` }}>
                          Saves <span style={{ color: UX.greenInk, fontWeight: 500 }}>{fmtKr(aiSaving)}</span>
                          {aiCutH > 0.5 && <span> · {Math.round(aiCutH * 10) / 10}h cut</span>}
                        </div>
                      </div>
                      <div style={schedCardCta}>Open scheduling <span aria-hidden style={{ fontSize: 14 }}>→</span></div>
                    </a>
                  )}

                  {hasRetrospective && (() => {
                    const periodLabel = viewMode === 'week' ? `WEEK ${curr.weekNum}` : currM.label.toUpperCase()
                    const onTarget    = labourPct <= targetPct
                    // Could-have-saved math: actual labour cost vs target labour cost.
                    // target_cost = revenue × target%
                    // missed = totalLabour - target_cost (positive = overspent vs target)
                    const targetCost  = totalRev * (targetPct / 100)
                    const couldSave   = Math.max(0, totalLabour - targetCost)
                    const accent      = onTarget ? UX.greenInk : UX.amberInk
                    return (
                      <a
                        href="/scheduling"
                        style={{ ...schedCardLink, borderLeft: `4px solid ${accent}` }}
                        onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.05)')}
                        onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
                      >
                        <div>
                          <div style={schedCardEyebrow}>{periodLabel} · LABOUR vs TARGET</div>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 10, flexWrap: 'wrap' as const }}>
                            <span style={{ fontSize: 26, fontWeight: 500, color: accent, letterSpacing: '-0.02em' }}>
                              {Math.round(labourPct)}%
                            </span>
                            <span style={{ fontSize: 12, color: UX.ink3 }}>
                              vs <span style={{ color: UX.ink2, fontWeight: 500 }}>{Math.round(targetPct)}%</span> target
                            </span>
                          </div>
                          <div style={{ fontSize: 12, color: UX.ink3, marginTop: 6, lineHeight: 1.4 }}>
                            {onTarget ? (
                              <>Labour was on target — well done.</>
                            ) : (
                              <>Labour ran <span style={{ color: accent, fontWeight: 500 }}>{Math.round(labourPct - targetPct)}pp over target</span>.</>
                            )}
                          </div>
                          <div style={{ fontSize: 11, color: UX.ink4, marginTop: 8, paddingTop: 6, borderTop: `1px dashed ${UX.borderSoft}` }}>
                            {onTarget
                              ? <>No saving missed for this period.</>
                              : <>Could have saved <span style={{ color: accent, fontWeight: 500 }}>{fmtKr(couldSave)}</span> by hitting target.</>
                            }
                          </div>
                        </div>
                        <div style={{ ...schedCardCta, color: accent }}>
                          Open scheduling <span aria-hidden style={{ fontSize: 14 }}>→</span>
                        </div>
                      </a>
                    )
                  })()}

                  {hasOverheadCard && <OverheadReviewCard data={overheadProj} />}
                    </div>
                  )}
                </div>
              )
            })()}

            <OverviewChart
              days={viewMode === 'week' ? weekDays : monthDays}
              viewMode={viewMode}
              onViewModeChange={handleViewModeChange}
              periodLabel={viewMode === 'week' ? `Week ${curr.weekNum} · ${curr.label}` : currM.label}
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
            />

            {/* Supporting row — Departments summary + AttentionPanel.
                Spec § 1 Overview: grid 1fr 260px, max 5 dept rows + max 3
                attention items. */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 260px',
              gap: 12,
              marginTop: 12,
              marginBottom: 16,
            }}>
              <DepartmentsSummary
                depts={(depts?.departments ?? [])}
                targetPct={targetPct}
                periodLabel={viewMode === 'week' ? `Week ${curr.weekNum}` : currM.label}
                fmtKr={fmtKr}
                fmtPct={fmtPct}
              />
              <AttentionPanel
                items={buildAttentionItems({
                  depts: depts?.departments ?? [],
                  aiSaving: aiSched?.summary?.saving_kr ?? 0,
                  targetPct,
                  labourPct,
                  totalRev,
                })}
              />
            </div>

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
  totalRev, totalLabour, prevRev, prevLabour,
  totalHours, revPerHour,
  labourPct, targetPct,
  aiSaving,
  fmtKr, fmtPct,
}: any) {
  const isWeek = viewMode === 'week'
  const eyebrow = isWeek
    ? `THIS WEEK · ${curr.label ?? ''}`
    : `THIS MONTH · ${currM.label ?? ''}`

  // Revenue delta vs previous period.
  const revDelta = prevRev > 0 ? ((totalRev - prevRev) / prevRev) * 100 : null
  const revTone: 'good' | 'bad' | 'neutral' =
    revDelta == null ? 'neutral' : revDelta >= 0 ? 'good' : 'bad'

  // Labour shape — "lean" = at or under target, "tight" = ≤ 5pp over, "hot" = > 5pp over.
  const labourState =
    totalRev <= 0 || labourPct == null       ? 'unknown'
    : labourPct <= targetPct                 ? 'lean'
    : labourPct <= targetPct + 5             ? 'tight'
    :                                          'hot'

  // Headline construction — keep to a single sentence, ≤ 14 words target.
  const headline = (() => {
    if (totalRev <= 0) {
      return (
        <span>
          Waiting on today's sync — revenue hasn't landed yet.
        </span>
      )
    }
    if (revDelta != null) {
      const sign = revDelta >= 0 ? '+' : ''
      const deltaText = `${sign}${Math.round(revDelta * 10) / 10}%`
      const deltaSpan = (
        <span style={{
          color: revTone === 'good' ? UX.greenInk : revTone === 'bad' ? UX.redInk : UX.ink1,
          fontWeight: UX.fwMedium,
        }}>
          {deltaText}
        </span>
      )
      const direction = revDelta >= 0 ? 'ahead of' : 'behind'
      const ref       = isWeek ? 'last week' : 'last month'
      const labourTail =
        labourState === 'lean'  ? <>, labour running <span style={{ color: UX.greenInk, fontWeight: UX.fwMedium }}>lean</span>.</> :
        labourState === 'tight' ? <>, labour tight at <span style={{ color: UX.amberInk, fontWeight: UX.fwMedium }}>{fmtPct(labourPct)}</span>.</> :
        labourState === 'hot'   ? <>, labour <span style={{ color: UX.redInk, fontWeight: UX.fwMedium }}>{fmtPct(labourPct)}</span> vs {targetPct}% target.</> :
                                  <>.</>
      return <span>Trading {deltaSpan} {direction} {ref}{labourTail}</span>
    }
    // No prev-period baseline — state the absolute figures.
    return (
      <span>
        Revenue <span style={{ fontWeight: UX.fwMedium }}>{fmtKr(totalRev)}</span>
        , margin <span style={{ fontWeight: UX.fwMedium }}>{fmtKr(Math.max(0, totalRev - totalLabour))}</span> this {isWeek ? 'week' : 'month'}.
      </span>
    )
  })()

  // Context — one line: hours, rev/hour, and AI saving if any.
  const contextParts: string[] = []
  if (totalHours > 0)        contextParts.push(`${Math.round(totalHours)}h worked`)
  if (revPerHour > 0)        contextParts.push(`${fmtKr(revPerHour)}/hr`)
  if (aiSaving > 0)          contextParts.push(`AI sees ${fmtKr(aiSaving)} save next week`)
  const context = contextParts.length ? contextParts.join(' · ') : undefined

  // Right slot — 3 stats, per spec.
  const margin = Math.max(0, totalRev - totalLabour)
  const labourDelta = prevLabour > 0 ? ((totalLabour - prevLabour) / prevLabour) * 100 : null
  const prevMargin  = prevRev - prevLabour
  const marginDelta = prevMargin > 0 ? ((margin - prevMargin) / prevMargin) * 100 : null
  const fmtDelta = (d: number | null): string | undefined =>
    d == null ? undefined : `${d >= 0 ? '↑' : '↓'} ${Math.abs(Math.round(d * 10) / 10)}%`

  // Labour delta is inverted — lower is better for the business.
  const labourTone: 'good' | 'bad' | 'neutral' =
    labourDelta == null ? 'neutral' : labourDelta <= 0 ? 'good' : 'bad'
  const marginTone: 'good' | 'bad' | 'neutral' =
    marginDelta == null ? 'neutral' : marginDelta >= 0 ? 'good' : 'bad'

  const stats = [
    {
      label: 'Revenue',
      value: totalRev > 0 ? fmtKr(totalRev) : '—',
      delta: fmtDelta(revDelta),
      deltaTone: revTone as 'good' | 'bad' | 'neutral',
      sub: prevRev > 0 ? `vs ${fmtKr(prevRev)}` : undefined,
    },
    {
      label: 'Labour',
      value: totalLabour > 0 ? fmtKr(totalLabour) : '—',
      delta: fmtDelta(labourDelta),
      deltaTone: labourTone,
      sub: labourPct != null && totalRev > 0 ? fmtPct(labourPct) : undefined,
    },
    {
      label: 'Margin',
      value: totalRev > 0 ? fmtKr(margin) : '—',
      delta: fmtDelta(marginDelta),
      deltaTone: marginTone,
      sub: totalRev > 0 ? fmtPct((margin / totalRev) * 100) : undefined,
    },
  ]

  return (
    <PageHero
      eyebrow={eyebrow}
      headline={headline}
      context={context}
      right={<SupportingStats items={stats} />}
    />
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DepartmentsSummary — condensed list of departments for the current period.
// Spec § 1 Overview: 5 rows max, each with status dot · name · revenue · margin
// · sparkline. `View all →` routes to /departments.
// ─────────────────────────────────────────────────────────────────────────────
function DepartmentsSummary({ depts, targetPct, periodLabel, fmtKr, fmtPct }: any) {
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
          Departments — {periodLabel}
        </div>
        <a href="/departments" style={{ fontSize: UX.fsLabel, color: UX.indigo, textDecoration: 'none', fontWeight: UX.fwMedium }}>
          View all →
        </a>
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center' as const, fontSize: UX.fsBody, color: UX.ink4 }}>
          No department data for this period yet.
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
function buildAttentionItems({ depts, aiSaving, targetPct, labourPct, totalRev }: any): AttentionItem[] {
  const items: AttentionItem[] = []

  // 1. AI saving (if any) — most actionable first.
  if (aiSaving > 0) {
    const kr = Math.round(aiSaving).toLocaleString('en-GB').replace(/,/g, ' ')
    items.push({
      tone:    'good',
      entity:  'AI',
      message: `sees ${kr} kr to trim from next week's hours.`,
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
        message: `margin ${(Math.round(worst._marginPct * 10) / 10).toFixed(1)}% — labour is the swing factor.`,
      })
    }

    // 3. Second worst if it's also in trouble.
    const second = ranked[1]
    if (items.length < 3 && second && second._marginPct != null && second._marginPct < 40) {
      items.push({
        tone:    'warning',
        entity:  second.name,
        message: `margin ${(Math.round(second._marginPct * 10) / 10).toFixed(1)}% — worth a look.`,
      })
    }
  }

  // 4. Group-level labour flag if nothing else.
  if (items.length === 0 && labourPct != null && totalRev > 0 && labourPct > targetPct + 5) {
    items.push({
      tone:    'warning',
      entity:  'Labour',
      message: `running ${(Math.round(labourPct * 10) / 10).toFixed(1)}% of revenue, ${targetPct}% target.`,
    })
  }

  return items
}
