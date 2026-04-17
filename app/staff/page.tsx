'use client'
// @ts-nocheck
// app/staff/page.tsx — Staff costs, hours, lateness, OB
// Same W/M navigator pattern as dashboard

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'

const fmtKr  = (n: number) => Math.round(n).toLocaleString('en-GB') + ' kr'
const fmtPct = (n: number) => (Math.round(n * 10) / 10).toFixed(1) + '%'
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const DAYS   = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']

// ── Period helpers (same as dashboard) ────────────────────────────────────────
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
  const wk  = getISOWeek(mon)
  const mStr = localDate(mon), sStr = localDate(sun)
  const mM = MONTHS[mon.getMonth()], sM = MONTHS[sun.getMonth()]
  const label = mM === sM ? `${mon.getDate()}–${sun.getDate()} ${mM}` : `${mon.getDate()} ${mM} – ${sun.getDate()} ${sM}`
  return { from: mStr, to: sStr, weekNum: wk, label, mon }
}

function getMonthBounds(offset = 0) {
  const now  = new Date()
  const d    = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return { from: localDate(d), to: localDate(last), label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, firstDay: d, daysInMonth: last.getDate() }
}

function delta(cur: number, prev: number) {
  if (!prev) return null
  const p = ((cur - prev) / prev) * 100
  return { pct: Math.round(p * 10) / 10, up: p >= 0 }
}

