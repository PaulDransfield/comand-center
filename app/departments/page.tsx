'use client'
// @ts-nocheck
// app/departments/page.tsx — Department overview with W/M navigator
export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { deptColor } from '@/lib/constants/colors'

const fmtKr  = (n: number) => Math.round(n).toLocaleString('en-GB') + ' kr'
const fmtPct = (n: number | null) => n != null ? n.toFixed(1) + '%' : '—'
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const fmtH   = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-GB') + 'h'
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function getISOWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = date.getUTCDay() || 7; date.setUTCDate(date.getUTCDate() + 4 - day)
  const y1 = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - y1.getTime()) / 86400000 + 1) / 7)
}
function getWeekBounds(offset = 0) {
  const today = new Date(), dow = today.getDay()
  const mon = new Date(today); mon.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1) + offset * 7); mon.setHours(0,0,0,0)
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
  const mM = MONTHS[mon.getMonth()], sM = MONTHS[sun.getMonth()]
  return { from: localDate(mon), to: localDate(sun), weekNum: getISOWeek(mon), label: mM === sM ? `${mon.getDate()}–${sun.getDate()} ${mM}` : `${mon.getDate()} ${mM} – ${sun.getDate()} ${sM}` }
}
function getMonthBounds(offset = 0) {
  const now = new Date(), d = new Date(now.getFullYear(), now.getMonth() + offset, 1), last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return { from: localDate(d), to: localDate(last), label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` }
}

export default function DepartmentsPage() {
  const router = useRouter()
  const [bizId,       setBizId]       = useState<string | null>(null)
  const [weekOffset,  setWeekOffset]  = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  const [viewMode,    setViewMode]    = useState<'week'|'month'>('week')
  const [data,        setData]        = useState<any>(null)
  const [loading,     setLoading]     = useState(true)

  useEffect(() => {
    const sync = () => { const s = localStorage.getItem('cc_selected_biz'); if (s) setBizId(s) }
    sync(); window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  useEffect(() => {
    if (!bizId) return
    setLoading(true)
    const curr = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
    fetch(`/api/departments?from=${curr.from}&to=${curr.to}&business_id=${bizId}`)
      .then(r => r.json()).then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [bizId, weekOffset, monthOffset, viewMode])

  const depts: any[]  = data?.departments ?? []
  const summary: any  = data?.summary ?? {}
  const curr = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
  const periodLabel = viewMode === 'week' ? `Week ${(curr as any).weekNum}` : curr.label

  const deptsWithGP = depts.filter(d => d.gp_pct != null && d.revenue > 0)
  const best  = deptsWithGP.reduce((a, b) => (b.gp_pct > a.gp_pct ? b : a), deptsWithGP[0] ?? null)
  const worst = deptsWithGP.reduce((a, b) => (b.gp_pct < a.gp_pct ? b : a), deptsWithGP[0] ?? null)

  return (
    <AppShell>
      <div className="page-wrap">

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#111' }}>Departments</h1>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#9ca3af' }}>Revenue, labour cost & margin per department</p>
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
        ) : depts.length === 0 ? (
          <div style={{ padding: 80, textAlign: 'center', color: '#9ca3af' }}>
            <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 8 }}>No department data</div>
            <div style={{ fontSize: 13 }}>Try a different period or check that Personalkollen has synced.</div>
          </div>
        ) : (
          <>
            {/* KPI cards */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
              {[
                { label: 'Total Revenue',  value: fmtKr(summary.total_revenue ?? 0), sub: `${summary.total_covers ?? 0} covers` },
                { label: 'Total Labour',   value: fmtKr(summary.total_staff_cost ?? 0), sub: fmtH(summary.total_hours ?? 0) },
                { label: 'Labour %',       value: fmtPct(summary.labour_pct), sub: 'of revenue' },
                { label: 'Rev / Hour',     value: summary.rev_per_hour ? fmtKr(summary.rev_per_hour) : '—', sub: 'revenue per labour hour' },
              ].map(k => (
                <div key={k.label} style={{ flex: 1, background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '18px 20px' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 10 }}>{k.label}</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: '#111', marginBottom: 4 }}>{k.value}</div>
                  <div style={{ fontSize: 12, color: '#9ca3af' }}>{k.sub}</div>
                </div>
              ))}
            </div>

            {/* Best / worst GP */}
            {deptsWithGP.length >= 2 && best && worst && best.name !== worst.name && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: best.color ?? deptColor(best.name) }} />
                  <div><div style={{ fontSize: 10, fontWeight: 700, color: '#15803d', textTransform: 'uppercase', letterSpacing: '.06em' }}>Best GP%</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{best.name} — {fmtPct(best.gp_pct)}</div></div>
                </div>
                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: worst.color ?? deptColor(worst.name) }} />
                  <div><div style={{ fontSize: 10, fontWeight: 700, color: '#dc2626', textTransform: 'uppercase', letterSpacing: '.06em' }}>Needs attention</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{worst.name} — {fmtPct(worst.gp_pct)}</div></div>
                </div>
              </div>
            )}

            {/* Full table — revenue vs profit at a glance, same style as dashboard */}
            <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>Departments — {periodLabel}</div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>Click a row for the full department drill-down</div>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {['Department','Revenue','Profit','GP%','Labour','Lab%','Rev/Hr','Hours'].map(h => (
                      <th key={h} style={{ padding: '9px 14px', textAlign: h === 'Department' ? 'left' : 'right', fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.05em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...depts].sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0)).map(d => {
                    // Gross profit = revenue minus labour (the only cost we see per-dept).
                    // This is department-level GP, not bottom-line net profit.
                    const profit = Math.max(0, Number(d.revenue ?? 0) - Number(d.staff_cost ?? 0))
                    return (
                      <tr key={d.name} style={{ borderBottom: '1px solid #f9fafb', cursor: 'pointer' }} onClick={() => router.push(`/departments/${encodeURIComponent(d.name)}`)}>
                        <td style={{ padding: '10px 14px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: d.color ?? deptColor(d.name) }} />
                            <span style={{ fontSize: 13, fontWeight: 500, color: '#111' }}>{d.name}</span>
                          </div>
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 600, color: '#111' }}>{d.revenue > 0 ? fmtKr(d.revenue) : '—'}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 600, color: profit > 0 ? '#15803d' : '#d1d5db' }}>{profit > 0 ? fmtKr(profit) : '—'}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 600, color: d.gp_pct != null ? (d.gp_pct >= 50 ? '#16a34a' : d.gp_pct >= 30 ? '#d97706' : '#dc2626') : '#d1d5db' }}>{fmtPct(d.gp_pct)}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, color: '#374151' }}>{d.staff_cost > 0 ? fmtKr(d.staff_cost) : '—'}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                          {d.labour_pct != null ? <span style={{ fontSize: 12, fontWeight: 700, padding: '2px 7px', borderRadius: 20, background: d.labour_pct > 40 ? '#fee2e2' : '#dcfce7', color: d.labour_pct > 40 ? '#dc2626' : '#16a34a' }}>{fmtPct(d.labour_pct)}</span> : '—'}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, color: '#6b7280' }}>{d.rev_per_hour > 0 ? fmtKr(d.rev_per_hour) : '—'}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, color: '#9ca3af' }}>{d.hours > 0 ? fmtH(d.hours) : '—'}</td>
                      </tr>
                    )
                  })}
                  {summary && (
                    <tr style={{ background: '#f9fafb', borderTop: '2px solid #e5e7eb' }}>
                      <td style={{ padding: '10px 14px', fontSize: 12, fontWeight: 700, color: '#374151' }}>Total</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: '#111' }}>{fmtKr(summary.total_revenue ?? 0)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: '#15803d' }}>{fmtKr(Math.max(0, (summary.total_revenue ?? 0) - (summary.total_staff_cost ?? 0)))}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: summary.gp_pct != null ? '#16a34a' : '#d1d5db' }}>{fmtPct(summary.gp_pct)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: '#374151' }}>{fmtKr(summary.total_staff_cost ?? 0)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right' }}>{summary.labour_pct != null && <span style={{ fontSize: 12, fontWeight: 700, color: summary.labour_pct > 40 ? '#dc2626' : '#16a34a' }}>{fmtPct(summary.labour_pct)}</span>}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: '#111' }}>{summary.rev_per_hour > 0 ? fmtKr(summary.rev_per_hour) : '—'}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 700, color: '#111' }}>{fmtH(summary.total_hours ?? 0)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}
