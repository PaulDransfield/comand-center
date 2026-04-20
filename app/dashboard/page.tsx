'use client'
// @ts-nocheck
// app/dashboard/page.tsx — CommandCenter main dashboard
// Week-first layout inspired by Personalkollen: KPIs → chart → dept table + P&L

import { useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'
import WeatherStrip from '@/components/WeatherStrip'

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtKr  = (n: number) => Math.round(n).toLocaleString('en-GB') + ' kr'
// Format a Date as YYYY-MM-DD using local timezone (NOT UTC — avoids off-by-one in CET/CEST)
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const fmtPct = (n: number) => (Math.round(n * 10) / 10).toFixed(1) + '%'
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
export default function DashboardPage() {
  const [businesses,  setBusinesses]  = useState<any[]>([])
  const [bizId,       setBizId]       = useState<string | null>(null)
  const [weekOffset,  setWeekOffset]  = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  const [viewMode,    setViewMode]    = useState<'week'|'month'>('week')
  const [dailyRows,   setDailyRows]   = useState<any[]>([])
  const [prevSummary, setPrevSummary] = useState<any>(null)
  const [depts,       setDepts]       = useState<any>(null)
  const [alerts,      setAlerts]      = useState<any[]>([])
  const [loading,     setLoading]     = useState(true)
  const [tooltip,     setTooltip]     = useState<any>(null)
  const [showUpgrade, setShowUpgrade] = useState(false)
  const [upgradePlan, setUpgradePlan] = useState('')
  const [aiSched,     setAiSched]     = useState<any>(null)

  // Upgrade banner on Stripe redirect
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    if (p.get('upgrade') === 'success') {
      setUpgradePlan(p.get('plan') ?? '')
      setShowUpgrade(true)
      setTimeout(() => setShowUpgrade(false), 8000)
    }
  }, [])

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

  // Next-week AI prediction — fetched once per biz. Used to enrich future days
  // on the weekly chart with predicted revenue + weather instead of empty stubs.
  useEffect(() => {
    if (!bizId) { setAiSched(null); return }
    let cancelled = false
    fetch(`/api/scheduling/ai-suggestion?business_id=${bizId}`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (!cancelled && j && !j.error) setAiSched(j) })
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

    // cache: 'no-store' — the browser was happily serving a pre-fix snapshot of
    // these responses even after the DB was updated. Aggregator runs cheap, users
    // reload the dashboard manually, no benefit to HTTP-caching these calls.
    const noStore: RequestInit = { cache: 'no-store' }
    Promise.all([
      // Pre-computed daily metrics (reads from summary tables)
      fetch(`/api/metrics/daily?from=${curr.from}&to=${curr.to}&${biz}`, noStore).then(r => r.json()).catch(() => ({})),
      fetch(`/api/metrics/daily?from=${prev.from}&to=${prev.to}&${biz}`, noStore).then(r => r.json()).catch(() => ({})),
      // Departments (still reads from raw tables — has per-dept breakdown)
      fetch(`/api/departments?from=${curr.from}&to=${curr.to}&${biz}`, noStore).then(r => r.json()).catch(() => ({})),
      fetch('/api/alerts', noStore).then(r => r.json()).catch(() => []),
    ]).then(([curr_, prev_, deptRes, alertRes]) => {
      // Map daily_metrics field names to what the dashboard expects
      const rows = (curr_.rows ?? []).map((r: any) => ({ ...r, staff_pct: r.labour_pct }))
      setDailyRows(rows)
      setPrevSummary(prev_.summary ?? null)
      setDepts(deptRes ?? null)
      setAlerts(Array.isArray(alertRes) ? alertRes : [])
      setLoading(false)
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
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d   = new Date(curr.mon)
    d.setDate(curr.mon.getDate() + i)
    const ds  = localDate(d)
    const row = dailyRows.find(r => r.date === ds) ?? { date: ds, revenue: 0, staff_cost: 0, staff_pct: null }
    const isToday   = ds === localDate(now)
    const isFuture  = d > now
    const pred      = predByDate[ds] ?? null
    return { ...row, dayName: DAYS[i], dateStr: ds, isToday, isFuture, pred }
  })

  const monthDays = Array.from({ length: currM.daysInMonth }, (_, i) => {
    const d   = new Date(currM.firstDay)
    d.setDate(i + 1)
    const ds  = localDate(d)
    const row = dailyRows.find(r => r.date === ds) ?? { date: ds, revenue: 0, staff_cost: 0, staff_pct: null }
    const isToday  = ds === localDate(now)
    const isFuture = d > now
    const dayIdx   = (d.getDay() + 6) % 7 // 0=Mon
    const pred     = predByDate[ds] ?? null
    return { ...row, dayName: String(i + 1), dateStr: ds, isToday, isFuture, dayIdx, pred }
  })

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

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>

          {/* Business selector */}
          <select
            value={bizId ?? ''}
            onChange={e => { setBizId(e.target.value); localStorage.setItem('cc_selected_biz', e.target.value) }}
            style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, fontWeight: 600, background: 'white', color: '#111', cursor: 'pointer' }}
          >
            {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>

          {/* Week / month navigator */}
          {viewMode === 'week' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button onClick={() => setWeekOffset(o => o - 1)} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #e5e7eb', background: 'white', cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#374151' }}>‹</button>
              <div style={{ minWidth: 160, textAlign: 'center', padding: '0 8px' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>Week {curr.weekNum}</div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>{curr.label}</div>
              </div>
              <button onClick={() => setWeekOffset(o => Math.min(o + 1, 0))} disabled={weekOffset === 0} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #e5e7eb', background: 'white', cursor: weekOffset === 0 ? 'not-allowed' : 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: weekOffset === 0 ? '#d1d5db' : '#374151' }}>›</button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button onClick={() => setMonthOffset(o => o - 1)} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #e5e7eb', background: 'white', cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#374151' }}>‹</button>
              <div style={{ minWidth: 160, textAlign: 'center', padding: '0 8px' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>{currM.label}</div>
              </div>
              <button onClick={() => setMonthOffset(o => Math.min(o + 1, 0))} disabled={monthOffset === 0} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #e5e7eb', background: 'white', cursor: monthOffset === 0 ? 'not-allowed' : 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: monthOffset === 0 ? '#d1d5db' : '#374151' }}>›</button>
            </div>
          )}

          {/* W / M toggle */}
          <div style={{ display: 'flex', background: '#f3f4f6', borderRadius: 8, padding: 3, gap: 2 }}>
            {(['week', 'month'] as const).map(m => (
              <button key={m} onClick={() => setViewMode(m)} style={{
                padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                background: viewMode === m ? 'white' : 'transparent',
                color:      viewMode === m ? '#111'   : '#9ca3af',
                boxShadow:  viewMode === m ? '0 1px 3px rgba(0,0,0,.1)' : 'none',
              }}>{m === 'week' ? 'W' : 'M'}</button>
            ))}
          </div>
        </div>

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

        {loading ? (
          <div style={{ padding: 80, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading…</div>
        ) : viewMode === 'week' ? (

          /* ══════════════════════════════════════════════════════════════════
             WEEK VIEW
          ══════════════════════════════════════════════════════════════════ */
          <>
            <WeatherStrip businessId={bizId ?? undefined} />
            {/* ── 4 KPI cards ────────────────────────────────────────────── */}
            <div className="kpi-row" style={{ marginBottom: 16 }}>
              <KpiCard
                label="Revenue"
                value={fmtKr(totalRev)}
                sub={`vs Week ${getWeekBounds(weekOffset - 1).weekNum}`}
                deltaVal={delta(totalRev, prevRev)}
                href="/revenue"
              />
              <KpiCard
                label="Labour Cost"
                value={fmtKr(totalLabour)}
                sub={`vs Week ${getWeekBounds(weekOffset - 1).weekNum}`}
                deltaVal={totalLabour > 0 && prevLabour > 0 ? { pct: Math.abs(delta(totalLabour, prevLabour)?.pct ?? 0), up: (delta(totalLabour, prevLabour)?.up ?? true) === false } : null}
                href="/staff"
              />
              <KpiCard
                label="Labour Cost %"
                value={totalRev > 0 ? fmtPct(labourPct) : '—'}
                sub={`Target ${targetPct}%${prevLabPct !== null ? ` · prev ${fmtPct(prevLabPct)}` : ''}`}
                deltaVal={null}
                ok={totalRev > 0 ? labourPct <= targetPct : null}
                href="/staff"
              />
              <KpiCard
                label={totalHours > 0 ? 'Hours / Rev per hr' : 'Hours'}
                value={totalHours > 0 ? `${Math.round(totalHours)}h` : '—'}
                sub={revPerHour > 0 ? `${Math.round(revPerHour).toLocaleString('en-GB')} kr/hr` : undefined}
                deltaVal={null}
                href="/staff"
              />
            </div>

            {/* ── Weekly chart: bars + margin line overlay ──────────────── */}
            <RevenueMarginChart
              days={weekDays}
              viewMode="week"
              weekNum={curr.weekNum}
              label={curr.label}
              fmtKr={fmtKr}
              fmtPct={fmtPct}
              weatherIcon={weatherIcon}
              targetPct={targetPct}
              tooltip={tooltip}
              setTooltip={setTooltip}
            />

            {/* ── Dept table + P&L ───────────────────────────────────────── */}
            <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 12, marginBottom: 16 }}>

              {/* Department table */}
              <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
                <div style={{ padding: '14px 20px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>Departments — Week {curr.weekNum}</div>
                  <a href="/departments" style={{ fontSize: 12, color: '#6366f1', textDecoration: 'none', fontWeight: 600 }}>View all →</a>
                </div>
                {(depts?.departments ?? []).length === 0 ? (
                  <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Run a sync to see department data</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#f9fafb' }}>
                        {['Department', 'Revenue', 'Labour', 'Lab%', 'GP%'].map(h => (
                          <th key={h} style={{ padding: '9px 14px', textAlign: h === 'Department' ? 'left' : 'right', fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.05em' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(depts.departments ?? []).map((d: any, i: number) => (
                        <tr key={d.name} style={{ borderBottom: '1px solid #f9fafb' }}>
                          <td style={{ padding: '10px 14px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 8, height: 8, borderRadius: '50%', background: d.color ?? '#9ca3af', flexShrink: 0 }} />
                              <a href={`/departments/${encodeURIComponent(d.name)}`} style={{ fontSize: 13, color: '#111', textDecoration: 'none', fontWeight: 500 }}>{d.name}</a>
                            </div>
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, color: '#111', fontWeight: 600 }}>
                            {d.revenue > 0 ? Math.round(d.revenue).toLocaleString('en-GB') : '—'}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, color: '#374151' }}>
                            {d.staff_cost > 0 ? Math.round(d.staff_cost).toLocaleString('en-GB') : '—'}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                            {d.labour_pct !== null ? (
                              <span style={{
                                fontSize: 12, fontWeight: 700, padding: '2px 7px', borderRadius: 20,
                                background: d.labour_pct > targetPct ? '#fee2e2' : '#dcfce7',
                                color:      d.labour_pct > targetPct ? '#dc2626' : '#16a34a',
                              }}>{fmtPct(d.labour_pct)}</span>
                            ) : <span style={{ color: '#d1d5db', fontSize: 13 }}>—</span>}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, color: d.gp_pct !== null ? (d.gp_pct >= 50 ? '#16a34a' : d.gp_pct >= 30 ? '#d97706' : '#dc2626') : '#d1d5db', fontWeight: d.gp_pct !== null ? 600 : 400 }}>
                            {d.gp_pct !== null ? fmtPct(d.gp_pct) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {depts?.summary && (
                      <tfoot>
                        <tr style={{ background: '#f9fafb', borderTop: '2px solid #e5e7eb' }}>
                          <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: '#374151' }}>Total</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: '#111' }}>{Math.round(depts.summary.total_revenue).toLocaleString('en-GB')}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: '#374151' }}>{Math.round(depts.summary.total_staff_cost).toLocaleString('en-GB')}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                            {depts.summary.labour_pct !== null && (
                              <span style={{ fontSize: 12, fontWeight: 700, color: depts.summary.labour_pct > targetPct ? '#dc2626' : '#16a34a' }}>{fmtPct(depts.summary.labour_pct)}</span>
                            )}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: depts.summary.gp_pct !== null ? (depts.summary.gp_pct >= 50 ? '#16a34a' : '#d97706') : '#d1d5db' }}>
                            {depts.summary.gp_pct !== null ? fmtPct(depts.summary.gp_pct) : '—'}
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                )}
              </div>

              {/* Right column: P&L + quick actions */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

                {/* Week P&L */}
                <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '18px 20px', flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111', marginBottom: 16 }}>P&L — Week {curr.weekNum}</div>
                  {[
                    { label: 'Revenue',     value: totalRev,    color: '#111',    prefix: '+' },
                    { label: 'Labour Cost', value: -totalLabour, color: '#374151', prefix: '' },
                  ].map(row => (
                    <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                      <span style={{ fontSize: 13, color: '#6b7280' }}>{row.label}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: row.color }}>
                        {row.value >= 0 ? (row.prefix + Math.round(row.value).toLocaleString('en-GB')) : '−' + Math.abs(Math.round(row.value)).toLocaleString('en-GB')} kr
                      </span>
                    </div>
                  ))}

                  {/* Gross margin line */}
                  <div style={{ marginTop: 12, padding: '12px 14px', background: '#f9fafb', borderRadius: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>Gross Margin</span>
                      <span style={{ fontSize: 18, fontWeight: 700, color: (totalRev - totalLabour) >= 0 ? '#16a34a' : '#dc2626' }}>
                        {totalRev > 0 ? fmtKr(totalRev - totalLabour) : '—'}
                      </span>
                    </div>
                    {totalRev > 0 && totalLabour > 0 && (
                      <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                        {fmtPct(((totalRev - totalLabour) / totalRev) * 100)} margin (after labour)
                      </div>
                    )}
                  </div>

                  {/* Hours + rev/hour */}
                  {totalHours > 0 && (
                    <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#9ca3af' }}>
                      <span>{Math.round(totalHours)}h worked</span>
                      {revPerHour > 0 && <span>{Math.round(revPerHour).toLocaleString('en-GB')} kr/hr</span>}
                    </div>
                  )}
                </div>

                {/* Quick links */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {[
                    { label: 'Staff',        href: '/staff',    icon: '👥' },
                    { label: 'AI Assistant', href: '/notebook', icon: '✦'  },
                    { label: 'Forecast',     href: '/forecast', icon: '📈' },
                    { label: 'Tracker',      href: '/tracker',  icon: '📋' },
                  ].map(a => (
                    <a key={a.href} href={a.href} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
                      background: 'white', border: '1px solid #e5e7eb', borderRadius: 10,
                      textDecoration: 'none', color: '#374151', fontSize: 12, fontWeight: 600,
                    }}>
                      <span style={{ fontSize: 16 }}>{a.icon}</span> {a.label}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          </>

        ) : (

          /* ══════════════════════════════════════════════════════════════════
             MONTH VIEW — same data sources as week, wider date range
          ══════════════════════════════════════════════════════════════════ */
          <>
            <WeatherStrip businessId={bizId ?? undefined} />
            {/* ── 4 KPI cards ────────────────────────────────────────────── */}
            <div className="kpi-row" style={{ marginBottom: 16 }}>
              <KpiCard
                label="Revenue"
                value={fmtKr(totalRev)}
                sub={`vs ${getMonthBounds(monthOffset - 1).label}`}
                deltaVal={delta(totalRev, prevRev)}
                href="/revenue"
              />
              <KpiCard
                label="Labour Cost"
                value={fmtKr(totalLabour)}
                sub={`vs ${getMonthBounds(monthOffset - 1).label}`}
                deltaVal={totalLabour > 0 && prevLabour > 0 ? { pct: Math.abs(delta(totalLabour, prevLabour)?.pct ?? 0), up: (delta(totalLabour, prevLabour)?.up ?? true) === false } : null}
                href="/staff"
              />
              <KpiCard
                label="Labour Cost %"
                value={totalRev > 0 ? fmtPct(labourPct) : '—'}
                sub={`Target ${targetPct}%${prevLabPct !== null ? ` · prev ${fmtPct(prevLabPct)}` : ''}`}
                deltaVal={null}
                ok={totalRev > 0 ? labourPct <= targetPct : null}
                href="/staff"
              />
              <KpiCard
                label={totalHours > 0 ? 'Hours / Rev per hr' : 'Hours'}
                value={totalHours > 0 ? `${Math.round(totalHours)}h` : '—'}
                sub={revPerHour > 0 ? `${Math.round(revPerHour).toLocaleString('en-GB')} kr/hr` : undefined}
                deltaVal={null}
                href="/staff"
              />
            </div>

            {/* ── Daily chart for the month: bars + gross-margin line ───── */}
            <RevenueMarginChart
              days={monthDays}
              viewMode="month"
              weekNum={0}
              label={`${currM.label} — Daily breakdown`}
              fmtKr={fmtKr}
              fmtPct={fmtPct}
              weatherIcon={weatherIcon}
              targetPct={targetPct}
              tooltip={tooltip}
              setTooltip={setTooltip}
            />

            {/* ── Dept table + P&L ───────────────────────────────────────── */}
            <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 12, marginBottom: 16 }}>

              {/* Department table */}
              <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
                <div style={{ padding: '14px 20px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>Departments — {currM.label}</div>
                  <a href="/departments" style={{ fontSize: 12, color: '#6366f1', textDecoration: 'none', fontWeight: 600 }}>View all →</a>
                </div>
                {(depts?.departments ?? []).length === 0 ? (
                  <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No department data available</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#f9fafb' }}>
                        {['Department', 'Revenue', 'Labour', 'Lab%', 'GP%'].map(h => (
                          <th key={h} style={{ padding: '9px 14px', textAlign: h === 'Department' ? 'left' : 'right', fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.05em' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(depts.departments ?? []).map((d: any) => (
                        <tr key={d.name} style={{ borderBottom: '1px solid #f9fafb' }}>
                          <td style={{ padding: '10px 14px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 8, height: 8, borderRadius: '50%', background: d.color ?? '#9ca3af', flexShrink: 0 }} />
                              <a href={`/departments/${encodeURIComponent(d.name)}`} style={{ fontSize: 13, color: '#111', textDecoration: 'none', fontWeight: 500 }}>{d.name}</a>
                            </div>
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 600, color: '#111' }}>
                            {d.revenue > 0 ? Math.round(d.revenue).toLocaleString('en-GB') : '—'}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, color: '#374151' }}>
                            {d.staff_cost > 0 ? Math.round(d.staff_cost).toLocaleString('en-GB') : '—'}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                            {d.labour_pct !== null ? (
                              <span style={{
                                fontSize: 12, fontWeight: 700, padding: '2px 7px', borderRadius: 20,
                                background: d.labour_pct > targetPct ? '#fee2e2' : '#dcfce7',
                                color:      d.labour_pct > targetPct ? '#dc2626' : '#16a34a',
                              }}>{fmtPct(d.labour_pct)}</span>
                            ) : <span style={{ color: '#d1d5db', fontSize: 13 }}>—</span>}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, color: d.gp_pct !== null ? (d.gp_pct >= 50 ? '#16a34a' : d.gp_pct >= 30 ? '#d97706' : '#dc2626') : '#d1d5db', fontWeight: d.gp_pct !== null ? 600 : 400 }}>
                            {d.gp_pct !== null ? fmtPct(d.gp_pct) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {depts?.summary && (
                      <tfoot>
                        <tr style={{ background: '#f9fafb', borderTop: '2px solid #e5e7eb' }}>
                          <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: '#374151' }}>Total</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: '#111' }}>{Math.round(depts.summary.total_revenue).toLocaleString('en-GB')}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: '#374151' }}>{Math.round(depts.summary.total_staff_cost).toLocaleString('en-GB')}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                            {depts.summary.labour_pct !== null && (
                              <span style={{ fontSize: 12, fontWeight: 700, color: depts.summary.labour_pct > targetPct ? '#dc2626' : '#16a34a' }}>{fmtPct(depts.summary.labour_pct)}</span>
                            )}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: depts.summary.gp_pct !== null ? (depts.summary.gp_pct >= 50 ? '#16a34a' : '#d97706') : '#d1d5db' }}>
                            {depts.summary.gp_pct !== null ? fmtPct(depts.summary.gp_pct) : '—'}
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                )}
              </div>

              {/* Right column: P&L + quick actions */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

                {/* Month P&L */}
                <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '18px 20px', flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111', marginBottom: 16 }}>P&L — {currM.label}</div>
                  {[
                    { label: 'Revenue',     value: totalRev,    color: '#111',    prefix: '+' },
                    { label: 'Labour Cost', value: -totalLabour, color: '#374151', prefix: '' },
                  ].map(row => (
                    <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                      <span style={{ fontSize: 13, color: '#6b7280' }}>{row.label}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: row.color }}>
                        {row.value >= 0 ? (row.prefix + Math.round(row.value).toLocaleString('en-GB')) : '−' + Math.abs(Math.round(row.value)).toLocaleString('en-GB')} kr
                      </span>
                    </div>
                  ))}

                  {/* Gross margin line */}
                  <div style={{ marginTop: 12, padding: '12px 14px', background: '#f9fafb', borderRadius: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>Gross Margin</span>
                      <span style={{ fontSize: 18, fontWeight: 700, color: (totalRev - totalLabour) >= 0 ? '#16a34a' : '#dc2626' }}>
                        {totalRev > 0 ? fmtKr(totalRev - totalLabour) : '—'}
                      </span>
                    </div>
                    {totalRev > 0 && totalLabour > 0 && (
                      <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                        {fmtPct(((totalRev - totalLabour) / totalRev) * 100)} margin (after labour)
                      </div>
                    )}
                  </div>

                  {/* Hours + rev/hour */}
                  {totalHours > 0 && (
                    <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#9ca3af' }}>
                      <span>{Math.round(totalHours)}h worked</span>
                      {revPerHour > 0 && <span>{Math.round(revPerHour).toLocaleString('en-GB')} kr/hr</span>}
                    </div>
                  )}
                </div>

                {/* Quick links */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {[
                    { label: 'Staff',        href: '/staff',    icon: '👥' },
                    { label: 'AI Assistant', href: '/notebook', icon: '✦'  },
                    { label: 'Forecast',     href: '/forecast', icon: '📈' },
                    { label: 'Tracker',      href: '/tracker',  icon: '📋' },
                  ].map(a => (
                    <a key={a.href} href={a.href} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
                      background: 'white', border: '1px solid #e5e7eb', borderRadius: 10,
                      textDecoration: 'none', color: '#374151', fontSize: 12, fontWeight: 600,
                    }}>
                      <span style={{ fontSize: 16 }}>{a.icon}</span> {a.label}
                    </a>
                  ))}
                </div>
              </div>
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
// RevenueMarginChart — bars for revenue + line overlay for gross margin %,
// works for both the 7-day week view and the 28–31-day month view. Bars for
// future dates render with an indigo stripe pattern so they read as forecasts
// at a glance, using data from the AI scheduling suggestion (weather +
// predicted revenue + planned/AI cost). Hover reveals the full detail.
// ─────────────────────────────────────────────────────────────────────────────
function RevenueMarginChart({ days, viewMode, weekNum, label, fmtKr, fmtPct, weatherIcon, targetPct, tooltip, setTooltip }: any) {
  const CHART_H = 200
  const isWeek  = viewMode === 'week'

  // Max revenue across actual + predicted so future-week bars scale fairly.
  const maxRev = Math.max(
    ...days.map((d: any) => Math.max(d.revenue, d.pred?.est_revenue ?? 0)),
    1,
  )

  // Compute each day's margin for the overlay line. Actuals use
  // (rev - staff_cost) / rev; predicted days use (est_rev - effective_cost) / est_rev
  // where effective_cost honours the "cuts only" policy.
  const points = days.map((d: any, i: number) => {
    const hasActual = d.revenue > 0
    const hasPred   = !hasActual && d.pred?.est_revenue > 0
    let margin: number | null = null
    if (hasActual && d.staff_cost > 0) {
      margin = ((d.revenue - d.staff_cost) / d.revenue) * 100
    } else if (hasPred) {
      const eff = d.pred.under_staffed_note ? d.pred.planned_cost : d.pred.ai_cost
      margin = d.pred.est_revenue > 0 ? ((d.pred.est_revenue - eff) / d.pred.est_revenue) * 100 : null
    }
    return { i, margin, hasActual, hasPred }
  })

  // Build the SVG polyline from consecutive points that have a margin value.
  // Missing points break the line rather than getting interpolated — cleaner
  // and more honest when a weekday has no data either side.
  const segments: Array<Array<{ x: number; y: number }>> = []
  let current: Array<{ x: number; y: number }> = []
  points.forEach((p: any, idx: number) => {
    if (p.margin == null) {
      if (current.length) { segments.push(current); current = [] }
      return
    }
    const xPct = ((idx + 0.5) / days.length) * 100
    const yPct = 100 - Math.max(0, Math.min(100, p.margin))  // invert: 100% at top
    current.push({ x: xPct, y: yPct })
  })
  if (current.length) segments.push(current)

  const hasAnyPred = days.some((d: any) => d.pred?.est_revenue > 0 && d.revenue === 0)

  return (
    <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' as const, gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>
          {isWeek ? `Week ${weekNum} — ${label}` : label}
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' as const, alignItems: 'center' }}>
          <LegendSwatch color="#1a1f2e" label="Revenue (actual)" />
          {hasAnyPred && (
            <LegendSwatch striped label="Revenue (predicted)" />
          )}
          <LegendSwatch color="#15803d" line label="Gross margin %" />
        </div>
      </div>

      {/* Chart area — bars + SVG overlay */}
      <div style={{ position: 'relative' as const, height: CHART_H + (isWeek ? 28 : 18), marginBottom: isWeek ? 2 : 2 }}>
        {/* Bars */}
        <div style={{
          display: 'flex', gap: isWeek ? 8 : 2,
          height: CHART_H, alignItems: 'flex-end',
          position: 'absolute' as const, left: 0, right: 0, top: 0,
        }}>
          {days.map((day: any) => {
            const hasActual = day.revenue > 0
            const hasPred   = !hasActual && day.pred?.est_revenue > 0
            const shownRev  = hasActual ? day.revenue : (day.pred?.est_revenue ?? 0)
            const h         = shownRev > 0 ? Math.max((shownRev / maxRev) * (CHART_H - 20), isWeek ? 4 : 3) : 0
            const isHover   = tooltip?.dateStr === day.dateStr
            const canHover  = hasActual || hasPred
            const isWeekend = !isWeek && day.dayIdx >= 5

            const labPct   = hasActual && day.staff_cost > 0 ? (day.staff_cost / day.revenue) * 100 : null
            const predEff  = day.pred ? (day.pred.under_staffed_note ? day.pred.planned_cost : day.pred.ai_cost) : 0
            const predMarg = hasPred && shownRev > 0 ? ((shownRev - predEff) / shownRev) * 100 : null

            return (
              <div
                key={day.dateStr}
                style={{ flex: 1, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: isWeek ? 6 : 3, cursor: canHover ? 'pointer' : 'default' }}
                onMouseEnter={() => canHover && setTooltip({ ...day, labPct, predMargin: predMarg, hasActual, hasPred })}
                onMouseLeave={() => setTooltip(null)}
              >
                {/* Weather icon above the bar (only where we have a forecast) */}
                {isWeek && day.pred?.weather && (
                  <div style={{ fontSize: 14, lineHeight: 1, marginTop: 0 }}>
                    {weatherIcon(day.pred.weather.weather_code)}
                  </div>
                )}
                {/* Bar */}
                <div style={{ flex: 1, width: '100%', display: 'flex', flexDirection: 'column' as const, justifyContent: 'flex-end' }}>
                  {hasActual ? (
                    <div style={{
                      height: h,
                      borderRadius: isWeek ? '5px 5px 0 0' : '3px 3px 0 0',
                      background: '#1a1f2e',
                      opacity: isHover ? 1 : 0.9,
                      transition: 'opacity 0.15s',
                      boxShadow: isHover ? '0 0 0 2px #6366f1' : 'none',
                    }} />
                  ) : hasPred ? (
                    <div style={{
                      height: h,
                      borderRadius: isWeek ? '5px 5px 0 0' : '3px 3px 0 0',
                      background: 'repeating-linear-gradient(135deg, #6366f1 0 6px, #a5b4fc 6px 12px)',
                      opacity: isHover ? 1 : 0.75,
                      transition: 'opacity 0.15s',
                      boxShadow: isHover ? '0 0 0 2px #6366f1' : 'none',
                    }} />
                  ) : (
                    <div style={{ height: 2, background: '#e5e7eb', borderRadius: 2 }} />
                  )}
                </div>
                {/* Day label */}
                <div style={{
                  fontSize: isWeek ? 11 : 8, fontWeight: day.isToday ? 700 : 400,
                  color: day.isToday ? '#6366f1' : isWeekend ? '#d1d5db' : '#9ca3af',
                }}>
                  {day.dayName}
                </div>
              </div>
            )
          })}
        </div>
        {/* SVG line overlay — gross margin %. 100% is at the top of the bar
            area; 0% at the bottom. Non-contiguous segments render as separate
            paths so gaps in data don't interpolate phantom margin. */}
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{ position: 'absolute' as const, left: 0, right: 0, top: 0, width: '100%', height: CHART_H, pointerEvents: 'none' as const }}
        >
          {/* 70% margin reference line (gentle) */}
          <line x1="0" y1="30" x2="100" y2="30" stroke="#e5e7eb" strokeWidth="0.3" strokeDasharray="1 1.5" />
          {/* Margin path */}
          {segments.map((seg, i) => {
            if (seg.length < 2) return null
            const d = seg.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
            return <path key={i} d={d} stroke="#15803d" strokeWidth="0.8" fill="none" vectorEffect="non-scaling-stroke" />
          })}
          {/* Margin dots */}
          {segments.flat().map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="0.9" fill="#15803d" vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div style={{ marginTop: 12, padding: '12px 16px', background: '#1a1f2e', borderRadius: 10, display: 'flex', gap: 24, flexWrap: 'wrap' as const }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', alignSelf: 'center', minWidth: 80 }}>
            {new Date(tooltip.dateStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}
            {!tooltip.hasActual && tooltip.hasPred && (
              <div style={{ fontSize: 10, color: '#a5b4fc', fontWeight: 700, marginTop: 2 }}>AI PREDICTED</div>
            )}
          </div>
          {tooltip.hasActual ? (
            [
              { label: 'Revenue',     value: fmtKr(tooltip.revenue),    color: 'white' },
              { label: 'Labour Cost', value: fmtKr(tooltip.staff_cost), color: '#f59e0b' },
              { label: 'Labour %',    value: fmtPct(tooltip.labPct ?? 0), color: (tooltip.labPct ?? 0) > targetPct ? '#f87171' : '#86efac' },
              { label: 'Margin %',    value: tooltip.revenue > 0 ? fmtPct(((tooltip.revenue - (tooltip.staff_cost ?? 0)) / tooltip.revenue) * 100) : '—', color: '#86efac' },
            ].map(col => (
              <div key={col.label}>
                <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 2 }}>{col.label}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: col.color }}>{col.value}</div>
              </div>
            ))
          ) : tooltip.hasPred && tooltip.pred ? (
            <>
              {tooltip.pred.weather && (
                <div>
                  <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 2 }}>Weather</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'white' }}>
                    {weatherIcon(tooltip.pred.weather.weather_code)} {tooltip.pred.weather.summary}
                  </div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>
                    {tooltip.pred.weather.temp_min != null ? `${Math.round(tooltip.pred.weather.temp_min)}–${Math.round(tooltip.pred.weather.temp_max)}°C` : ''}
                    {Number(tooltip.pred.weather.precip_mm) > 0.5 ? ` · ${tooltip.pred.weather.precip_mm}mm` : ''}
                  </div>
                </div>
              )}
              <div>
                <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 2 }}>Predicted sales</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'white' }}>{fmtKr(tooltip.pred.est_revenue)}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 2 }}>Your plan cost</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#f59e0b' }}>{fmtKr(tooltip.pred.planned_cost)}</div>
              </div>
              <div>
                <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 2 }}>AI suggestion</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#a5b4fc' }}>
                  {fmtKr(tooltip.pred.ai_cost)}
                  {tooltip.pred.delta_cost < 0 && (
                    <span style={{ fontSize: 11, color: '#86efac', fontWeight: 600, marginLeft: 6 }}>
                      save {fmtKr(Math.abs(tooltip.pred.delta_cost))}
                    </span>
                  )}
                </div>
              </div>
              {tooltip.predMargin != null && (
                <div>
                  <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 2 }}>Margin %</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: tooltip.predMargin >= 70 ? '#86efac' : tooltip.predMargin >= 55 ? '#fbbf24' : '#f87171' }}>
                    {Math.round(tooltip.predMargin)}%
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  )
}

function LegendSwatch({ color, striped, line, label }: any) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {line ? (
        <div style={{ width: 14, height: 0, borderTop: `2px solid ${color}`, borderRadius: 2 }} />
      ) : striped ? (
        <div style={{ width: 12, height: 10, borderRadius: 2, background: 'repeating-linear-gradient(135deg, #6366f1 0 4px, #a5b4fc 4px 8px)' }} />
      ) : (
        <div style={{ width: 12, height: 10, borderRadius: 2, background: color }} />
      )}
      <span style={{ fontSize: 11, color: '#9ca3af' }}>{label}</span>
    </div>
  )
}
