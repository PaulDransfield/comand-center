'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import { deptColor, deptBg, DEPT_COLORS, KPI_CARD, CC_DARK, CC_PURPLE } from '@/lib/constants/colors'

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const fmtKr  = (n: number) => Math.round(n).toLocaleString('en-GB') + ' kr'
const fmtPct = (n: number) => Number(n).toFixed(1) + '%'

// Colour scheme
const C = {
  actual:   { bg: '#1a1f2e', text: 'white',   label: 'Actual' },
  forecast: { bg: '#6366f1', text: 'white',   label: 'Forecast' },
  good:     '#15803d',
  bad:      '#dc2626',
  neutral:  '#6b7280',
}

function Badge({ type }: { type: 'actual' | 'forecast' }) {
  return (
    <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, background: C[type].bg, color: C[type].text, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase' as const }}>
      {C[type].label}
    </span>
  )
}

function VarBadge({ actual, forecast, lowerIsBetter = false }: { actual: number; forecast: number; lowerIsBetter?: boolean }) {
  if (!actual || !forecast || forecast === 0) return null
  const diff = actual - forecast
  const pct  = Math.round((diff / forecast) * 100)
  const good = lowerIsBetter ? diff <= 0 : diff >= 0
  return (
    <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, marginLeft: 4,
      background: good ? '#f0fdf4' : '#fef2f2',
      color: good ? C.good : C.bad }}>
      {diff >= 0 ? '+' : ''}{pct}%
    </span>
  )
}

