'use client'
// @ts-nocheck
// app/departments/[id]/page.tsx — Single department detail with W/M navigator
export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { deptColor } from '@/lib/constants/colors'

const fmtKr  = (n: number) => Math.round(n).toLocaleString('en-GB') + ' kr'
const fmtPct = (n: number | null) => n != null ? n.toFixed(1) + '%' : '—'
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const fmtH   = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-GB') + 'h'
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const DAYS   = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']

function getISOWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = date.getUTCDay() || 7; date.setUTCDate(date.getUTCDate() + 4 - day)
  return Math.ceil(((date.getTime() - new Date(Date.UTC(date.getUTCFullYear(), 0, 1)).getTime()) / 86400000 + 1) / 7)
}
function getWeekBounds(offset = 0) {
  const today = new Date(), dow = today.getDay()
  const mon = new Date(today); mon.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1) + offset * 7); mon.setHours(0,0,0,0)
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
  const mM = MONTHS[mon.getMonth()], sM = MONTHS[sun.getMonth()]
  return { from: localDate(mon), to: localDate(sun), weekNum: getISOWeek(mon), label: mM === sM ? `${mon.getDate()}–${sun.getDate()} ${mM}` : `${mon.getDate()} ${mM} – ${sun.getDate()} ${sM}`, mon }
}
function getMonthBounds(offset = 0) {
  const now = new Date(), d = new Date(now.getFullYear(), now.getMonth() + offset, 1), last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return { from: localDate(d), to: localDate(last), label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, firstDay: d, daysInMonth: last.getDate() }
}

