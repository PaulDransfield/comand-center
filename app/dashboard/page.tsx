'use client'
// @ts-nocheck
// app/dashboard/page.tsx — CommandCenter main dashboard
// Week-first layout inspired by Personalkollen: KPIs → chart → dept table + P&L

import { useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtKr  = (n: number) => Math.round(n).toLocaleString('sv-SE') + ' kr'
const fmtPct = (n: number) => (Math.round(n * 10) / 10).toFixed(1) + '%'
const MONTHS = ['Jan','Feb','Mar','Apr','Maj','Jun','Jul','Aug','Sep','Okt','Nov','Dec']
const DAYS   = ['Mån','Tis','Ons','Tor','Fre','Lör','Sön']

// ── Week helpers ──────────────────────────────────────────────────────────────
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
  const mStr  = mon.toISOString().slice(0, 10)
  const sStr  = sun.toISOString().slice(0, 10)
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
      cursor: href ? 'pointer' : 'default', flex: 1,
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
  return href ? <a href={href} style={{ textDecoration: 'none', flex: 1 }}>{card}</a> : card
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [businesses,  setBusinesses]  = useState<any[]>([])
  const [bizId,       setBizId]       = useState<string | null>(null)
  const [weekOffset,  setWeekOffset]  = useState(0)
  const [viewMode,    setViewMode]    = useState<'week'|'month'>('week')
  const [dailyRows,   setDailyRows]   = useState<any[]>([])
  const [prevSummary, setPrevSummary] = useState<any>(null)
  const [depts,       setDepts]       = useState<any>(null)
  const [alerts,      setAlerts]      = useState<any[]>([])
  const [monthData,   setMonthData]   = useState<any[]>([])
  const [forecasts,   setForecasts]   = useState<any[]>([])
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

  // Load week/month data whenever biz or period changes
  useEffect(() => {
    if (!bizId) return
    setLoading(true)
    setDailyRows([])
    setPrevSummary(null)
    setDepts(null)

    if (viewMode === 'week') {
      const curr = getWeekBounds(weekOffset)
      const prev = getWeekBounds(weekOffset - 1)
      const biz  = `business_id=${bizId}`

      Promise.all([
        fetch(`/api/staff-revenue?from=${curr.from}&to=${curr.to}&${biz}`).then(r => r.json()).catch(() => ({})),
        fetch(`/api/staff-revenue?from=${prev.from}&to=${prev.to}&${biz}`).then(r => r.json()).catch(() => ({})),
        fetch(`/api/departments?from=${curr.from}&to=${curr.to}&${biz}`).then(r => r.json()).catch(() => ({})),
        fetch('/api/alerts').then(r => r.json()).catch(() => []),
      ]).then(([curr_, prev_, deptRes, alertRes]) => {
        setDailyRows(curr_.rows ?? [])
        setPrevSummary(prev_.summary ?? null)
        setDepts(deptRes ?? null)
        setAlerts(Array.isArray(alertRes) ? alertRes : [])
        setLoading(false)
      })
    } else {
      const year = new Date().getFullYear()
      const biz  = `business_id=${bizId}`
      Promise.all([
        fetch(`/api/tracker?year=${year}&${biz}`).then(r => r.json()).catch(() => ({})),
        fetch(`/api/forecast?${biz}`).then(r => r.json()).catch(() => ({})),
        fetch(`/api/departments?from=${year}-01-01&to=${year}-12-31&${biz}`).then(r => r.json()).catch(() => ({})),
        fetch('/api/alerts').then(r => r.json()).catch(() => []),
      ]).then(([trackerRes, forecastRes, deptRes, alertRes]) => {
        setMonthData(trackerRes.rows ?? [])
        setForecasts(forecastRes.forecasts ?? [])
        setDepts(deptRes ?? null)
        setAlerts(Array.isArray(alertRes) ? alertRes : [])
        setLoading(false)
      })
    }
  }, [bizId, weekOffset, viewMode])

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

  // ── Derived values (month mode) ────────────────────────────────────────────
  const now          = new Date()
  const curMonth     = now.getMonth() + 1
  const curYear      = now.getFullYear()
  const thisMonthRow = monthData.find(r => r.period_month === curMonth)
  const lastMonthRow = monthData.find(r => r.period_month === curMonth - 1)
  const nextForecast = forecasts.find(f => f.period_month === curMonth + 1)
  const ytdRev       = monthData.reduce((s, r) => s + Number(r.revenue ?? 0), 0)
  const maxMonthRev  = Math.max(...monthData.map(r => Number(r.revenue ?? 0)), 1)

  // ── Chart max (week) ────────────────────────────────────────────────────────
  const maxDayRev = Math.max(...dailyRows.map(r => r.revenue), 1)

  // ── Build 7-day grid (fill missing days as zeros) ──────────────────────────
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d   = new Date(curr.mon)
    d.setDate(curr.mon.getDate() + i)
    const ds  = d.toISOString().slice(0, 10)
    const row = dailyRows.find(r => r.date === ds) ?? { date: ds, revenue: 0, staff_cost: 0, staff_pct: null }
    const isToday   = ds === now.toISOString().slice(0, 10)
    const isFuture  = d > now
    return { ...row, dayName: DAYS[i], dateStr: ds, isToday, isFuture }
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
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>Vecka {curr.weekNum}</div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>{curr.label}</div>
              </div>
              <button onClick={() => setWeekOffset(o => Math.min(o + 1, 0))} disabled={weekOffset === 0} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #e5e7eb', background: 'white', cursor: weekOffset === 0 ? 'not-allowed' : 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: weekOffset === 0 ? '#d1d5db' : '#374151' }}>›</button>
            </div>
          ) : (
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{curYear} — year to date</div>
          )}

          {/* W / M toggle */}
          <div style={{ display: 'flex', background: '#f3f4f6', borderRadius: 8, padding: 3, gap: 2 }}>
            {(['week', 'month'] as const).map(m => (
              <button key={m} onClick={() => setViewMode(m)} style={{
                padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                background: viewMode === m ? 'white' : 'transparent',
                color:      viewMode === m ? '#111'   : '#9ca3af',
                boxShadow:  viewMode === m ? '0 1px 3px rgba(0,0,0,.1)' : 'none',
              }}>{m === 'week' ? 'V' : 'M'}</button>
            ))}
          </div>
        </div>

        {/* ── Alerts strip ────────────────────────────────────────────────── */}
        {alerts.filter(a => a.severity === 'high' || a.severity === 'critical').slice(0, 1).map(a => (
          <a key={a.id} href="/alerts" style={{ textDecoration: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10, padding: '10px 14px', marginBottom: 16 }}>
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
            <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
              <KpiCard
                label="Försäljning"
                value={fmtKr(totalRev)}
                sub={`vs Vecka ${getWeekBounds(weekOffset - 1).weekNum}`}
                deltaVal={delta(totalRev, prevRev)}
                href="/revenue"
              />
              <KpiCard
                label="Personalkostnad"
                value={fmtKr(totalLabour)}
                sub={`vs Vecka ${getWeekBounds(weekOffset - 1).weekNum}`}
                deltaVal={totalLabour > 0 && prevLabour > 0 ? { pct: Math.abs(delta(totalLabour, prevLabour)?.pct ?? 0), up: (delta(totalLabour, prevLabour)?.up ?? true) === false } : null}
                href="/staff"
              />
              <KpiCard
                label="Personalkostnad %"
                value={totalRev > 0 ? fmtPct(labourPct) : '—'}
                sub={`Mål ${targetPct}%${prevLabPct !== null ? ` · prev ${fmtPct(prevLabPct)}` : ''}`}
                deltaVal={null}
                ok={totalRev > 0 ? labourPct <= targetPct : null}
                href="/staff"
              />
              <KpiCard
                label={totalHours > 0 ? 'Timmar / Intäkt/tim' : 'Timmar'}
                value={totalHours > 0 ? `${Math.round(totalHours)}h` : '—'}
                sub={revPerHour > 0 ? `${Math.round(revPerHour).toLocaleString('sv-SE')} kr/tim` : undefined}
                deltaVal={null}
                href="/staff"
              />
            </div>

            {/* ── Main chart ─────────────────────────────────────────────── */}
            <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>
                  Vecka {curr.weekNum} — {curr.label}
                </div>
                <div style={{ display: 'flex', gap: 16 }}>
                  {[
                    { color: '#1a1f2e', label: 'Försäljning' },
                    { color: '#f59e0b', label: 'Personalkostnad' },
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
                    {new Date(tooltip.dateStr + 'T12:00:00').toLocaleDateString('sv-SE', { weekday: 'long', day: 'numeric', month: 'short' })}
                  </div>
                  {[
                    { label: 'Försäljning',       value: fmtKr(tooltip.revenue),    color: 'white' },
                    { label: 'Personalkostnad',    value: fmtKr(tooltip.staff_cost), color: '#f59e0b' },
                    { label: 'Personal %',         value: fmtPct(tooltip.labPct),    color: tooltip.labPct > targetPct ? '#f87171' : '#86efac' },
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
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>Avdelningar — Vecka {curr.weekNum}</div>
                  <a href="/departments" style={{ fontSize: 12, color: '#6366f1', textDecoration: 'none', fontWeight: 600 }}>Alla →</a>
                </div>
                {(depts?.departments ?? []).length === 0 ? (
                  <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Synkronisera för att se avdelningsdata</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#f9fafb' }}>
                        {['Avdelning', 'Intäkt', 'Personal', 'Pers%', 'GP%'].map(h => (
                          <th key={h} style={{ padding: '9px 14px', textAlign: h === 'Avdelning' ? 'left' : 'right', fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.05em' }}>{h}</th>
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
                            {d.revenue > 0 ? Math.round(d.revenue).toLocaleString('sv-SE') : '—'}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, color: '#374151' }}>
                            {d.staff_cost > 0 ? Math.round(d.staff_cost).toLocaleString('sv-SE') : '—'}
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
                          <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: '#374151' }}>Totalt</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: '#111' }}>{Math.round(depts.summary.total_revenue).toLocaleString('sv-SE')}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: '#374151' }}>{Math.round(depts.summary.total_staff_cost).toLocaleString('sv-SE')}</td>
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
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111', marginBottom: 16 }}>Resultat — Vecka {curr.weekNum}</div>
                  {[
                    { label: 'Försäljning',    value: totalRev,              color: '#111',     prefix: '+' },
                    { label: 'Personalkostnad', value: -totalLabour,          color: '#374151',  prefix: '' },
                  ].map(row => (
                    <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                      <span style={{ fontSize: 13, color: '#6b7280' }}>{row.label}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: row.color }}>
                        {row.value >= 0 ? (row.prefix + Math.round(row.value).toLocaleString('sv-SE')) : '−' + Math.abs(Math.round(row.value)).toLocaleString('sv-SE')} kr
                      </span>
                    </div>
                  ))}

                  {/* Gross margin line */}
                  <div style={{ marginTop: 12, padding: '12px 14px', background: '#f9fafb', borderRadius: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>Bruttomarginal</span>
                      <span style={{ fontSize: 18, fontWeight: 700, color: (totalRev - totalLabour) >= 0 ? '#16a34a' : '#dc2626' }}>
                        {totalRev > 0 ? fmtKr(totalRev - totalLabour) : '—'}
                      </span>
                    </div>
                    {totalRev > 0 && totalLabour > 0 && (
                      <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                        {fmtPct(((totalRev - totalLabour) / totalRev) * 100)} marginal (efter personal)
                      </div>
                    )}
                  </div>

                  {/* Hours + rev/hour */}
                  {totalHours > 0 && (
                    <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#9ca3af' }}>
                      <span>{Math.round(totalHours)}h arbetade</span>
                      {revPerHour > 0 && <span>{Math.round(revPerHour).toLocaleString('sv-SE')} kr/tim</span>}
                    </div>
                  )}
                </div>

                {/* Quick links */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {[
                    { label: 'Personalstyrka', href: '/staff',       icon: '👥' },
                    { label: 'AI-assistent',   href: '/notebook',    icon: '✦'  },
                    { label: 'Prognos',        href: '/forecast',    icon: '📈' },
                    { label: 'Tracker',        href: '/tracker',     icon: '📋' },
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
             MONTH VIEW
          ══════════════════════════════════════════════════════════════════ */
          <>
            {/* KPI cards */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
              <KpiCard
                label="Intäkt denna månad"
                value={thisMonthRow?.revenue > 0 ? fmtKr(thisMonthRow.revenue) : '—'}
                sub={`${MONTHS[curMonth - 1]} ${curYear}`}
                deltaVal={thisMonthRow?.revenue > 0 && lastMonthRow?.revenue > 0 ? delta(thisMonthRow.revenue, lastMonthRow.revenue) : null}
                href="/tracker"
              />
              <KpiCard
                label="Nettoresultat"
                value={thisMonthRow?.net_profit !== undefined ? fmtKr(thisMonthRow.net_profit) : '—'}
                sub={thisMonthRow?.net_profit > 0 && thisMonthRow?.revenue > 0 ? fmtPct(thisMonthRow.net_profit / thisMonthRow.revenue * 100) + ' marginal' : undefined}
                deltaVal={null}
                ok={thisMonthRow?.net_profit > 0}
                href="/tracker"
              />
              <KpiCard
                label="Hittills i år"
                value={ytdRev > 0 ? fmtKr(ytdRev) : '—'}
                sub={`${monthData.filter(r => r.revenue > 0).length} månader med data`}
                deltaVal={null}
                href="/tracker"
              />
              <KpiCard
                label={nextForecast ? `Prognos ${MONTHS[nextForecast.period_month - 1]}` : 'Nästa månad prognos'}
                value={nextForecast ? fmtKr(nextForecast.revenue_forecast) : '—'}
                sub={nextForecast ? fmtPct(nextForecast.margin_forecast) + ' marginal' : 'Kör sync för prognos'}
                deltaVal={null}
                href="/forecast"
              />
            </div>

            {/* Annual bar chart */}
            <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>Intäkt vs resultat — {curYear}</div>
                <a href="/tracker" style={{ fontSize: 12, color: '#6366f1', textDecoration: 'none', fontWeight: 600 }}>Fullständig P&L →</a>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 160 }}>
                {MONTHS.map((mon, i) => {
                  const m   = i + 1
                  const row = monthData.find(r => r.period_month === m)
                  const fc  = forecasts.find(f => f.period_month === m)
                  const rev = Number(row?.revenue ?? 0)
                  const net = Number(row?.net_profit ?? 0)
                  const fcR = Number(fc?.revenue_forecast ?? 0)
                  const isCur = m === curMonth
                  const isFut = m > curMonth

                  return (
                    <div key={mon} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                      <div style={{ width: '100%', flex: 1, display: 'flex', alignItems: 'flex-end', gap: 1 }}>
                        {isFut && fcR > 0 ? (
                          <div style={{ flex: 1, height: `${(fcR / maxMonthRev) * 100}%`, background: 'repeating-linear-gradient(45deg,#e5e7eb,#e5e7eb 2px,white 2px,white 5px)', borderRadius: '3px 3px 0 0', minHeight: 2 }} />
                        ) : rev > 0 ? (
                          <>
                            <div style={{ flex: 3, height: `${(rev / maxMonthRev) * 100}%`, background: isCur ? '#6366f1' : '#1a1f2e', borderRadius: '3px 3px 0 0', opacity: 0.9 }} />
                            {net > 0 && <div style={{ flex: 2, height: `${(net / maxMonthRev) * 100}%`, background: '#10b981', borderRadius: '3px 3px 0 0' }} />}
                          </>
                        ) : (
                          <div style={{ width: '100%', height: 2, background: '#f3f4f6' }} />
                        )}
                      </div>
                      <div style={{ fontSize: 9, color: isCur ? '#6366f1' : '#9ca3af', fontWeight: isCur ? 700 : 400 }}>{mon}</div>
                    </div>
                  )
                })}
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
                {[{ color: '#1a1f2e', label: 'Intäkt' }, { color: '#10b981', label: 'Resultat' }, { color: '#e5e7eb', label: 'Prognos', dashed: true }].map(l => (
                  <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <div style={{ width: 10, height: 8, borderRadius: 2, background: l.dashed ? 'repeating-linear-gradient(45deg,#9ca3af,#9ca3af 1px,white 1px,white 3px)' : l.color, border: l.dashed ? '1px solid #e5e7eb' : 'none' }} />
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>{l.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Dept table (year to date) */}
            <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>Avdelningar — {curYear}</div>
                <a href="/departments" style={{ fontSize: 12, color: '#6366f1', textDecoration: 'none', fontWeight: 600 }}>Alla →</a>
              </div>
              {(depts?.departments ?? []).length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Ingen avdelningsdata tillgänglig</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      {['Avdelning', 'Intäkt', 'Personal', 'Pers%', 'GP%', 'Tim'].map(h => (
                        <th key={h} style={{ padding: '9px 14px', textAlign: h === 'Avdelning' ? 'left' : 'right', fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(depts.departments ?? []).map((d: any) => (
                      <tr key={d.name} style={{ borderBottom: '1px solid #f9fafb' }}>
                        <td style={{ padding: '10px 14px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: d.color ?? '#9ca3af' }} />
                            <a href={`/departments/${encodeURIComponent(d.name)}`} style={{ fontSize: 13, color: '#111', textDecoration: 'none' }}>{d.name}</a>
                          </div>
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 600, color: '#111' }}>{d.revenue > 0 ? Math.round(d.revenue).toLocaleString('sv-SE') : '—'}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, color: '#374151' }}>{d.staff_cost > 0 ? Math.round(d.staff_cost).toLocaleString('sv-SE') : '—'}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                          {d.labour_pct !== null ? (
                            <span style={{ fontSize: 12, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: d.labour_pct > targetPct ? '#fee2e2' : '#dcfce7', color: d.labour_pct > targetPct ? '#dc2626' : '#16a34a' }}>
                              {fmtPct(d.labour_pct)}
                            </span>
                          ) : '—'}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 600, color: d.gp_pct !== null ? (d.gp_pct >= 50 ? '#16a34a' : '#d97706') : '#d1d5db' }}>{d.gp_pct !== null ? fmtPct(d.gp_pct) : '—'}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, color: '#9ca3af' }}>{d.hours > 0 ? Math.round(d.hours) + 'h' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>

      <AskAI
        page="dashboard"
        context={selectedBiz ? [
          `Företag: ${selectedBiz.name}`,
          viewMode === 'week'
            ? `Vecka ${curr.weekNum} (${curr.label}): intäkt ${fmtKr(totalRev)}, personalkostnad ${fmtKr(totalLabour)} (${totalRev > 0 ? fmtPct(labourPct) : '—'}), ${Math.round(totalHours)}h`
            : `${curYear} hittills: ${fmtKr(ytdRev)}`,
          depts?.summary ? `Avdelningar: ${(depts.departments ?? []).map((d: any) => `${d.name} ${d.revenue > 0 ? fmtKr(d.revenue) : 'ingen intäkt'}`).join(', ')}` : '',
        ].filter(Boolean).join('\n') : 'Inget företag valt'}
      />
    </AppShell>
  )
}
