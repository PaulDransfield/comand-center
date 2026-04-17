'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'

const fmtKr  = (n: number) => Math.round(n).toLocaleString('en-GB') + ' kr'
const fmtH   = (n: number) => (Math.round(n * 10) / 10) + 'h'

const STATUS_META = {
  understaffed: { label: 'Understaffed',  bg: '#fef2f2', border: '#fecaca', dot: '#dc2626', text: '#dc2626', hint: 'High revenue per hour — demand exceeds staffing' },
  overstaffed:  { label: 'Overstaffed',   bg: '#fffbeb', border: '#fde68a', dot: '#d97706', text: '#d97706', hint: 'Low revenue per hour — more staff than demand needs' },
  efficient:    { label: 'Efficient',      bg: '#f0fdf4', border: '#bbf7d0', dot: '#15803d', text: '#15803d', hint: 'Revenue per hour within 20% of your weekly average' },
  no_data:      { label: 'No data',        bg: '#f9fafb', border: '#e5e7eb', dot: '#9ca3af', text: '#9ca3af', hint: 'Fewer than 2 days of joined data for this weekday' },
}

export default function SchedulingPage() {
  const now = new Date()
  const ninetyDaysAgo = new Date(); ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

  const [data,        setData]       = useState<any>(null)
  const [loading,     setLoading]    = useState(true)
  const [error,       setError]      = useState('')
  const [selectedBiz, setSelectedBiz] = useState('')
  const [fromDate,    setFromDate]   = useState(ninetyDaysAgo.toISOString().slice(0, 10))
  const [toDate,      setToDate]     = useState(now.toISOString().slice(0, 10))

  // Sync business selection with sidebar switcher
  useEffect(() => {
    const sync = () => {
      const saved = localStorage.getItem('cc_selected_biz')
      if (saved) setSelectedBiz(saved)
    }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  const load = useCallback(async () => {
    if (!selectedBiz) return
    setLoading(true)
    setError('')
    try {
      const res  = await fetch(`/api/scheduling?business_id=${selectedBiz}&from=${fromDate}&to=${toDate}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load')
      setData(json)
    } catch (e: any) { setError(e.message) }
    setLoading(false)
  }, [selectedBiz, fromDate, toDate])

  useEffect(() => { if (selectedBiz) load() }, [selectedBiz])

  const weekdays         = data?.weekday_efficiency ?? []
  const daily            = data?.daily_revpah       ?? []
  const summary          = data?.summary            ?? null
  const recommendation   = data?.latest_recommendation ?? null

  // Bar chart — scale all bars to max avg_rev_per_hour
  const maxRevPH = weekdays.reduce((m: number, w: any) => Math.max(m, w.avg_rev_per_hour ?? 0), 0)
  const maxHours = weekdays.reduce((m: number, w: any) => Math.max(m, w.avg_hours ?? 0), 0)

  // Daily trend — last 30 days for chart
  const trendRows = daily.slice(-30)
  const maxTrend  = trendRows.reduce((m: number, d: any) => Math.max(m, d.rev_per_hour ?? 0), 1)

  const hasData = summary?.days_analyzed > 0

  return (
    <AppShell>
      <div className="page-wrap" style={{ maxWidth: 1100 }}>

        {/* Header */}
        <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: '#111' }}>Scheduling Efficiency</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Revenue per labor hour by day of week · identify over and understaffed patterns</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
            <button onClick={load}
              style={{ padding: '8px 16px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>
              Load
            </button>
          </div>
        </div>

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '14px 18px', marginBottom: 20, fontSize: 13, color: '#dc2626' }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ padding: 60, textAlign: 'center' as const, color: '#9ca3af' }}>Loading scheduling data...</div>
        ) : !hasData ? (
          <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: 48, textAlign: 'center' as const }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#111', marginBottom: 8 }}>No joined data yet</div>
            <div style={{ fontSize: 13, color: '#9ca3af', maxWidth: 380, margin: '0 auto' }}>
              Scheduling efficiency requires both staff hours (Personalkollen) and revenue (POS) data for the same dates. Try expanding the date range.
            </div>
          </div>
        ) : (
          <>
            {/* KPI summary cards */}
            <div className="grid-4" style={{ marginBottom: 16 }}>
              {[
                {
                  label: 'Avg rev / labor hour',
                  value: summary.avg_rev_per_hour ? fmtKr(summary.avg_rev_per_hour) : '—',
                  sub: `${summary.days_analyzed} days analysed`,
                  color: '#111',
                },
                {
                  label: 'Best weekday',
                  value: summary.best_weekday?.label ?? '—',
                  sub: summary.best_weekday ? fmtKr(summary.best_weekday.avg_rev_per_hour) + '/hr' : 'No data',
                  color: '#15803d',
                },
                {
                  label: 'Worst weekday',
                  value: summary.worst_weekday?.label ?? '—',
                  sub: summary.worst_weekday ? fmtKr(summary.worst_weekday.avg_rev_per_hour) + '/hr' : 'No data',
                  color: '#d97706',
                },
                {
                  label: 'Total labour hours',
                  value: fmtH(summary.total_hours),
                  sub: `${fmtKr(summary.total_revenue)} revenue`,
                  color: '#111',
                },
              ].map(kpi => (
                <div key={kpi.label} style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '14px 16px' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 6 }}>{kpi.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: kpi.color, marginBottom: 3 }}>{kpi.value}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{kpi.sub}</div>
                </div>
              ))}
            </div>

            {/* Understaffed / overstaffed callout */}
            {(summary.understaffed_days.length > 0 || summary.overstaffed_days.length > 0) && (
              <div className="grid-2" style={{ marginBottom: 16 }}>
                {summary.understaffed_days.length > 0 && (
                  <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '14px 18px', display: 'flex', gap: 12 }}>
                    <div style={{ flexShrink: 0, width: 36, height: 36, background: '#dc2626', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 16 }}>↑</div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#dc2626', marginBottom: 3 }}>Likely understaffed: {summary.understaffed_days.join(', ')}</div>
                      <div style={{ fontSize: 12, color: '#7f1d1d' }}>Revenue per labour hour is 20%+ above your weekly average on these days. Demand is outpacing staffing — consider adding hours.</div>
                    </div>
                  </div>
                )}
                {summary.overstaffed_days.length > 0 && (
                  <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 12, padding: '14px 18px', display: 'flex', gap: 12 }}>
                    <div style={{ flexShrink: 0, width: 36, height: 36, background: '#d97706', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 16 }}>↓</div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#d97706', marginBottom: 3 }}>Likely overstaffed: {summary.overstaffed_days.join(', ')}</div>
                      <div style={{ fontSize: 12, color: '#78350f' }}>Revenue per labour hour is 20%+ below average on these days. You have more hours than demand requires — consider trimming shifts.</div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Weekly efficiency grid — 7 day cards */}
            <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 20px', marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 4 }}>Revenue per labour hour — by day of week</div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 16 }}>
                Based on {summary.days_analyzed} days with both Personalkollen and revenue data · target zone ±20% of {summary.avg_rev_per_hour ? fmtKr(summary.avg_rev_per_hour) : '—'}/hr avg
              </div>

              {/* 7-day bar chart */}
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
                {/* Avg line marker */}
                {summary.avg_rev_per_hour && maxRevPH > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2 }}>
                    <div style={{ width: 28, fontSize: 10, color: '#9ca3af' }}></div>
                    <div style={{ flex: 1, position: 'relative', height: 10 }}>
                      <div style={{ position: 'absolute', left: `${(summary.avg_rev_per_hour / maxRevPH) * 100}%`, top: 0, bottom: 0, width: 1, borderLeft: '1px dashed #6366f1' }} />
                      <div style={{ position: 'absolute', left: `${(summary.avg_rev_per_hour / maxRevPH) * 100 + 0.5}%`, top: 0, fontSize: 9, color: '#6366f1', whiteSpace: 'nowrap' as const }}>avg {fmtKr(summary.avg_rev_per_hour)}/hr</div>
                    </div>
                  </div>
                )}

                {weekdays.map((w: any) => {
                  const meta     = STATUS_META[w.status as keyof typeof STATUS_META] ?? STATUS_META.no_data
                  const barPct   = maxRevPH > 0 && w.avg_rev_per_hour ? (w.avg_rev_per_hour / maxRevPH) * 100 : 0
                  const hoursPct = maxHours > 0 && w.avg_hours ? (w.avg_hours / maxHours) * 100 : 0
                  const hasWdData = w.days_with_data >= 2

                  return (
                    <div key={w.weekday} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {/* Day label */}
                      <div style={{ width: 28, fontSize: 12, fontWeight: 600, color: hasWdData ? '#374151' : '#d1d5db', flexShrink: 0 }}>{w.label}</div>

                      {/* Stacked bars: rev/hour (main) + avg hours (secondary) */}
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' as const, gap: 3 }}>
                        {/* Revenue per hour bar */}
                        <div style={{ height: 14, background: '#f3f4f6', borderRadius: 6, overflow: 'hidden', position: 'relative' }}>
                          <div style={{ position: 'absolute', left: `${(summary.avg_rev_per_hour / maxRevPH) * 100}%`, top: 0, bottom: 0, width: 1, background: '#6366f1', opacity: 0.4, zIndex: 1 }} />
                          <div style={{ height: '100%', width: `${barPct}%`, background: meta.dot, borderRadius: 6, opacity: 0.8, transition: 'width 0.4s' }} />
                        </div>
                        {/* Hours bar (context) */}
                        <div style={{ height: 6, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${hoursPct}%`, background: '#1a1f2e', borderRadius: 4, opacity: 0.25, transition: 'width 0.4s' }} />
                        </div>
                      </div>

                      {/* Rev/hour value */}
                      <div style={{ width: 80, textAlign: 'right' as const, fontSize: 12, fontWeight: 700, color: hasWdData ? meta.text : '#d1d5db', flexShrink: 0 }}>
                        {hasWdData && w.avg_rev_per_hour ? fmtKr(w.avg_rev_per_hour) + '/hr' : '—'}
                      </div>

                      {/* Avg hours */}
                      <div style={{ width: 34, textAlign: 'right' as const, fontSize: 10, color: '#9ca3af', flexShrink: 0 }}>
                        {hasWdData ? fmtH(w.avg_hours ?? 0) : ''}
                      </div>

                      {/* Status badge */}
                      <div style={{ width: 86, flexShrink: 0 }}>
                        {hasWdData ? (
                          <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: meta.bg, color: meta.text, fontWeight: 600, border: `1px solid ${meta.border}` }}>
                            {meta.label}
                          </span>
                        ) : (
                          <span style={{ fontSize: 10, color: '#d1d5db' }}>{w.days_with_data < 2 ? `${w.days_with_data} day${w.days_with_data !== 1 ? 's' : ''}` : ''}</span>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Legend */}
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '0.5px solid #f3f4f6', display: 'flex', gap: 16, flexWrap: 'wrap' as const, fontSize: 11, color: '#9ca3af' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 12, height: 4, background: '#dc2626', borderRadius: 2, opacity: 0.8, display: 'inline-block' }} /> Rev / hr (red = understaffed)
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 12, height: 4, background: '#1a1f2e', borderRadius: 2, opacity: 0.25, display: 'inline-block' }} /> Avg hours scheduled
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ display: 'inline-block', width: 18, borderTop: '1px dashed #6366f1', marginBottom: 1 }} /> Weekly avg rev/hr
                </span>
              </div>
            </div>

            {/* Daily RevPAH trend + weekday detail side by side */}
            <div className="grid-2" style={{ marginBottom: 16 }}>

              {/* Daily trend */}
              <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 20px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 4 }}>Revenue per labour hour — daily trend</div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 14 }}>Last {trendRows.length} days with joined data</div>

                {trendRows.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center' as const, padding: '20px 0' }}>No daily data</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
                    {trendRows.map((d: any) => {
                      const pct      = maxTrend > 0 ? (d.rev_per_hour / maxTrend) * 100 : 0
                      const avgRatio = summary.avg_rev_per_hour ? d.rev_per_hour / summary.avg_rev_per_hour : 1
                      const color    = avgRatio > 1.2 ? '#dc2626' : avgRatio < 0.8 ? '#d97706' : '#15803d'
                      const fmtDate  = new Date(d.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
                      return (
                        <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 80, fontSize: 11, color: '#6b7280', flexShrink: 0 }}>{fmtDate}</div>
                          <div style={{ flex: 1, height: 10, background: '#f3f4f6', borderRadius: 5, overflow: 'hidden', position: 'relative' }}>
                            {summary.avg_rev_per_hour && maxTrend > 0 && (
                              <div style={{ position: 'absolute', left: `${(summary.avg_rev_per_hour / maxTrend) * 100}%`, top: 0, bottom: 0, width: 1, background: '#6366f1', opacity: 0.4, zIndex: 1 }} />
                            )}
                            <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 5, opacity: 0.8, transition: 'width 0.3s' }} />
                          </div>
                          <div style={{ width: 70, textAlign: 'right' as const, fontSize: 11, fontWeight: 600, color, flexShrink: 0 }}>{fmtKr(d.rev_per_hour)}/hr</div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Weekday detail table */}
              <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 20px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 4 }}>Weekday breakdown</div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 14 }}>Average per day of week across the period</div>
                <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '0.5px solid #e5e7eb' }}>
                      {['Day', 'Avg rev', 'Avg hrs', 'Rev/hr', 'Days'].map(h => (
                        <th key={h} style={{ textAlign: h === 'Day' ? 'left' : 'right', padding: '4px 8px', fontSize: 10, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: '.06em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {weekdays.filter((w: any) => w.days_with_data > 0).map((w: any) => {
                      const meta = STATUS_META[w.status as keyof typeof STATUS_META] ?? STATUS_META.no_data
                      return (
                        <tr key={w.weekday} style={{ borderBottom: '0.5px solid #f3f4f6' }}>
                          <td style={{ padding: '7px 8px', fontWeight: 600, color: '#374151' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                              <span style={{ width: 6, height: 6, borderRadius: '50%', background: meta.dot, flexShrink: 0, display: 'inline-block' }} />
                              {w.label}
                            </span>
                          </td>
                          <td style={{ padding: '7px 8px', textAlign: 'right' as const, color: '#111' }}>{w.avg_revenue ? fmtKr(w.avg_revenue) : '—'}</td>
                          <td style={{ padding: '7px 8px', textAlign: 'right' as const, color: '#6b7280' }}>{w.avg_hours ? fmtH(w.avg_hours) : '—'}</td>
                          <td style={{ padding: '7px 8px', textAlign: 'right' as const, fontWeight: 700, color: meta.text }}>{w.avg_rev_per_hour ? fmtKr(w.avg_rev_per_hour) : '—'}</td>
                          <td style={{ padding: '7px 8px', textAlign: 'right' as const, color: '#9ca3af' }}>{w.days_with_data}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* AI scheduling recommendations */}
            {recommendation ? (
              <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '20px 24px', marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>AI scheduling recommendations</span>
                      <span style={{ fontSize: 10, background: '#ede9fe', color: '#6d28d9', padding: '2px 7px', borderRadius: 4, fontWeight: 600 }}>Group plan</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>
                      Generated {new Date(recommendation.generated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                      {recommendation.analysis_period && ` · based on ${recommendation.analysis_period}`}
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.7, whiteSpace: 'pre-wrap' as const, background: '#f9fafb', borderRadius: 8, padding: '14px 16px', borderLeft: '3px solid #6366f1' }}>
                  {recommendation.recommendations}
                </div>
                {recommendation.metadata && (
                  <div style={{ marginTop: 12, display: 'flex', gap: 20, fontSize: 11, color: '#9ca3af', flexWrap: 'wrap' as const }}>
                    {recommendation.metadata.staff_shifts && <span>Shifts analysed: <strong style={{ color: '#374151' }}>{recommendation.metadata.staff_shifts}</strong></span>}
                    {recommendation.metadata.total_hours && <span>Hours: <strong style={{ color: '#374151' }}>{Math.round(recommendation.metadata.total_hours)}h</strong></span>}
                    {recommendation.metadata.labor_cost && <span>Labour cost: <strong style={{ color: '#374151' }}>{fmtKr(recommendation.metadata.labor_cost)}</strong></span>}
                    {recommendation.metadata.late_shifts && <span>Late shifts: <strong style={{ color: '#374151' }}>{recommendation.metadata.late_shifts}</strong></span>}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ background: 'linear-gradient(135deg, #312e81, #1e1b4b)', border: '0.5px solid rgba(99,102,241,0.3)', borderRadius: 12, padding: '20px 24px', marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
                  <div style={{ flexShrink: 0, width: 40, height: 40, background: 'rgba(99,102,241,0.3)', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>✦</div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'white', marginBottom: 4 }}>AI scheduling recommendations</div>
                    <div style={{ fontSize: 12, color: 'rgba(199,210,254,0.7)', lineHeight: 1.6, marginBottom: 14 }}>
                      Available on the Group plan. Every Monday at 07:00, Claude Sonnet analyses your last 90 days of shifts and revenue and generates specific, actionable scheduling changes — which days need more staff, which roles have OB exposure, where lateness is costing you.
                    </div>
                    <a href="/upgrade" style={{ display: 'inline-block', padding: '8px 16px', background: '#6366f1', color: 'white', borderRadius: 8, fontSize: 12, fontWeight: 600, textDecoration: 'none' }}>
                      Upgrade to Group →
                    </a>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Contextual AI */}
      <AskAI
        page="scheduling"
        context={summary ? [
          `Period: ${fromDate} to ${toDate}`,
          `Days analysed: ${summary.days_analyzed}`,
          `Average revenue per labour hour: ${summary.avg_rev_per_hour ? fmtKr(summary.avg_rev_per_hour) : 'N/A'}`,
          `Total labour hours: ${fmtH(summary.total_hours)}`,
          `Total revenue: ${fmtKr(summary.total_revenue)}`,
          summary.best_weekday  ? `Most efficient day: ${summary.best_weekday.label} (${fmtKr(summary.best_weekday.avg_rev_per_hour)}/hr)` : '',
          summary.worst_weekday ? `Least efficient day: ${summary.worst_weekday.label} (${fmtKr(summary.worst_weekday.avg_rev_per_hour)}/hr)` : '',
          summary.understaffed_days.length > 0 ? `Likely understaffed days: ${summary.understaffed_days.join(', ')}` : '',
          summary.overstaffed_days.length  > 0 ? `Likely overstaffed days: ${summary.overstaffed_days.join(', ')}` : '',
          weekdays.filter((w: any) => w.days_with_data >= 2).length > 0
            ? `Weekday efficiency: ${weekdays.filter((w: any) => w.days_with_data >= 2).map((w: any) => `${w.label}: ${fmtKr(w.avg_rev_per_hour ?? 0)}/hr (${w.avg_hours}h avg, ${w.status})`).join('; ')}`
            : '',
        ].filter(Boolean).join('\n') : 'No scheduling data loaded yet'}
      />
    </AppShell>
  )
}