export default function DepartmentDetailPage() {
  const params   = useParams()
  const router   = useRouter()
  const deptName = decodeURIComponent(params.id as string)

  const [bizId,       setBizId]       = useState<string | null>(null)
  const [weekOffset,  setWeekOffset]  = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  // Default to month — week view lands on the current week which, early in
  // the week, has no synced revenue/labour data yet and shows all dashes.
  // Month matches the dept list's default and gives the user useful numbers
  // on first load. They can flip to week once they're exploring.
  const [viewMode,    setViewMode]    = useState<'week'|'month'>('month')
  const [data,        setData]        = useState<any>(null)
  const [loading,     setLoading]     = useState(true)
  const [tooltip,     setTooltip]     = useState<any>(null)

  useEffect(() => {
    const sync = () => { const s = localStorage.getItem('cc_selected_biz'); if (s) setBizId(s) }
    sync(); window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  useEffect(() => {
    if (!bizId) return
    setLoading(true)
    const curr = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
    fetch(`/api/departments/${encodeURIComponent(deptName)}?from=${curr.from}&to=${curr.to}&business_id=${bizId}`)
      .then(r => r.json()).then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [bizId, deptName, weekOffset, monthOffset, viewMode])

  const now = new Date()
  const curr = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
  const periodLabel = viewMode === 'week' ? `Week ${(curr as any).weekNum}` : curr.label

  const summary = data?.summary ?? {}
  const trend   = data?.trend ?? []
  const staff   = data?.staff ?? []
  const color   = data?.color ?? deptColor(deptName)

  // Chart data
  const dayCount = viewMode === 'week' ? 7 : (curr as any).daysInMonth ?? 30
  const chartDays = Array.from({ length: dayCount }, (_, i) => {
    const d = viewMode === 'week' ? new Date((curr as any).mon) : new Date((curr as any).firstDay)
    d.setDate(d.getDate() + i)
    const ds = localDate(d)
    const row = trend.find((t: any) => t.date === ds)
    const dayIdx = (d.getDay() + 6) % 7
    return { dateStr: ds, revenue: row?.revenue ?? 0, covers: row?.covers ?? 0, dayName: viewMode === 'week' ? DAYS[dayIdx] : String(i + 1), isToday: ds === localDate(now), isFuture: d > now, dayIdx }
  })
  const maxRev = Math.max(...chartDays.map(d => d.revenue), 1)

  return (
    <AppShell>
      <div className="page-wrap">

        {/* Breadcrumb */}
        <button onClick={() => router.push('/departments')} style={{ background: 'none', border: 'none', fontSize: 12, color: '#9ca3af', cursor: 'pointer', padding: 0, marginBottom: 8 }}>← Departments</button>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 14, height: 14, borderRadius: '50%', background: color }} />
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#111' }}>{deptName}</h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                <div style={{ minWidth: 140, textAlign: 'center' }}><div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>{curr.label}</div></div>
                <button onClick={() => setMonthOffset(o => Math.min(o + 1, 0))} disabled={monthOffset === 0} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #e5e7eb', background: 'white', cursor: monthOffset === 0 ? 'not-allowed' : 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: monthOffset === 0 ? '#d1d5db' : '#374151' }}>›</button>
              </div>
            )}
            <div style={{ display: 'flex', background: '#f3f4f6', borderRadius: 8, padding: 3, gap: 2 }}>
              {(['week', 'month'] as const).map(m => (
                <button key={m} onClick={() => setViewMode(m)} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: viewMode === m ? 'white' : 'transparent', color: viewMode === m ? '#111' : '#9ca3af', boxShadow: viewMode === m ? '0 1px 3px rgba(0,0,0,.1)' : 'none' }}>{m === 'week' ? 'W' : 'M'}</button>
              ))}
            </div>
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 80, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading...</div>
        ) : (summary.revenue ?? 0) === 0 && (summary.staff_cost ?? 0) === 0 ? (
          <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '40px 24px', textAlign: 'center' as const }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#111', marginBottom: 6 }}>
              No data for {deptName} in {periodLabel}
            </div>
            <div style={{ fontSize: 13, color: '#6b7280', maxWidth: 420, margin: '0 auto 14px' }}>
              {viewMode === 'week' && weekOffset === 0
                ? 'This week has only just started — the daily sync runs at 06:00 UTC so today\'s numbers land tomorrow morning. Try the previous week or switch to Month.'
                : 'Nothing synced for this period yet. Try a different week/month, or run a sync from the admin panel if you\'re waiting on data.'}
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
              {viewMode === 'week' ? (
                <>
                  <button onClick={() => setWeekOffset(o => o - 1)} style={{ padding: '8px 14px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12, fontWeight: 600, color: '#374151', cursor: 'pointer' }}>
                    ← Previous week
                  </button>
                  <button onClick={() => setViewMode('month')} style={{ padding: '8px 14px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                    View this month
                  </button>
                </>
              ) : (
                <button onClick={() => setMonthOffset(o => o - 1)} style={{ padding: '8px 14px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12, fontWeight: 600, color: '#374151', cursor: 'pointer' }}>
                  ← Previous month
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* KPI cards */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
              {[
                { label: 'Revenue', value: summary.revenue > 0 ? fmtKr(summary.revenue) : '—', sub: summary.covers > 0 ? `${summary.covers} covers · ${fmtKr(summary.avg_spend)} avg` : '', accent: color },
                { label: 'Labour Cost', value: summary.staff_cost > 0 ? fmtKr(summary.staff_cost) : '—', sub: `${fmtH(summary.hours ?? 0)} · ${summary.shifts ?? 0} shifts`, accent: null },
                { label: 'Labour %', value: fmtPct(summary.labour_pct), sub: 'of revenue', accent: summary.labour_pct > 40 ? '#dc2626' : summary.labour_pct > 30 ? '#d97706' : '#10b981' },
                { label: 'GP%', value: fmtPct(summary.gp_pct), sub: summary.rev_per_hour > 0 ? `${fmtKr(summary.rev_per_hour)}/hr` : '', accent: summary.gp_pct >= 50 ? '#10b981' : summary.gp_pct >= 30 ? '#d97706' : '#dc2626' },
              ].map(k => (
                <div key={k.label} style={{ flex: 1, background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '18px 20px', borderTop: k.accent ? `3px solid ${k.accent}` : undefined }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 10 }}>{k.label}</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: '#111', marginBottom: 4 }}>{k.value}</div>
                  <div style={{ fontSize: 12, color: '#9ca3af' }}>{k.sub}</div>
                </div>
              ))}
            </div>

            {/* OB + Late row */}
            {(summary.ob_supplement > 0 || summary.late_shifts > 0) && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                {summary.ob_supplement > 0 && (
                  <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '14px 16px' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 4 }}>OB Supplements</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#111' }}>{fmtKr(summary.ob_supplement)}</div>
                    {summary.ob_type_breakdown?.length > 0 && (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                        {summary.ob_type_breakdown.map((ob: any) => (
                          <span key={ob.type} style={{ fontSize: 11, background: '#eff6ff', color: '#3b82f6', borderRadius: 4, padding: '2px 6px' }}>{ob.type}: {fmtKr(ob.kr)}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {summary.late_shifts > 0 && (
                  <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '14px 16px' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 4 }}>Late Arrivals</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#d97706' }}>{summary.late_shifts} shift{summary.late_shifts !== 1 ? 's' : ''}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>avg {summary.avg_late_minutes} min late</div>
                  </div>
                )}
              </div>
            )}

            {/* Revenue chart */}
            <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#111', marginBottom: 16 }}>Daily revenue — {periodLabel}</div>
              <div style={{ display: 'flex', gap: viewMode === 'week' ? 8 : 2, height: 160, alignItems: 'flex-end' }}>
                {chartDays.map((day) => {
                  const h = day.revenue > 0 ? Math.max((day.revenue / maxRev) * 140, 3) : 0
                  const isHover = tooltip?.dateStr === day.dateStr
                  return (
                    <div key={day.dateStr} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, cursor: day.revenue > 0 ? 'pointer' : 'default' }}
                      onMouseEnter={() => day.revenue > 0 && setTooltip(day)} onMouseLeave={() => setTooltip(null)}>
                      <div style={{ flex: 1, width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                        {day.revenue > 0 ? (
                          <div style={{ height: h, borderRadius: '4px 4px 0 0', background: color, opacity: isHover ? 1 : day.isFuture ? 0.3 : 0.8, boxShadow: isHover ? '0 0 0 2px #6366f1' : 'none' }} />
                        ) : <div style={{ height: 2, background: '#e5e7eb', borderRadius: 2 }} />}
                      </div>
                      <div style={{ fontSize: viewMode === 'week' ? 11 : 8, color: day.isToday ? '#6366f1' : '#9ca3af', fontWeight: day.isToday ? 700 : 400 }}>{day.dayName}</div>
                    </div>
                  )
                })}
              </div>
              {tooltip && (
                <div style={{ marginTop: 12, padding: '10px 14px', background: '#1a1f2e', borderRadius: 10, display: 'flex', gap: 20 }}>
                  <span style={{ fontSize: 11, color: '#9ca3af' }}>{new Date(tooltip.dateStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'white' }}>{fmtKr(tooltip.revenue)}</span>
                  {tooltip.covers > 0 && <span style={{ fontSize: 12, color: '#86efac' }}>{tooltip.covers} covers</span>}
                </div>
              )}
            </div>

            {/* Staff table */}
            {staff.length > 0 && (
              <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
                <div style={{ padding: '12px 20px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>Staff in {deptName}</div>
                  <div style={{ fontSize: 12, color: '#9ca3af' }}>{staff.length} people · {fmtH(summary.hours ?? 0)}</div>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      {['Name','Hours','Cost','Cost/hr','Shifts','Late'].map(h => (
                        <th key={h} style={{ padding: '9px 14px', textAlign: h === 'Name' ? 'left' : 'right', fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {staff.map((s: any) => (
                      <tr key={s.name} style={{ borderBottom: '1px solid #f9fafb' }}>
                        <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 500, color: '#111' }}>
                          {s.name}
                          {summary.staff_cost > 0 && <div style={{ height: 3, background: '#f3f4f6', borderRadius: 2, width: 60, marginTop: 3 }}><div style={{ height: '100%', background: color, borderRadius: 2, width: `${(s.cost / summary.staff_cost) * 100}%` }} /></div>}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, color: '#374151' }}>{fmtH(s.hours)}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 600, color: '#111' }}>{fmtKr(s.cost)}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, color: '#6b7280' }}>{s.cost_per_hour > 0 ? fmtKr(s.cost_per_hour) : '—'}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, color: '#6b7280' }}>{s.shifts}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                          {s.late_shifts > 0 ? <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: '#fef3c7', color: '#d97706' }}>{s.late_shifts}</span> : <span style={{ color: '#d1d5db' }}>—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  )
}