export default function ForecastPage() {
  const now  = new Date()
  const currentYear  = now.getFullYear()
  const currentMonth = now.getMonth() + 1

  const [businesses,   setBusinesses]   = useState<any[]>([])
  const [selected,     setSelected]     = useState('')
  const [data,         setData]         = useState<any>(null)
  const [deptData,     setDeptData]     = useState<any>(null)
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [expandedMonth, setExpandedMonth] = useState<any>(null)
  const [syncing,      setSyncing]      = useState(false)

  useEffect(() => {
    fetch('/api/businesses').then(r => r.json()).then((data: any[]) => {
      if (!Array.isArray(data) || !data.length) {
        setLoading(false)
        return
      }
      setBusinesses(data)
      const sync = () => {
        const saved = localStorage.getItem('cc_selected_biz')
        const id = (saved && data.find((b: any) => b.id === saved)) ? saved : data[0].id
        setSelected(id)
      }
      sync()
      window.addEventListener('storage', sync)
    }).catch(() => {})
  }, [])

  const load = useCallback(async () => {
    if (!selected) return (
    <AppShell>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <div style={{ textAlign: 'center' as const, maxWidth: 360 }}>
          <div style={{ fontSize: 32, marginBottom: 16 }}>📈</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#1a1f2e', marginBottom: 8 }}>No restaurant selected</div>
          <div style={{ fontSize: 13, color: '#6b7280' }}>Select a restaurant from the sidebar to see forecasts.</div>
        </div>
      </div>
    </AppShell>
  )
    setLoading(true)
    setError('')
    try {
      const [forecastRes, deptRes] = await Promise.all([
        fetch(`/api/forecast?business_id=${selected}`),
        fetch(`/api/departments?year=${currentYear}`),
      ])
      if (forecastRes.ok) setData(await forecastRes.json())
      if (deptRes.ok)     setDeptData(await deptRes.json())
    } catch (e: any) { setError(e.message) }
    setLoading(false)
  }, [selected])

  useEffect(() => { if (selected) load() }, [selected])

  const forecasts: any[]    = data?.forecasts    ?? []
  const actuals: any[]      = data?.actuals      ?? []
  const pkForecasts: any[]  = data?.pk_forecasts ?? []

  // Build 15-month view (Jan-Dec current year + Jan-Mar next year)
  const months = Array.from({ length: 15 }, (_, i) => {
    const yr = i < 12 ? currentYear : currentYear + 1
    const m  = i < 12 ? i + 1 : i - 11
    const f  = forecasts.find(r => r.period_year === yr && r.period_month === m)
    const a  = actuals.find(r => r.period_year === yr && r.period_month === m)
    const pkRev = pkForecasts.filter(r => {
      const d = new Date(r.date)
      return d.getFullYear() === yr && d.getMonth() + 1 === m
    }).reduce((s, r) => s + r.amount, 0)
    const isPast    = yr < currentYear || (yr === currentYear && m < currentMonth)
    const isCurrent = yr === currentYear && m === currentMonth
    const isFuture  = yr > currentYear || (yr === currentYear && m > currentMonth)
    return { yr, m, f, a, pkRev: Math.round(pkRev), isPast, isCurrent, isFuture }
  })

  // Next month forecast for highlight card
  const nextMonthForecast = months.find(r => r.isFuture && r.f)

  // YTD totals
  const ytdActualRev    = actuals.filter(r => r.period_year === currentYear).reduce((s,r) => s + Number(r.revenue    ?? 0), 0)
  const ytdForecastRev  = forecasts.filter(r => r.period_year === currentYear && r.period_month <= currentMonth).reduce((s,r) => s + Number(r.revenue_forecast ?? 0), 0)
  const ytdActualStaff  = actuals.filter(r => r.period_year === currentYear).reduce((s,r) => s + Number(r.staff_cost ?? 0), 0)
  const ytdActualProfit = actuals.filter(r => r.period_year === currentYear).reduce((s,r) => s + Number(r.net_profit ?? 0), 0)

  // Dept monthly data for drill-down
  const deptMonthly = deptData?.monthly ?? []
  // /api/departments now returns departments as objects {name, color, ...}; older
  // shape was string[]. Normalise to string[] so the drill-down row lookups
  // (deptRow[deptName]) work regardless of which version responded.
  const depts: string[] = (deptData?.departments ?? []).map((d: any) =>
    typeof d === 'string' ? d : d?.name
  ).filter(Boolean)
  // deptColor() imported from @/lib/constants/colors

  async function triggerSync() {
    setSyncing(true)
    await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'personalkollen' }) })
    await load()
    setSyncing(false)
  }

  return (
    <AppShell>
      <div style={{ padding: '28px', maxWidth: 1100, width: '100%' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: '#111' }}>Forecast</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
              Full year view · click any month to see department breakdown
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', background: '#f9fafb', borderRadius: 8, fontSize: 12 }}>
              <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: C.actual.bg }} /> Actual
              <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: C.forecast.bg }} /> Forecast
            </div>
            <select value={selected} onChange={e => setSelected(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: 'white' }}>
              {businesses.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <button onClick={triggerSync} disabled={syncing}
              style={{ padding: '8px 14px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 12, cursor: 'pointer' }}>
              {syncing ? 'Syncing...' : 'Sync now'}
            </button>
          </div>
        </div>

        {error && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '14px 18px', marginBottom: 20, fontSize: 13, color: '#dc2626' }}>{error}</div>}

        {loading ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>Loading forecasts...</div>
        ) : months.every((m: any) => !m.f && !m.a) ? (
          <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '48px 32px', textAlign: 'center' as const }}>
            <div style={{ fontSize: 32, marginBottom: 16 }}>📈</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#1a1f2e', marginBottom: 8 }}>No forecast data yet</div>
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 20, maxWidth: 320, margin: '0 auto 20px' }}>
              Connect your staff system and revenue source to start seeing forecasts and predictions.
            </div>
            <a href="/integrations" style={{ display: 'inline-block', padding: '9px 20px', background: '#1a1f2e', color: 'white', borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
              Connect integrations →
            </a>
          </div>
        ) : (
          <>
            {/* Summary cards */}
            <div className="grid-4" style={{ marginBottom: 20 }}>
              {[
                {
                  label: 'YTD Revenue (actual)',
                  value: fmtKr(ytdActualRev),
                  badge: 'actual' as const,
                  sub: `vs ${fmtKr(ytdForecastRev)} forecast`,
                  highlight: ytdActualRev >= ytdForecastRev ? 'good' : ytdForecastRev > 0 ? 'bad' : null,
                },
                {
                  label: 'YTD Net profit',
                  value: fmtKr(ytdActualProfit),
                  badge: 'actual' as const,
                  sub: ytdActualRev > 0 ? fmtPct(ytdActualProfit / ytdActualRev * 100) + ' margin' : '—',
                  highlight: ytdActualProfit > 0 ? 'good' : ytdActualProfit < 0 ? 'bad' : null,
                },
                {
                  label: 'YTD Staff cost',
                  value: fmtKr(ytdActualStaff),
                  badge: 'actual' as const,
                  sub: ytdActualRev > 0 ? fmtPct(ytdActualStaff / ytdActualRev * 100) + ' of revenue' : '—',
                  highlight: ytdActualRev > 0 && (ytdActualStaff / ytdActualRev) < 0.35 ? 'good' : ytdActualRev > 0 && (ytdActualStaff / ytdActualRev) > 0.35 ? 'bad' : null,
                },
                nextMonthForecast?.f ? {
                  label: `${MONTHS_SHORT[nextMonthForecast.m - 1]} forecast`,
                  value: fmtKr(nextMonthForecast.f.revenue_forecast),
                  badge: 'forecast' as const,
                  sub: `Staff ${fmtKr(nextMonthForecast.f.staff_cost_forecast)} · ${fmtPct(nextMonthForecast.f.margin_forecast)} margin`,
                  highlight: Number(nextMonthForecast.f.margin_forecast) > 0 ? 'good' : Number(nextMonthForecast.f.margin_forecast) < 0 ? 'bad' : null,
                } : { label: 'Next month', value: '—', badge: 'forecast' as const, sub: 'Run sync to generate', highlight: null },
              ].map((card: any) => (
                <div key={card.label} style={{
                  background: card.highlight === 'good' ? '#f0fdf4' : card.highlight === 'bad' ? '#fef2f2' : 'white',
                  border: `0.5px solid ${card.highlight === 'good' ? '#bbf7d0' : card.highlight === 'bad' ? '#fecaca' : '#e5e7eb'}`,
                  borderRadius: 12, padding: '16px 18px'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af' }}>{card.label}</div>
                    <Badge type={card.badge} />
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 3,
                    color: card.highlight === 'good' ? '#15803d' : card.highlight === 'bad' ? '#dc2626' : '#111'
                  }}>{card.value}</div>
                  <div style={{ fontSize: 11, color: card.highlight === 'good' ? '#15803d' : card.highlight === 'bad' ? '#dc2626' : '#9ca3af' }}>{card.sub}</div>
                </div>
              ))}
            </div>

            {/* Main forecast table */}
            <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', marginBottom: 20 }}>
              <div style={{ padding: '14px 20px', borderBottom: '0.5px solid #f3f4f6', display: 'flex', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>Month by month — {currentYear}</div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>Click a row to see department breakdown</div>
              </div>

              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#fafafa' }}>
                    <th style={{ width: 32 }} />
                    <th style={{ textAlign: 'left', padding: '9px 16px', color: '#9ca3af', fontWeight: 600, fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '.05em' }}>Month</th>
                    <th style={{ textAlign: 'right', padding: '9px 12px', color: C.actual.bg, fontWeight: 700, fontSize: 11, textTransform: 'uppercase' as const }}>Revenue actual</th>
                    <th style={{ textAlign: 'right', padding: '9px 12px', color: C.forecast.bg, fontWeight: 700, fontSize: 11, textTransform: 'uppercase' as const }}>Revenue forecast</th>
                    <th style={{ textAlign: 'right', padding: '9px 12px', color: C.actual.bg, fontWeight: 700, fontSize: 11, textTransform: 'uppercase' as const }}>Staff actual</th>
                    <th style={{ textAlign: 'right', padding: '9px 12px', color: C.forecast.bg, fontWeight: 700, fontSize: 11, textTransform: 'uppercase' as const }}>Staff forecast</th>
                    <th style={{ textAlign: 'right', padding: '9px 12px', color: C.actual.bg, fontWeight: 700, fontSize: 11, textTransform: 'uppercase' as const }}>Margin actual</th>
                    <th style={{ textAlign: 'right', padding: '9px 16px', color: C.forecast.bg, fontWeight: 700, fontSize: 11, textTransform: 'uppercase' as const }}>Margin forecast</th>
                  </tr>
                </thead>
                <tbody>
                  {months.map(row => {
                    const { yr, m, f, a, isCurrent, isFuture, isPast } = row
                    const isExpanded = expandedMonth === `${yr}-${m}`
                    const hasData    = a || f
                    const deptRow    = deptMonthly.find((d: any) => d.year === yr && d.month === m)

                    return (
                      <>
                        <tr key={`${yr}-${m}`}
                          onClick={() => hasData && setExpandedMonth(isExpanded ? null : `${yr}-${m}`)}
                          style={{
                            borderTop: '0.5px solid #f3f4f6',
                            cursor: hasData ? 'pointer' : 'default',
                            background: isExpanded ? '#fafbff' : isCurrent ? '#fffbf0' : 'white',
                            opacity: isFuture && !f ? 0.5 : 1,
                          }}>
                          {/* Expand arrow */}
                          <td style={{ padding: '11px 8px 11px 16px', color: '#9ca3af', fontSize: 11, textAlign: 'center' }}>
                            {hasData ? (isExpanded ? 'v' : '>') : ''}
                          </td>

                          {/* Month */}
                          <td style={{ padding: '11px 16px', fontWeight: 600, color: '#111' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              {MONTHS_SHORT[m - 1]}
                              {yr !== currentYear && <span style={{ fontSize: 10, color: '#9ca3af' }}>{yr}</span>}
                              {isCurrent && <span style={{ fontSize: 9, background: '#fef3c7', color: '#d97706', padding: '1px 5px', borderRadius: 3, fontWeight: 700 }}>NOW</span>}
                              {isFuture && f && <span style={{ fontSize: 9, background: '#f9fafb', color: '#3b82f6', padding: '1px 5px', borderRadius: 3 }}>forecast</span>}
                            </div>
                          </td>

                          {/* Revenue actual */}
                          <td style={{ padding: '11px 12px', textAlign: 'right' }}>
                            {a && Number(a.revenue) > 0 ? (
                              <span style={{ fontWeight: 700, color: C.actual.bg, background: '#f9fafb', padding: '3px 8px', borderRadius: 4 }}>
                                {fmtKr(a.revenue)}
                                {f && Number(f.revenue_forecast) > 0 && <VarBadge actual={a.revenue} forecast={f.revenue_forecast} />}
                              </span>
                            ) : <span style={{ color: '#d1d5db' }}>—</span>}
                          </td>

                          {/* Revenue forecast */}
                          <td style={{ padding: '11px 12px', textAlign: 'right' }}>
                            {f && Number(f.revenue_forecast) > 0 ? (
                              <span style={{ color: C.forecast.bg, fontWeight: 600 }}>
                                {fmtKr(f.revenue_forecast)}
                              </span>
                            ) : <span style={{ color: '#d1d5db' }}>—</span>}
                          </td>

                          {/* Staff actual */}
                          <td style={{ padding: '11px 12px', textAlign: 'right' }}>
                            {a && Number(a.staff_cost) > 0 ? (
                              <span style={{ fontWeight: 700, color: C.actual.bg, background: '#f9fafb', padding: '3px 8px', borderRadius: 4 }}>
                                {fmtKr(a.staff_cost)}
                                {f && Number(f.staff_cost_forecast) > 0 && <VarBadge actual={a.staff_cost} forecast={f.staff_cost_forecast} lowerIsBetter />}
                              </span>
                            ) : <span style={{ color: '#d1d5db' }}>—</span>}
                          </td>

                          {/* Staff forecast */}
                          <td style={{ padding: '11px 12px', textAlign: 'right' }}>
                            {f && Number(f.staff_cost_forecast) > 0 ? (
                              <span style={{ color: C.forecast.bg, fontWeight: 600 }}>
                                {fmtKr(f.staff_cost_forecast)}
                              </span>
                            ) : <span style={{ color: '#d1d5db' }}>—</span>}
                          </td>

                          {/* Margin actual */}
                          <td style={{ padding: '11px 12px', textAlign: 'right' }}>
                            {a && Number(a.margin_pct) !== 0 ? (
                              <span style={{
                                fontWeight: 700, padding: '3px 8px', borderRadius: 4,
                                background: Number(a.margin_pct) >= (f?.margin_forecast ?? 10) ? '#f0fdf4' : '#fef2f2',
                                color: Number(a.margin_pct) >= (f?.margin_forecast ?? 10) ? C.good : C.bad,
                              }}>
                                {fmtPct(a.margin_pct)}
                              </span>
                            ) : <span style={{ color: '#d1d5db' }}>—</span>}
                          </td>

                          {/* Margin forecast */}
                          <td style={{ padding: '11px 16px', textAlign: 'right' }}>
                            {f && Number(f.margin_forecast) !== 0 ? (
                              <span style={{ color: C.forecast.bg, fontWeight: 600 }}>
                                {fmtPct(f.margin_forecast)}
                              </span>
                            ) : <span style={{ color: '#d1d5db' }}>—</span>}
                          </td>
                        </tr>

                        {/* Department drill-down */}
                        {isExpanded && (
                          <tr key={`dept-${yr}-${m}`}>
                            <td colSpan={8} style={{ padding: 0, background: 'white', borderBottom: '1px solid #e5e7eb' }}>
                              <div style={{ padding: '14px 20px 14px 56px' }}>
                                <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 10 }}>
                                  Department breakdown — {MONTHS[m - 1]} {yr}
                                </div>
                                {deptRow && depts.length > 0 ? (
                                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                    <thead>
                                      <tr style={{ borderBottom: '0.5px solid #e5e7eb' }}>
                                        {['Department', 'Staff', 'Hours', 'Cost (actual)', 'Cost/h'].map(h => (
                                          <th key={h} style={{ textAlign: h === 'Department' ? 'left' : 'right', padding: '5px 10px', color: '#9ca3af', fontWeight: 600, fontSize: 10, textTransform: 'uppercase' as const }}>{h}</th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {depts.filter((d: string) => deptRow[d]?.cost > 0).map((dept: string) => {
                                        const d = deptRow[dept] ?? { cost: 0, hours: 0 }
                                        const total = depts.reduce((s: number, dep: string) => s + (deptRow[dep]?.cost ?? 0), 0)
                                        const pct   = total > 0 ? (d.cost / total) * 100 : 0
                                        const staffCount = deptData?.totals?.[dept]?.staff ?? 0
                                        return (
                                          <tr key={dept} style={{ borderBottom: '0.5px solid #f3f4f6' }}>
                                            <td style={{ padding: '7px 10px' }}>
                                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <div style={{ width: 8, height: 8, borderRadius: '50%', background: DEPT_COLORS[dept] ?? '#9ca3af', flexShrink: 0 }} />
                                                <span style={{ fontWeight: 500, color: '#111' }}>{dept}</span>
                                                <span style={{ fontSize: 10, color: '#9ca3af' }}>{pct.toFixed(0)}% of total</span>
                                              </div>
                                            </td>
                                            <td style={{ padding: '7px 10px', textAlign: 'right', color: '#6b7280' }}>{staffCount}</td>
                                            <td style={{ padding: '7px 10px', textAlign: 'right', color: '#6b7280' }}>{(Math.round(d.hours * 10) / 10)}h</td>
                                            <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700, color: '#111' }}>{fmtKr(d.cost)}</td>
                                            <td style={{ padding: '7px 10px', textAlign: 'right', color: '#6b7280' }}>{d.hours > 0 ? fmtKr(Math.round(d.cost / d.hours)) : '—'}</td>
                                          </tr>
                                        )
                                      })}
                                      {/* Total row */}
                                      <tr style={{ borderTop: '1px solid #e5e7eb', background: '#f3f4f6' }}>
                                        <td style={{ padding: '7px 10px', fontWeight: 700, color: '#111' }}>Total</td>
                                        <td />
                                        <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700, color: '#111' }}>
                                          {Math.round(depts.reduce((s: number, d: string) => s + (deptRow[d]?.hours ?? 0), 0) * 10) / 10}h
                                        </td>
                                        <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700, color: '#111' }}>
                                          {fmtKr(depts.reduce((s: number, d: string) => s + (deptRow[d]?.cost ?? 0), 0))}
                                        </td>
                                        <td />
                                      </tr>
                                    </tbody>
                                  </table>
                                ) : (
                                  <div style={{ fontSize: 12, color: '#9ca3af', padding: '10px 0' }}>
                                    No department data for this month. Staff logs are synced from Personalkollen daily.
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })}
                </tbody>
              </table>

              {/* Legend footer */}
              <div style={{ padding: '12px 20px', borderTop: '0.5px solid #f3f4f6', display: 'flex', gap: 20, fontSize: 11, color: '#9ca3af' }}>
                <span style={{ background: '#fef3c7', padding: '1px 6px', borderRadius: 3, color: '#d97706' }}>NOW</span> Current month
                <span style={{ background: '#f9fafb', padding: '1px 6px', borderRadius: 3, color: C.actual.bg, fontWeight: 700 }}>123 kr</span> Actual values
                <span style={{ color: C.forecast.bg, fontWeight: 600 }}>123 kr</span> Forecast values
                <span style={{ background: '#f0fdf4', color: C.good, padding: '1px 6px', borderRadius: 3 }}>+5%</span> Beat forecast
                <span style={{ background: '#fef2f2', color: C.bad, padding: '1px 6px', borderRadius: 3 }}>-5%</span> Missed forecast
              </div>
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}