// ── KPI Card ──────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, deltaVal, ok }: any) {
  return (
    <div style={{ background: 'white', borderRadius: 12, padding: '18px 20px', border: `1px solid ${ok === false ? '#fecaca' : '#e5e7eb'}` }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 10 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: '#111', marginBottom: 6, letterSpacing: '-0.5px' }}>{value}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 18 }}>
        {deltaVal && (
          <span style={{ fontSize: 12, fontWeight: 700, color: deltaVal.up ? '#16a34a' : '#dc2626' }}>
            {deltaVal.up ? '↑' : '↓'} {Math.abs(deltaVal.pct)}%
          </span>
        )}
        {sub && <span style={{ fontSize: 12, color: '#9ca3af' }}>{sub}</span>}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function StaffPage() {
  const [bizId,       setBizId]       = useState<string | null>(null)
  const [weekOffset,  setWeekOffset]  = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  const [viewMode,    setViewMode]    = useState<'week'|'month'>('week')
  const [staffData,   setStaffData]   = useState<any>(null)
  const [srData,      setSrData]      = useState<any>(null)
  const [prevSr,      setPrevSr]      = useState<any>(null)
  const [loading,     setLoading]     = useState(true)
  const [search,      setSearch]      = useState('')
  const [expanded,    setExpanded]    = useState<any>(null)
  const [tooltip,     setTooltip]     = useState<any>(null)

  // Sync with sidebar business switcher
  useEffect(() => {
    const sync = () => { const s = localStorage.getItem('cc_selected_biz'); if (s) setBizId(s) }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  // Fetch data
  useEffect(() => {
    if (!bizId) return
    setLoading(true)

    const biz  = `business_id=${bizId}`
    const curr = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
    const prev = viewMode === 'week' ? getWeekBounds(weekOffset - 1) : getMonthBounds(monthOffset - 1)

    Promise.all([
      // Per-staff breakdown (still needs raw staff_logs for individual data)
      fetch(`/api/staff?from=${curr.from}&to=${curr.to}&${biz}`).then(r => r.json()).catch(() => ({})),
      // Pre-computed daily metrics for chart + totals
      fetch(`/api/metrics/daily?from=${curr.from}&to=${curr.to}&${biz}`).then(r => r.json()).catch(() => ({})),
      fetch(`/api/metrics/daily?from=${prev.from}&to=${prev.to}&${biz}`).then(r => r.json()).catch(() => ({})),
    ]).then(([staff, sr, prevSrRes]) => {
      setStaffData(staff)
      // Map daily_metrics fields to what staff page expects
      const mapped = { ...sr, rows: (sr.rows ?? []).map((r: any) => ({ ...r, staff_pct: r.labour_pct })) }
      setSrData(mapped)
      setPrevSr(prevSrRes)
      setLoading(false)
    })
  }, [bizId, weekOffset, monthOffset, viewMode])

  // ── Derived values ─────────────────────────────────────────────────────────
  const now       = new Date()
  const curr      = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
  const periodLabel = viewMode === 'week' ? `Week ${(curr as any).weekNum}` : curr.label

  const summary   = staffData?.summary ?? null
  const connected = staffData?.connected ?? false
  const staff     = staffData?.staff ?? []
  const srRows    = srData?.rows ?? []
  const srSum     = srData?.summary ?? null

  const totalCost   = summary?.staff_cost_effective ?? 0
  const totalHours  = summary?.logged_hours ?? 0
  const lateShifts  = summary?.late_shifts ?? 0
  const totalOb     = summary?.total_ob_supplement ?? 0

  const prevTotalCost = prevSr?.summary?.total_staff_cost ?? 0
  const prevTotalRev  = prevSr?.summary?.total_revenue ?? 0
  const curRev        = srSum?.total_revenue ?? 0
  const labourPct     = curRev > 0 ? (totalCost / curRev) * 100 : 0
  const prevLabPct    = prevTotalRev > 0 && prevTotalCost > 0 ? (prevTotalCost / prevTotalRev) * 100 : null
  const targetPct     = srSum?.target_pct ?? 40

  // ── Build day grid for chart ────────────────────────────────────────────────
  const maxDayPct = Math.max(...srRows.map((r: any) => r.staff_pct ?? 0), targetPct + 5, 1)
  const dayCount  = viewMode === 'week' ? 7 : (curr as any).daysInMonth ?? 30
  const chartDays = Array.from({ length: dayCount }, (_, i) => {
    const d = viewMode === 'week' ? new Date((curr as any).mon) : new Date((curr as any).firstDay)
    d.setDate(d.getDate() + i)
    const ds  = localDate(d)
    const row = srRows.find((r: any) => r.date === ds)
    const isToday  = ds === localDate(now)
    const isFuture = d > now
    const dayIdx   = (d.getDay() + 6) % 7
    return {
      dateStr: ds, isToday, isFuture,
      dayName: viewMode === 'week' ? DAYS[dayIdx] : String(i + 1),
      pct: row?.staff_pct ?? null,
      cost: row?.staff_cost ?? 0,
      revenue: row?.revenue ?? 0,
      dayIdx,
    }
  })

  // ── Staff table ─────────────────────────────────────────────────────────────
  const filtered = staff.filter((s: any) =>
    !search || (s.name ?? '').toLowerCase().includes(search.toLowerCase()) || (s.group ?? '').toLowerCase().includes(search.toLowerCase())
  )
  const sorted = [...filtered].sort((a: any, b: any) => (b.effective_cost ?? b.cost_actual) - (a.effective_cost ?? a.cost_actual))

  // ── Auto-insights ──────────────────────────────────────────────────────────
  const insights: Array<{ text: string; type: 'warn' | 'info' | 'good' }> = []
  if (lateShifts > 0) {
    const worst = [...(staffData?.dept_lateness ?? [])].sort((a: any, b: any) => b.late_rate_pct - a.late_rate_pct)[0]
    if (worst?.late_rate_pct > 15) insights.push({ text: `${worst.dept}: ${worst.late_rate_pct.toFixed(0)}% late rate (${worst.late_count} shifts)`, type: 'warn' })
  }
  if (totalOb > 0 && totalCost > 0) {
    const obPct = (totalOb / totalCost) * 100
    if (obPct > 5) insights.push({ text: `OB supplements are ${fmtPct(obPct)} of total labour (${fmtKr(totalOb)})`, type: 'warn' })
  }
  if (srSum?.worst_day) insights.push({ text: `Highest cost day: ${new Date(srSum.worst_day.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${fmtPct(srSum.worst_day.pct)}`, type: 'warn' })
  if (srSum?.best_day) insights.push({ text: `Best day: ${new Date(srSum.best_day.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${fmtPct(srSum.best_day.pct)}`, type: 'good' })
  if (labourPct > 0 && labourPct <= targetPct) insights.push({ text: `Labour at ${fmtPct(labourPct)} — under ${targetPct}% target`, type: 'good' })
  const topLate = sorted.filter((s: any) => (s.late_shifts ?? 0) > 0).slice(0, 2)
  topLate.forEach((s: any) => insights.push({ text: `${s.name}: ${s.late_shifts} late shift${s.late_shifts > 1 ? 's' : ''} (avg ${s.avg_late_minutes}min)`, type: 'warn' }))

  return (
    <AppShell>
      <div className="page-wrap">

        {/* ── Header ──────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#111' }}>Staff</h1>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#9ca3af' }}>Hours, costs, lateness & OB supplements</p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Period navigator */}
            {viewMode === 'week' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button onClick={() => setWeekOffset(o => o - 1)} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #e5e7eb', background: 'white', cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#374151' }}>‹</button>
                <div style={{ minWidth: 140, textAlign: 'center' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>Week {(curr as any).weekNum}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{curr.label}</div>
                </div>
                <button onClick={() => setWeekOffset(o => Math.min(o + 1, 0))} disabled={weekOffset === 0} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #e5e7eb', background: 'white', cursor: weekOffset === 0 ? 'not-allowed' : 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: weekOffset === 0 ? '#d1d5db' : '#374151' }}>›</button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button onClick={() => setMonthOffset(o => o - 1)} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #e5e7eb', background: 'white', cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#374151' }}>‹</button>
                <div style={{ minWidth: 140, textAlign: 'center' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>{curr.label}</div>
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
        </div>

        {loading ? (
          <div style={{ padding: 80, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading...</div>
        ) : !connected ? (
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 48, textAlign: 'center' }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#111', marginBottom: 8 }}>Personalkollen not connected</div>
            <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 20 }}>Connect to see staff hours, costs and punctuality.</div>
            <a href="/integrations" style={{ padding: '10px 20px', background: '#1a1f2e', color: 'white', borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>Connect now</a>
          </div>
        ) : (
          <>
            {/* ── 4 KPI cards ────────────────────────────────────────── */}
            <div className="kpi-row" style={{ marginBottom: 16 }}>
              <KpiCard label="Labour Cost" value={fmtKr(totalCost)} deltaVal={delta(totalCost, prevTotalCost)} sub={`vs prev ${viewMode === 'week' ? 'week' : 'month'}`} />
              <KpiCard label="Labour %" value={curRev > 0 ? fmtPct(labourPct) : '—'} sub={`Target ${targetPct}%`} ok={curRev > 0 ? labourPct <= targetPct : null} />
              <KpiCard label="Hours Worked" value={totalHours > 0 ? `${Math.round(totalHours)}h` : '—'} sub={`${summary?.shifts_logged ?? 0} shifts`} />
              <KpiCard label="Late Arrivals" value={lateShifts > 0 ? String(lateShifts) : '0'} sub={lateShifts > 0 ? `avg ${Math.round((staffData?.dept_lateness ?? []).reduce((s: number, d: any) => s + d.total_late_minutes, 0) / Math.max(lateShifts, 1))} min late` : 'All on time'} ok={lateShifts === 0 ? true : lateShifts > 5 ? false : null} />
            </div>

            {/* ── Daily labour % chart ────────────────────────────────── */}
            {srRows.length > 0 && (
              <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>
                    Labour % — {periodLabel}
                  </div>
                  <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                    {srSum?.days_over_target > 0 && (
                      <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 600 }}>{srSum.days_over_target} days over target</span>
                    )}
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>Target: {targetPct}%</span>
                  </div>
                </div>

                {/* Vertical bars — one per day */}
                <div style={{ display: 'flex', gap: viewMode === 'week' ? 8 : 2, height: 180, alignItems: 'flex-end', position: 'relative' }}>
                  {/* Target line */}
                  <div style={{ position: 'absolute', left: 0, right: 0, bottom: `${(targetPct / maxDayPct) * 180}px`, height: 1, borderTop: '2px dashed #fcd34d', zIndex: 1 }} />

                  {chartDays.map((day) => {
                    const barH   = day.pct !== null ? Math.max((day.pct / maxDayPct) * 170, 3) : 0
                    const isOver = day.pct !== null && day.pct > targetPct
                    const color  = day.pct === null ? '#e5e7eb' : isOver ? '#dc2626' : '#16a34a'
                    const isHover = tooltip?.dateStr === day.dateStr

                    return (
                      <div
                        key={day.dateStr}
                        style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, cursor: day.pct !== null ? 'pointer' : 'default' }}
                        onMouseEnter={() => day.pct !== null && setTooltip(day)}
                        onMouseLeave={() => setTooltip(null)}
                      >
                        <div style={{ flex: 1, width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                          {day.pct !== null ? (
                            <div style={{
                              height: barH, borderRadius: '4px 4px 0 0',
                              background: color, opacity: isHover ? 1 : day.isFuture ? 0.3 : 0.8,
                              transition: 'opacity 0.15s',
                              boxShadow: isHover ? '0 0 0 2px #6366f1' : 'none',
                            }} />
                          ) : (
                            <div style={{ height: 2, background: day.isFuture ? '#f3f4f6' : '#e5e7eb', borderRadius: 2 }} />
                          )}
                        </div>

                        {/* Day label */}
                        <div style={{
                          fontSize: viewMode === 'week' ? 11 : 8,
                          fontWeight: day.isToday ? 700 : 400,
                          color: day.isToday ? '#6366f1' : day.dayIdx >= 5 ? '#d1d5db' : '#9ca3af',
                        }}>{day.dayName}</div>
                      </div>
                    )
                  })}
                </div>

                {/* Tooltip */}
                {tooltip && (
                  <div style={{ marginTop: 12, padding: '12px 16px', background: '#1a1f2e', borderRadius: 10, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', alignSelf: 'center', minWidth: 80 }}>
                      {new Date(tooltip.dateStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}
                    </div>
                    {[
                      { label: 'Labour %',    value: fmtPct(tooltip.pct), color: tooltip.pct > targetPct ? '#f87171' : '#86efac' },
                      { label: 'Labour Cost', value: fmtKr(tooltip.cost), color: '#f59e0b' },
                      { label: 'Revenue',     value: fmtKr(tooltip.revenue), color: 'white' },
                    ].map(col => (
                      <div key={col.label}>
                        <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 2 }}>{col.label}</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: col.color }}>{col.value}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Best / worst day */}
                {(srSum?.best_day || srSum?.worst_day) && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
                    {srSum.best_day && (
                      <div style={{ padding: '8px 12px', background: '#f0fdf4', borderRadius: 8, border: '1px solid #bbf7d0' }}>
                        <div style={{ fontSize: 10, color: '#15803d', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>Best day</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>
                          {new Date(srSum.best_day.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                          <span style={{ marginLeft: 8, color: '#15803d' }}>{fmtPct(srSum.best_day.pct)}</span>
                        </div>
                      </div>
                    )}
                    {srSum.worst_day && (
                      <div style={{ padding: '8px 12px', background: '#fef2f2', borderRadius: 8, border: '1px solid #fecaca' }}>
                        <div style={{ fontSize: 10, color: '#dc2626', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>Highest cost day</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>
                          {new Date(srSum.worst_day.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                          <span style={{ marginLeft: 8, color: '#dc2626' }}>{fmtPct(srSum.worst_day.pct)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── Staff table + Insights ──────────────────────────────── */}
            <div style={{ display: 'grid', gridTemplateColumns: insights.length > 0 ? '3fr 1fr' : '1fr', gap: 12 }}>

              {/* Staff table */}
              <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
                <div style={{ padding: '12px 20px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>{sorted.length} staff members</div>
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..."
                    style={{ padding: '6px 12px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, width: 180, fontFamily: 'inherit' }} />
                </div>

                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      {['Name', 'Dept', 'Hours', 'Cost', 'Cost/hr', 'Late', 'OB'].map(h => (
                        <th key={h} style={{ padding: '9px 14px', textAlign: h === 'Name' || h === 'Dept' ? 'left' : 'right', fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((s: any) => {
                      const isExp = expanded === s.id
                      const cost  = s.cost_actual > 0 ? s.cost_actual : s.estimated_salary
                      return (
                        <>
                          <tr key={s.id} onClick={() => setExpanded(isExp ? null : s.id)}
                            style={{ borderBottom: '1px solid #f9fafb', cursor: 'pointer', background: isExp ? '#fafbff' : 'white' }}>
                            <td style={{ padding: '10px 14px', fontWeight: 500, color: '#111', fontSize: 13 }}>
                              {s.name}
                            </td>
                            <td style={{ padding: '10px 14px', fontSize: 12, color: '#6b7280' }}>{s.group ?? '—'}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, color: '#111' }}>{s.hours_logged > 0 ? `${Math.round(s.hours_logged * 10) / 10}h` : '—'}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 600, color: '#111' }}>
                              {cost > 0 ? fmtKr(cost) : '—'}
                              {s.cost_actual === 0 && s.estimated_salary > 0 && <span style={{ fontSize: 9, color: '#d97706', marginLeft: 4 }}>est</span>}
                            </td>
                            <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, color: '#6b7280' }}>{s.cost_per_hour > 0 ? fmtKr(s.cost_per_hour) : '—'}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                              {(s.late_shifts ?? 0) > 0 ? (
                                <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: '#fef3c7', color: '#d97706' }}>{s.late_shifts}</span>
                              ) : <span style={{ color: '#d1d5db', fontSize: 12 }}>—</span>}
                            </td>
                            <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 12, color: s.ob_supplement_kr > 0 ? '#6366f1' : '#d1d5db' }}>
                              {s.ob_supplement_kr > 0 ? fmtKr(s.ob_supplement_kr) : '—'}
                            </td>
                          </tr>

                          {/* Expanded row */}
                          {isExp && (
                            <tr key={`exp-${s.id}`}>
                              <td colSpan={7} style={{ background: '#f9fafb', padding: '14px 20px', borderBottom: '1px solid #e5e7eb' }}>
                                <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 12 }}>
                                  {[
                                    { label: 'Estimated salary', value: s.estimated_salary > 0 ? fmtKr(s.estimated_salary) : '—' },
                                    { label: 'Actual cost',      value: s.cost_actual > 0 ? fmtKr(s.cost_actual) : 'Pending' },
                                    { label: 'Variance',         value: s.cost_variance !== 0 ? (s.cost_variance > 0 ? '+' : '') + fmtKr(s.cost_variance) : '—' },
                                    { label: 'Tax multiplier',   value: s.tax_multiplier ? s.tax_multiplier.toFixed(2) + '×' : '—' },
                                    { label: 'Shifts',           value: String(s.shifts_logged) },
                                  ].map(r => (
                                    <div key={r.label}>
                                      <div style={{ color: '#9ca3af', marginBottom: 2, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em' }}>{r.label}</div>
                                      <div style={{ fontWeight: 700, color: '#111' }}>{r.value}</div>
                                    </div>
                                  ))}
                                </div>

                                {(s.late_shifts ?? 0) > 0 && (
                                  <div style={{ marginTop: 10, padding: '6px 10px', background: '#fef3c7', borderRadius: 6, fontSize: 11, color: '#92400e' }}>
                                    {s.late_shifts} late shift{s.late_shifts > 1 ? 's' : ''}, avg {s.avg_late_minutes} min late
                                  </div>
                                )}

                                {s.ob_types && Object.keys(s.ob_types).length > 0 && (
                                  <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                    {Object.entries(s.ob_types).sort((a: any, b: any) => b[1] - a[1]).map(([type, kr]: any) => (
                                      <span key={type} style={{ fontSize: 11, padding: '3px 8px', background: '#f0f0ff', borderRadius: 6, border: '1px solid #e0e0ff', color: '#4f46e5' }}>
                                        {type}: <strong>{Math.round(kr).toLocaleString('en-GB')} kr</strong>
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </>
                      )
                    })}
                    {sorted.length === 0 && (
                      <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                        {search ? `No staff matching "${search}"` : 'No staff data for this period'}
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Insights sidebar */}
              {insights.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '16px 18px' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 12 }}>Insights</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {insights.slice(0, 6).map((ins, i) => (
                        <div key={i} style={{
                          fontSize: 12, padding: '8px 10px', borderRadius: 8, lineHeight: 1.4,
                          background: ins.type === 'warn' ? '#fef3c7' : ins.type === 'good' ? '#f0fdf4' : '#f3f4f6',
                          color: ins.type === 'warn' ? '#92400e' : ins.type === 'good' ? '#166534' : '#374151',
                          border: `1px solid ${ins.type === 'warn' ? '#fde68a' : ins.type === 'good' ? '#bbf7d0' : '#e5e7eb'}`,
                        }}>
                          {ins.text}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* OB summary card */}
                  {totalOb > 0 && (
                    <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '16px 18px' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 10 }}>OB Supplements</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: '#111', marginBottom: 6 }}>{fmtKr(totalOb)}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 10 }}>{summary?.shifts_with_ob ?? 0} shifts with OB</div>
                      {(summary?.ob_type_breakdown ?? []).map((ob: any) => (
                        <div key={ob.type} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12, borderBottom: '1px solid #f3f4f6' }}>
                          <span style={{ color: '#6b7280' }}>{ob.type}</span>
                          <span style={{ fontWeight: 600, color: '#111' }}>{fmtKr(ob.kr)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <AskAI
        page="staff"
        context={summary ? [
          `Period: ${curr.from} to ${curr.to}`,
          `Labour cost: ${fmtKr(totalCost)}, Hours: ${Math.round(totalHours)}h, ${summary.shifts_logged} shifts`,
          curRev > 0 ? `Labour %: ${fmtPct(labourPct)} (target ${targetPct}%)` : '',
          lateShifts > 0 ? `Late arrivals: ${lateShifts} shifts` : '',
          totalOb > 0 ? `OB supplements: ${fmtKr(totalOb)}` : '',
          sorted.length > 0 ? `Top staff by cost: ${sorted.slice(0, 5).map((s: any) => `${s.name} ${fmtKr(s.effective_cost ?? s.cost_actual)}`).join(', ')}` : '',
        ].filter(Boolean).join('\n') : 'No staff data loaded'}
      />
    </AppShell>
  )
}
