'use client'
// @ts-nocheck
// app/dashboard/page.tsx — CommandCenter main dashboard
// Week-first layout inspired by Personalkollen: KPIs → chart → dept table + P&L

import { useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'

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

  // ── Chart max ───────────────────────────────────────────────────────────────
  const maxDayRev = Math.max(...dailyRows.map(r => r.revenue), 1)

  // ── Build day grid — 7 days (week) or full month ───────────────────────────
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d   = new Date(curr.mon)
    d.setDate(curr.mon.getDate() + i)
    const ds  = localDate(d)
    const row = dailyRows.find(r => r.date === ds) ?? { date: ds, revenue: 0, staff_cost: 0, staff_pct: null }
    const isToday   = ds === localDate(now)
    const isFuture  = d > now
    return { ...row, dayName: DAYS[i], dateStr: ds, isToday, isFuture }
  })

  const monthDays = Array.from({ length: currM.daysInMonth }, (_, i) => {
    const d   = new Date(currM.firstDay)
    d.setDate(i + 1)
    const ds  = localDate(d)
    const row = dailyRows.find(r => r.date === ds) ?? { date: ds, revenue: 0, staff_cost: 0, staff_pct: null }
    const isToday  = ds === localDate(now)
    const isFuture = d > now
    const dayIdx   = (d.getDay() + 6) % 7 // 0=Mon
    return { ...row, dayName: String(i + 1), dateStr: ds, isToday, isFuture, dayIdx }
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

            {/* ── Main chart ─────────────────────────────────────────────── */}
            <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>
                  Week {curr.weekNum} — {curr.label}
                </div>
                <div style={{ display: 'flex', gap: 16 }}>
                  {[
                    { color: '#1a1f2e', label: 'Revenue' },
                    { color: '#f59e0b', label: 'Labour Cost' },
                  ].map(l => (
                    <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <div style={{ width: 10, height: 10, borderRadius: 2, background: l.color }} />
                      <span style={{ fontSize: 11, color: '#9ca3af' }}>{l.label}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Bars */}
              <div style={{ display: 'flex', gap: 8, height: 200, alignItems: 'flex-end', position: 'relative' }}>
                {weekDays.map((day, i) => {
                  const revH    = day.revenue > 0 ? Math.max((day.revenue / maxDayRev) * 180, 4) : 0
                  const labPct  = day.revenue > 0 && day.staff_cost > 0 ? (day.staff_cost / day.revenue) * 100 : 0
                  const isHover = tooltip?.dateStr === day.dateStr

                  return (
                    <div
                      key={day.dateStr}
                      style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, cursor: day.revenue > 0 ? 'pointer' : 'default' }}
                      onMouseEnter={e => day.revenue > 0 && setTooltip({ ...day, labPct })}
                      onMouseLeave={() => setTooltip(null)}
                    >
                      {/* Bar */}
                      <div style={{ flex: 1, width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                        {day.revenue > 0 ? (
                          <div style={{
                            height: revH,
                            borderRadius: '5px 5px 0 0',
                            background: `linear-gradient(to top, #f59e0b ${Math.min(labPct, 100)}%, #1a1f2e ${Math.min(labPct, 100)}%)`,
                            opacity: isHover ? 1 : day.isFuture ? 0.3 : 0.9,
                            transition: 'opacity 0.15s',
                            boxShadow: isHover ? '0 0 0 2px #6366f1' : 'none',
                          }} />
                        ) : day.isFuture ? (
                          <div style={{ height: 3, background: '#f3f4f6', borderRadius: 2 }} />
                        ) : (
                          <div style={{ height: 3, background: '#e5e7eb', borderRadius: 2 }} />
                        )}
                      </div>

                      {/* Labour % badge */}
                      <div style={{ fontSize: 10, fontWeight: 600, color: day.staff_pct !== null ? (day.staff_pct > targetPct ? '#dc2626' : '#16a34a') : '#d1d5db' }}>
                        {day.staff_pct !== null ? fmtPct(day.staff_pct) : '–'}
                      </div>

                      {/* Day label */}
                      <div style={{ fontSize: 11, color: day.isToday ? '#6366f1' : '#9ca3af', fontWeight: day.isToday ? 700 : 400 }}>
                        {day.dayName}
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Tooltip */}
              {tooltip && (
                <div style={{
                  marginTop: 12, padding: '12px 16px', background: '#1a1f2e', borderRadius: 10,
                  display: 'flex', gap: 24, flexWrap: 'wrap'
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', alignSelf: 'center', minWidth: 80 }}>
                    {new Date(tooltip.dateStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}
                  </div>
                  {[
                    { label: 'Revenue',      value: fmtKr(tooltip.revenue),    color: 'white' },
                    { label: 'Labour Cost',  value: fmtKr(tooltip.staff_cost), color: '#f59e0b' },
                    { label: 'Labour %',     value: fmtPct(tooltip.labPct),    color: tooltip.labPct > targetPct ? '#f87171' : '#86efac' },
                  ].map(col => (
                    <div key={col.label}>
                      <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 2 }}>{col.label}</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: col.color }}>{col.value}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

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

            {/* ── Daily bar chart for the month ─────────────────────────── */}
            <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>
                  {currM.label} — Daily breakdown
                </div>
                <div style={{ display: 'flex', gap: 16 }}>
                  {[
                    { color: '#1a1f2e', label: 'Revenue' },
                    { color: '#f59e0b', label: 'Labour Cost' },
                  ].map(l => (
                    <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <div style={{ width: 10, height: 10, borderRadius: 2, background: l.color }} />
                      <span style={{ fontSize: 11, color: '#9ca3af' }}>{l.label}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Bars — one per day of the month */}
              <div style={{ display: 'flex', gap: 2, height: 200, alignItems: 'flex-end', position: 'relative' }}>
                {monthDays.map((day) => {
                  const revH    = day.revenue > 0 ? Math.max((day.revenue / maxDayRev) * 180, 3) : 0
                  const labPct  = day.revenue > 0 && day.staff_cost > 0 ? (day.staff_cost / day.revenue) * 100 : 0
                  const isHover = tooltip?.dateStr === day.dateStr
                  const isWeekend = day.dayIdx >= 5

                  return (
                    <div
                      key={day.dateStr}
                      style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, cursor: day.revenue > 0 ? 'pointer' : 'default' }}
                      onMouseEnter={() => day.revenue > 0 && setTooltip({ ...day, labPct })}
                      onMouseLeave={() => setTooltip(null)}
                    >
                      {/* Bar */}
                      <div style={{ flex: 1, width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                        {day.revenue > 0 ? (
                          <div style={{
                            height: revH,
                            borderRadius: '3px 3px 0 0',
                            background: `linear-gradient(to top, #f59e0b ${Math.min(labPct, 100)}%, #1a1f2e ${Math.min(labPct, 100)}%)`,
                            opacity: isHover ? 1 : day.isFuture ? 0.3 : 0.85,
                            transition: 'opacity 0.15s',
                            boxShadow: isHover ? '0 0 0 2px #6366f1' : 'none',
                          }} />
                        ) : day.isFuture ? (
                          <div style={{ height: 2, background: '#f3f4f6', borderRadius: 2 }} />
                        ) : (
                          <div style={{ height: 2, background: '#e5e7eb', borderRadius: 2 }} />
                        )}
                      </div>

                      {/* Day label — show every day but smaller text */}
                      <div style={{
                        fontSize: 8, fontWeight: day.isToday ? 700 : 400,
                        color: day.isToday ? '#6366f1' : isWeekend ? '#d1d5db' : '#9ca3af',
                      }}>
                        {day.dayName}
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Tooltip */}
              {tooltip && (
                <div style={{
                  marginTop: 12, padding: '12px 16px', background: '#1a1f2e', borderRadius: 10,
                  display: 'flex', gap: 24, flexWrap: 'wrap'
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', alignSelf: 'center', minWidth: 80 }}>
                    {new Date(tooltip.dateStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}
                  </div>
                  {[
                    { label: 'Revenue',     value: fmtKr(tooltip.revenue),    color: 'white' },
                    { label: 'Labour Cost', value: fmtKr(tooltip.staff_cost), color: '#f59e0b' },
                    { label: 'Labour %',    value: fmtPct(tooltip.labPct),    color: tooltip.labPct > targetPct ? '#f87171' : '#86efac' },
                  ].map(col => (
                    <div key={col.label}>
                      <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 2 }}>{col.label}</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: col.color }}>{col.value}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

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
