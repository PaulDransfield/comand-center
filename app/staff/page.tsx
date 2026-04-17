'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'
import { deptColor, deptBg, DEPT_COLORS, KPI_CARD, CC_DARK, CC_PURPLE } from '@/lib/constants/colors'

const fmtKr = (n: number) => Math.round(n).toLocaleString('en-GB') + ' kr'
const fmtH  = (n: number) => (Math.round(n * 10) / 10) + 'h'

// deptColor() imported from @/lib/constants/colors
// deptColor imported from @/lib/constants/colors

export default function StaffPage() {
  const now = new Date()
  const defaultFrom = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`
  const defaultTo   = now.toISOString().slice(0,10)

  const [data,       setData]      = useState<any>(null)
  const [tipData,    setTipData]   = useState<any>(null)
  const [staffRev,   setStaffRev]  = useState<any>(null)
  const [loading,    setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [fromDate,  setFromDate]  = useState(defaultFrom)
  const [toDate,    setToDate]    = useState(defaultTo)
  const [search,    setSearch]    = useState('')
  const [expanded,  setExpanded]  = useState<number|null>(null)
  const [selectedBiz, setSelectedBiz] = useState<string>('')

  // Sync with sidebar business switcher
  useEffect(() => {
    const sync = () => {
      const saved = localStorage.getItem('cc_selected_biz')
      if (saved) setSelectedBiz(saved)
    }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  // Re-fetch when business changes
  useEffect(() => {
    if (selectedBiz) load()
  }, [selectedBiz])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const bizParam = selectedBiz ? `&business_id=${selectedBiz}` : ''
      const [staffRes, revRes, srRes] = await Promise.all([
        fetch(`/api/staff?from=${fromDate}&to=${toDate}${bizParam}`),
        selectedBiz ? fetch(`/api/revenue-detail?business_id=${selectedBiz}&from=${fromDate}&to=${toDate}`) : Promise.resolve(null),
        selectedBiz ? fetch(`/api/staff-revenue?business_id=${selectedBiz}&from=${fromDate}&to=${toDate}`) : Promise.resolve(null),
      ])
      const json = await staffRes.json()
      if (!staffRes.ok) throw new Error(json.error ?? 'Failed')
      setData(json)
      if (revRes?.ok) {
        const revJson = await revRes.json()
        setTipData(revJson)
      }
      if (srRes?.ok) {
        const srJson = await srRes.json()
        setStaffRev(srJson)
      }
    } catch (e: any) { setError(e.message) }
    setLoading(false)
  }, [fromDate, toDate, selectedBiz])

  useEffect(() => { load() }, [load])

  const summary        = data?.summary          ?? null
  const staff          = data?.staff            ?? []
  const connected      = data?.connected        ?? false
  const deptLateness   = data?.dept_lateness    ?? []
  const weekdayLateness = data?.weekday_lateness ?? []

  const filtered = staff.filter((s: any) =>
    !search ||
    (s.name ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (s.group ?? '').toLowerCase().includes(search.toLowerCase())
  )
  const sorted = [...filtered].sort((a: any, b: any) => b.cost_actual - a.cost_actual)

  const variance = summary ? Math.round((summary.logged_hours - summary.scheduled_hours) * 10) / 10 : 0

  // Estimated vs actual salary comparison
  const totalEstimated  = summary?.staff_cost_estimated ?? 0
  const totalActual     = summary?.staff_cost_actual    ?? 0
  const costVariance    = summary?.cost_variance        ?? 0
  const taxMultiplier   = summary?.tax_multiplier       ?? null
  const payrollPending  = summary?.payroll_pending      ?? false
  const effectiveCost   = summary?.staff_cost_effective ?? 0

  // Staff cost % vs revenue (live join)
  const srSummary    = staffRev?.summary ?? null
  const srRows       = staffRev?.rows    ?? []
  const liveStaffPct = srSummary?.avg_staff_pct ?? null
  const targetPct    = 40  // standard restaurant industry target
  // Max staff % across days — used to scale the bar chart
  const maxSrPct     = srRows.length > 0 ? Math.max(...srRows.map((r: any) => r.staff_pct ?? 0), targetPct + 5) : 60

  // OB supplement type breakdown
  const obTypeBreakdown  = summary?.ob_type_breakdown  ?? []   // [{ type, kr }] sorted highest first
  const totalObSupplement = summary?.total_ob_supplement ?? 0
  const hasObTypes       = obTypeBreakdown.length > 0

  // Tip data from revenue_logs (Inzii POS)
  const totalTips    = tipData?.summary?.total_tips ?? 0
  const staffCost    = summary?.staff_cost_actual ?? 0
  const tipPct       = staffCost > 0 && totalTips > 0 ? (totalTips / staffCost) * 100 : 0
  const netBurden    = staffCost - totalTips
  const daysWithTips = (tipData?.rows ?? []).filter((r: any) => r.tip_revenue > 0).length
  const avgDailyTip  = daysWithTips > 0 ? Math.round(totalTips / daysWithTips) : 0
  // Daily tip rows for trend chart — only days with revenue
  const tipRows = (tipData?.rows ?? []).filter((r: any) => r.tip_revenue > 0).slice(0, 20)
  const maxTip  = tipRows.length > 0 ? Math.max(...tipRows.map((r: any) => r.tip_revenue)) : 1

  return (
    <AppShell>
      <div className="page-wrap" style={{ maxWidth: 1100 }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: '#111' }}>Staff</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Hours, costs and punctuality from Personalkollen</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
            {error} {!connected && <a href="/integrations" style={{ color: '#6366f1', marginLeft: 6 }}>Connect Personalkollen</a>}
          </div>
        )}

        {loading ? (
          <div style={{ padding: 60, textAlign: 'center' as const, color: '#9ca3af' }}>Loading staff data...</div>
        ) : !connected ? (
          <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: 40, textAlign: 'center' as const }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}></div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#111', marginBottom: 8 }}>Personalkollen not connected</div>
            <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 20 }}>Connect Personalkollen to see staff hours, costs and punctuality.</div>
            <a href="/integrations" style={{ padding: '10px 20px', background: '#1a1f2e', color: 'white', borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
              Connect now
            </a>
          </div>
        ) : summary && (
          <>
            {/* KPI cards */}
            <div className="grid-4" style={{ marginBottom: 16 }}>
              {[
                { label: 'Hours logged',     value: fmtH(summary.logged_hours),     sub: `${summary.shifts_logged} shifts`,  color: '#111' },
                { label: 'Late arrivals',    value: String(summary.late_shifts ?? 0), sub: 'shifts starting late',            color: (summary.late_shifts ?? 0) > 0 ? '#dc2626' : '#15803d' },
                { label: 'OB shifts',        value: String(summary.shifts_with_ob ?? 0), sub: 'unsocial hours',               color: '#9ca3af' },
                { label: 'Tips earned',      value: totalTips > 0 ? fmtKr(totalTips) : '—', sub: totalTips > 0 ? `${tipPct.toFixed(1)}% of staff cost` : 'No tip data', color: tipPct >= 5 ? '#15803d' : '#9ca3af' },
                { label: 'Estimated salary', value: totalEstimated > 0 ? fmtKr(totalEstimated) : '—', sub: 'net pay before taxes', color: '#111' },
                { label: 'Actual cost',      value: totalActual > 0 ? fmtKr(totalActual) : payrollPending ? 'Pending' : '—', sub: totalActual > 0 ? 'incl. employer taxes' : 'payroll not yet approved', color: '#111' },
                { label: 'Cost variance',    value: costVariance !== 0 ? (costVariance > 0 ? '+' : '') + fmtKr(costVariance) : '—', sub: costVariance > 0 ? 'over estimate' : costVariance < 0 ? 'under estimate' : 'no variance data', color: costVariance > 0 ? '#dc2626' : costVariance < 0 ? '#15803d' : '#9ca3af' },
                { label: 'Tax multiplier',   value: taxMultiplier ? taxMultiplier.toFixed(2) + '×' : '—', sub: taxMultiplier ? `${Math.round((taxMultiplier - 1) * 100)}% employer overhead` : 'pending payroll approval', color: '#9ca3af' },
              ].map(kpi => (
                <div key={kpi.label} style={{ background: 'white', border: `0.5px solid ${kpi.color === '#dc2626' ? '#fecaca' : '#e5e7eb'}`, borderRadius: 12, padding: '14px 16px' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 6 }}>{kpi.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: kpi.color, marginBottom: 3 }}>{kpi.value}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{kpi.sub}</div>
                </div>
              ))}
            </div>

            {/* Cost and hours panels */}
            <div className="grid-2" style={{ marginBottom: 16 }}>

              {/* Cost panel */}
              <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>Estimated vs actual cost</div>
                  {payrollPending && (
                    <span style={{ fontSize: 10, background: '#fef3c7', color: '#d97706', padding: '2px 6px', borderRadius: 4, fontWeight: 600 }}>PAYROLL PENDING</span>
                  )}
                </div>
                {[
                  { label: 'Estimated salary',  value: totalEstimated > 0 ? fmtKr(totalEstimated) : '—',  color: '#6366f1',  hint: 'hours × hourly rate' },
                  { label: 'Actual cost',        value: totalActual    > 0 ? fmtKr(totalActual)    : '—',  color: '#1a1f2e',  hint: 'incl. employer taxes & vacation pay' },
                  { label: 'Variance',           value: costVariance !== 0 ? (costVariance > 0 ? '+' : '') + fmtKr(costVariance) : '—',
                    color: costVariance > 0 ? '#dc2626' : costVariance < 0 ? '#15803d' : '#9ca3af', hint: 'actual minus estimated' },
                  { label: 'Tax multiplier',     value: taxMultiplier ? taxMultiplier.toFixed(2) + '×' : '—', color: '#9ca3af', hint: taxMultiplier ? `${Math.round((taxMultiplier - 1) * 100)}% employer overhead` : 'available once payroll approved' },
                ].map(row => (
                  <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '8px 0', borderBottom: '0.5px solid #f3f4f6' }}>
                    <div>
                      <div style={{ fontSize: 13, color: '#6b7280' }}>{row.label}</div>
                      <div style={{ fontSize: 10, color: '#d1d5db', marginTop: 1 }}>{row.hint}</div>
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 600, color: row.color }}>{row.value}</span>
                  </div>
                ))}
              </div>

              {/* Hours panel */}
              <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 20px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 14 }}>Hours   scheduled vs actual</div>
                {[
                  { label: 'Scheduled', value: fmtH(summary.scheduled_hours), bar: summary.scheduled_hours, color: '#6366f1' },
                  { label: 'Actual',    value: fmtH(summary.logged_hours),    bar: summary.logged_hours,    color: '#1a1f2e' },
                ].map(row => {
                  const max = Math.max(summary.scheduled_hours, summary.logged_hours, 1)
                  return (
                    <div key={row.label} style={{ marginBottom: 14 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontSize: 12, color: '#6b7280' }}>{row.label}</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: '#111' }}>{row.value}</span>
                      </div>
                      <div style={{ height: 8, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${(row.bar / max) * 100}%`, background: row.color, borderRadius: 4, transition: 'width 0.4s' }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Tips panel — only shown when Inzii provides tip data */}
            {totalTips > 0 && (
              <div className="grid-2" style={{ marginBottom: 16 }}>

                {/* Tips vs cost summary */}
                <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 20px' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 14 }}>Tips vs staff cost</div>
                  {[
                    { label: 'Staff cost',     value: fmtKr(staffCost),   color: '#1a1f2e' },
                    { label: 'Tips earned',    value: fmtKr(totalTips),   color: '#10b981' },
                    { label: 'Net burden',     value: fmtKr(netBurden),   color: '#111' },
                  ].map(row => (
                    <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '0.5px solid #f3f4f6' }}>
                      <span style={{ fontSize: 13, color: '#6b7280' }}>{row.label}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: row.color }}>{row.value}</span>
                    </div>
                  ))}
                  {/* Stacked bar: tips vs remaining cost */}
                  <div style={{ marginTop: 14 }}>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6 }}>Tips offset {tipPct.toFixed(1)}% of staff cost</div>
                    <div style={{ display: 'flex', height: 10, borderRadius: 6, overflow: 'hidden', background: '#f3f4f6' }}>
                      <div style={{ width: `${Math.min(tipPct, 100)}%`, background: '#10b981', transition: 'width 0.4s' }} />
                    </div>
                  </div>
                  <div style={{ marginTop: 10, display: 'flex', gap: 16, fontSize: 11, color: '#9ca3af' }}>
                    <span>Avg daily tip: <strong style={{ color: '#111' }}>{fmtKr(avgDailyTip)}</strong></span>
                    <span>Days with tips: <strong style={{ color: '#111' }}>{daysWithTips}</strong></span>
                  </div>
                </div>

                {/* Daily tip trend */}
                <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 20px' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 14 }}>Tip trend — last {tipRows.length} days</div>
                  {tipRows.length === 0 ? (
                    <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', padding: '20px 0' }}>No daily tip data</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {[...tipRows].sort((a: any, b: any) => b.tip_revenue - a.tip_revenue).slice(0, 8).map((row: any) => {
                        const barPct = maxTip > 0 ? (row.tip_revenue / maxTip) * 100 : 0
                        const tipRevPct = row.revenue > 0 ? ((row.tip_revenue / row.revenue) * 100).toFixed(1) : '0'
                        const date = new Date(row.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
                        return (
                          <div key={row.date} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ width: 80, fontSize: 11, color: '#6b7280', flexShrink: 0 }}>{date}</div>
                            <div style={{ flex: 1, height: 8, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${barPct}%`, background: '#10b981', borderRadius: 4, transition: 'width 0.3s' }} />
                            </div>
                            <div style={{ width: 60, textAlign: 'right', fontSize: 11, fontWeight: 600, color: '#111', flexShrink: 0 }}>{fmtKr(row.tip_revenue)}</div>
                            <div style={{ width: 34, textAlign: 'right', fontSize: 10, color: '#9ca3af', flexShrink: 0 }}>{tipRevPct}%</div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Daily staff cost % vs revenue — only shown when both data sources have data */}
            {srRows.length > 0 && (
              <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 20px', marginBottom: 16 }}>

                {/* Header + summary strip */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>Staff cost % vs revenue — daily</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>Target: {targetPct}% · {srSummary?.days_joined ?? 0} days with both staff + revenue data</div>
                  </div>
                  <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
                    {liveStaffPct !== null && (
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.06em' }}>Period avg</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: liveStaffPct > targetPct ? '#dc2626' : '#15803d' }}>{liveStaffPct.toFixed(1)}%</div>
                      </div>
                    )}
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.06em' }}>Over target</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: (srSummary?.days_over_target ?? 0) > 0 ? '#dc2626' : '#15803d' }}>{srSummary?.days_over_target ?? 0} days</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.06em' }}>Under target</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: '#15803d' }}>{srSummary?.days_under_target ?? 0} days</div>
                    </div>
                  </div>
                </div>

                {/* Daily bar chart — scrolls on narrow screens */}
                <div className="chart-scroll" style={{ marginBottom: 14 }}>
                <div className="chart-inner" style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {/* Target line label */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2 }}>
                    <div style={{ width: 90, fontSize: 10, color: '#9ca3af' }}></div>
                    <div style={{ flex: 1, position: 'relative', height: 12 }}>
                      <div style={{ position: 'absolute', left: `${(targetPct / maxSrPct) * 100}%`, top: 0, bottom: 0, width: 1, background: '#fcd34d', borderLeft: '1px dashed #fcd34d' }} />
                      <div style={{ position: 'absolute', left: `${(targetPct / maxSrPct) * 100 + 0.5}%`, top: 0, fontSize: 9, color: '#d97706', whiteSpace: 'nowrap' }}>{targetPct}% target</div>
                    </div>
                  </div>

                  {srRows.map((row: any) => {
                    const pct      = row.staff_pct ?? 0
                    const barPct   = maxSrPct > 0 ? (pct / maxSrPct) * 100 : 0
                    const overBy   = pct - targetPct
                    const isOver   = pct > targetPct
                    const isWarn   = pct > targetPct * 0.9 && !isOver  // within 10% of target
                    const barColor = isOver ? '#dc2626' : isWarn ? '#f59e0b' : '#15803d'
                    const fmtDate  = new Date(row.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
                    return (
                      <div key={row.date} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 90, fontSize: 11, color: '#6b7280', flexShrink: 0 }}>{fmtDate}</div>
                        <div style={{ flex: 1, height: 14, background: '#f3f4f6', borderRadius: 6, overflow: 'hidden', position: 'relative' }}>
                          {/* Target marker */}
                          <div style={{ position: 'absolute', left: `${(targetPct / maxSrPct) * 100}%`, top: 0, bottom: 0, width: 1, background: '#fcd34d', zIndex: 1 }} />
                          {/* Bar */}
                          <div style={{ height: '100%', width: `${barPct}%`, background: barColor, borderRadius: 6, opacity: 0.85, transition: 'width 0.3s' }} />
                        </div>
                        <div style={{ width: 42, textAlign: 'right', fontSize: 12, fontWeight: 700, color: barColor, flexShrink: 0 }}>{pct.toFixed(1)}%</div>
                        <div style={{ width: 52, textAlign: 'right', fontSize: 10, color: isOver ? '#dc2626' : '#9ca3af', flexShrink: 0 }}>
                          {overBy > 0 ? `+${overBy.toFixed(1)}%` : overBy < 0 ? `${overBy.toFixed(1)}%` : 'on target'}
                        </div>
                        <div style={{ width: 72, textAlign: 'right', fontSize: 10, color: '#9ca3af', flexShrink: 0 }}>{fmtKr(row.staff_cost)}</div>
                        <div style={{ width: 80, textAlign: 'right', fontSize: 10, color: '#9ca3af', flexShrink: 0 }}>{fmtKr(row.revenue)} rev</div>
                      </div>
                    )
                  })}
                </div>{/* end chart-inner */}
                </div>{/* end chart-scroll */}

                {/* Best / worst day callouts */}
                {(srSummary?.best_day || srSummary?.worst_day) && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, paddingTop: 10, borderTop: '0.5px solid #f3f4f6' }}>
                    {srSummary.best_day && (
                      <div style={{ padding: '8px 12px', background: '#f0fdf4', borderRadius: 8, border: '1px solid #bbf7d0' }}>
                        <div style={{ fontSize: 10, color: '#15803d', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>Best day</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>
                          {new Date(srSummary.best_day.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                          <span style={{ marginLeft: 8, color: '#15803d' }}>{srSummary.best_day.pct.toFixed(1)}%</span>
                        </div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{fmtKr(srSummary.best_day.staff_cost)} cost · {fmtKr(srSummary.best_day.revenue)} revenue</div>
                      </div>
                    )}
                    {srSummary.worst_day && (
                      <div style={{ padding: '8px 12px', background: '#fef2f2', borderRadius: 8, border: '1px solid #fecaca' }}>
                        <div style={{ fontSize: 10, color: '#dc2626', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>Highest cost day</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>
                          {new Date(srSummary.worst_day.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                          <span style={{ marginLeft: 8, color: '#dc2626' }}>{srSummary.worst_day.pct.toFixed(1)}%</span>
                        </div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{fmtKr(srSummary.worst_day.staff_cost)} cost · {fmtKr(srSummary.worst_day.revenue)} revenue</div>
                      </div>
                    )}
                  </div>
                )}

                {/* Days with staff data but no revenue (POS not connected or no sales) */}
                {(srSummary?.days_staff_only ?? 0) > 0 && (
                  <div style={{ marginTop: 10, fontSize: 11, color: '#9ca3af' }}>
                    {srSummary.days_staff_only} day{srSummary.days_staff_only !== 1 ? 's' : ''} had staff cost but no revenue data — excluded from % calculation
                  </div>
                )}
              </div>
            )}

            {/* Lateness patterns — only shown when there are late shifts */}
            {(summary?.late_shifts ?? 0) > 0 && (
              <div className="grid-2" style={{ marginBottom: 16 }}>

                {/* By department */}
                <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 20px' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 4 }}>Lateness by department</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 14 }}>Sorted by late rate · {summary.late_shifts} late shift{summary.late_shifts !== 1 ? 's' : ''} total</div>
                  {deptLateness.filter((d: any) => d.total_shifts > 0).map((d: any) => {
                    const isRed   = d.late_rate_pct > 20
                    const isAmber = d.late_rate_pct > 10 && !isRed
                    const barColor = isRed ? '#dc2626' : isAmber ? '#f59e0b' : '#15803d'
                    const maxRate  = deptLateness[0]?.late_rate_pct ?? 1
                    return (
                      <div key={d.dept} style={{ marginBottom: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: deptColor(d.dept), flexShrink: 0 }} />
                            <span style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>{d.dept}</span>
                          </div>
                          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                            {d.late_count > 0 && (
                              <span style={{ fontSize: 11, color: '#9ca3af' }}>{d.late_count} late · avg {d.avg_late_minutes} min</span>
                            )}
                            <span style={{ fontSize: 13, fontWeight: 700, color: d.late_count > 0 ? barColor : '#9ca3af' }}>
                              {d.late_count > 0 ? `${d.late_rate_pct.toFixed(1)}%` : '—'}
                            </span>
                          </div>
                        </div>
                        <div style={{ height: 6, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: d.late_count > 0 ? `${(d.late_rate_pct / Math.max(maxRate, 1)) * 100}%` : '0%', background: barColor, borderRadius: 4, transition: 'width 0.3s' }} />
                        </div>
                        <div style={{ fontSize: 10, color: '#d1d5db', marginTop: 2 }}>{d.total_shifts} shifts total</div>
                      </div>
                    )
                  })}
                </div>

                {/* By day of week */}
                <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 20px' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 4 }}>Lateness by day of week</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 14 }}>Late shift count per weekday across the period</div>
                  {(() => {
                    const maxCount = Math.max(...weekdayLateness.map((d: any) => d.late_count), 1)
                    return weekdayLateness.map((d: any) => {
                      const isRed   = d.total_shifts > 0 && d.late_rate_pct > 20
                      const isAmber = d.total_shifts > 0 && d.late_rate_pct > 10 && !isRed
                      const barColor = isRed ? '#dc2626' : isAmber ? '#f59e0b' : d.late_count > 0 ? '#6366f1' : '#f3f4f6'
                      return (
                        <div key={d.weekday} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                          <div style={{ width: 28, fontSize: 12, fontWeight: 600, color: d.late_count > 0 ? '#374151' : '#d1d5db', flexShrink: 0 }}>{d.label}</div>
                          <div style={{ flex: 1, height: 14, background: '#f3f4f6', borderRadius: 6, overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${(d.late_count / maxCount) * 100}%`, background: barColor, borderRadius: 6, transition: 'width 0.3s' }} />
                          </div>
                          {d.late_count > 0 ? (
                            <>
                              <div style={{ width: 18, textAlign: 'right', fontSize: 13, fontWeight: 700, color: barColor, flexShrink: 0 }}>{d.late_count}</div>
                              <div style={{ width: 52, textAlign: 'right', fontSize: 10, color: '#9ca3af', flexShrink: 0 }}>{d.late_rate_pct.toFixed(0)}% rate</div>
                            </>
                          ) : (
                            <>
                              <div style={{ width: 18, textAlign: 'right', fontSize: 12, color: '#d1d5db', flexShrink: 0 }}>0</div>
                              <div style={{ width: 52 }} />
                            </>
                          )}
                          <div style={{ width: 28, textAlign: 'right', fontSize: 10, color: '#d1d5db', flexShrink: 0 }}>{d.total_shifts > 0 ? `${d.total_shifts}s` : ''}</div>
                        </div>
                      )
                    })
                  })()}
                </div>
              </div>
            )}

            {/* OB supplement by type — only shown when ob_type data exists */}
            {hasObTypes && (
              <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 20px', marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>OB supplement by type</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>Total: {Math.round(totalObSupplement).toLocaleString('en-GB')} kr across {summary.shifts_with_ob} shifts</div>
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 14 }}>Unsocial hours cost breakdown — sorted by highest spend</div>
                <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
                  {obTypeBreakdown.map((ob: any) => {
                    const pct     = totalObSupplement > 0 ? Math.round((ob.kr / totalObSupplement) * 100) : 0
                    const barPct  = totalObSupplement > 0 ? (ob.kr / (obTypeBreakdown[0]?.kr ?? 1)) * 100 : 0
                    return (
                      <div key={ob.type}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                          <span style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>{ob.type}</span>
                          <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
                            <span style={{ fontSize: 11, color: '#9ca3af' }}>{pct}% of total</span>
                            <span style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>{ob.kr.toLocaleString('en-GB')} kr</span>
                          </div>
                        </div>
                        <div style={{ height: 8, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${barPct}%`, background: '#6366f1', borderRadius: 4, opacity: 0.7, transition: 'width 0.4s' }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
                {/* Cost-saving nudge: highlight the biggest type */}
                {obTypeBreakdown[0] && totalObSupplement > 0 && (
                  <div style={{ marginTop: 14, paddingTop: 12, borderTop: '0.5px solid #f3f4f6', fontSize: 11, color: '#6b7280' }}>
                    <strong style={{ color: '#111' }}>{obTypeBreakdown[0].type}</strong> is your largest OB category at {Math.round((obTypeBreakdown[0].kr / totalObSupplement) * 100)}% of total supplement cost.
                    {obTypeBreakdown.length > 1 && ` Reducing shifts in this category has the highest impact on OB spend.`}
                  </div>
                )}
              </div>
            )}

            {/* Search */}
            <div style={{ marginBottom: 12 }}>
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search by name or department..."
                style={{ width: '100%', padding: '10px 14px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' as const, fontFamily: 'inherit' }} />
            </div>

            {/* Staff table */}
            <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '12px 20px', borderBottom: '0.5px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{sorted.length} staff members</div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>Sorted by cost   click to expand</div>
              </div>
              <div className="table-scroll">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#fafafa' }}>
                    {['', 'Name', 'Department', 'Hours', 'Estimated', 'Actual cost', 'Variance', 'Shifts'].map((h, i) => (
                      <th key={i} style={{ textAlign: h === 'Name' || h === 'Department' || h === '' ? 'left' : 'right', padding: '9px 12px', color: '#9ca3af', fontWeight: 600, fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '.06em', whiteSpace: 'nowrap' as const }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((s: any) => {
                    const isExp = expanded === s.id
                    const hasActivity = s.cost_actual > 0 || s.hours_logged > 0
                    return (
                      <>
                        <tr key={s.id}
                          onClick={() => setExpanded(isExp ? null : s.id)}
                          style={{ borderTop: '0.5px solid #f3f4f6', cursor: 'pointer', background: isExp ? '#fafbff' : 'white' }}>
                          {/* Expand */}
                          <td style={{ padding: '10px 8px 10px 16px', color: '#9ca3af', fontSize: 11, width: 20 }}>
                            {isExp ? 'v' : '>'}
                          </td>
                          {/* Name */}
                          <td style={{ padding: '10px 12px', fontWeight: 500, color: '#111', whiteSpace: 'nowrap' as const }}>
                            {s.name}
                            {(s.late_shifts ?? 0) > 0 && (
                              <span style={{ marginLeft: 6, fontSize: 9, background: '#fef3c7', color: '#d97706', padding: '1px 4px', borderRadius: 3, fontWeight: 700 }}>
                                {s.late_shifts}x late
                              </span>
                            )}
                          </td>
                          {/* Dept */}
                          <td style={{ padding: '10px 12px' }}>
                            {s.group ? (
                              <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 4, background: deptColor(s.group) + '20', color: deptColor(s.group), fontWeight: 600 }}>
                                {s.group}
                              </span>
                            ) : <span style={{ color: '#d1d5db' }}> </span>}
                          </td>
                          {/* Hours */}
                          <td style={{ padding: '10px 12px', textAlign: 'right' as const, color: '#111', fontWeight: hasActivity ? 600 : 400 }}>
                            {hasActivity ? fmtH(s.hours_logged) : <span style={{ color: '#d1d5db' }}> </span>}
                          </td>
                          {/* Estimated salary */}
                          <td style={{ padding: '10px 12px', textAlign: 'right' as const, color: '#6366f1' }}>
                            {s.estimated_salary > 0 ? fmtKr(s.estimated_salary) : <span style={{ color: '#d1d5db' }}>—</span>}
                          </td>
                          {/* Actual cost */}
                          <td style={{ padding: '10px 12px', textAlign: 'right' as const, fontWeight: 700, color: hasActivity ? '#111' : '#d1d5db' }}>
                            {s.cost_actual > 0 ? fmtKr(s.cost_actual) : s.estimated_salary > 0 ? <span style={{ color: '#9ca3af', fontSize: 11 }}>pending</span> : '—'}
                          </td>
                          {/* Variance */}
                          <td style={{ padding: '10px 12px', textAlign: 'right' as const }}>
                            {s.cost_variance !== 0
                              ? <span style={{ fontSize: 12, fontWeight: 600, color: s.cost_variance > 0 ? '#dc2626' : '#15803d' }}>
                                  {s.cost_variance > 0 ? '+' : ''}{fmtKr(s.cost_variance)}
                                </span>
                              : <span style={{ color: '#d1d5db' }}>—</span>}
                          </td>
                          {/* Shifts */}
                          <td style={{ padding: '10px 12px', textAlign: 'right' as const, color: '#6b7280' }}>
                            {s.shifts_logged > 0 ? s.shifts_logged : <span style={{ color: '#d1d5db' }}> </span>}
                          </td>
                        </tr>

                        {/* Expanded detail */}
                        {isExp && (
                          <tr key={`exp-${s.id}`}>
                            <td colSpan={8} style={{ background: 'white', borderTop: '0.5px solid #e5e7eb', borderBottom: '0.5px solid #e5e7eb', padding: 0 }}>
                              <div style={{ padding: '14px 20px 14px 48px' }}>

                                {/* Salary breakdown */}
                                {(s.estimated_salary > 0 || s.cost_actual > 0) && (
                                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12, padding: '10px 14px', background: '#f9fafb', borderRadius: 8 }}>
                                    {[
                                      { label: 'Estimated salary', value: s.estimated_salary > 0 ? fmtKr(s.estimated_salary) : '—', color: '#6366f1', hint: 'hours × rate' },
                                      { label: 'Actual cost',      value: s.cost_actual > 0 ? fmtKr(s.cost_actual) : 'Pending',      color: s.cost_actual > 0 ? '#111' : '#9ca3af', hint: 'incl. taxes' },
                                      { label: 'Variance',         value: s.cost_variance !== 0 ? (s.cost_variance > 0 ? '+' : '') + fmtKr(s.cost_variance) : '—', color: s.cost_variance > 0 ? '#dc2626' : s.cost_variance < 0 ? '#15803d' : '#9ca3af', hint: 'actual − estimated' },
                                      { label: 'Tax multiplier',   value: s.tax_multiplier ? s.tax_multiplier.toFixed(2) + '×' : '—', color: '#9ca3af', hint: s.tax_multiplier ? `${Math.round((s.tax_multiplier - 1) * 100)}% overhead` : 'pending' },
                                    ].map(r => (
                                      <div key={r.label}>
                                        <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 2 }}>{r.label}</div>
                                        <div style={{ fontSize: 14, fontWeight: 700, color: r.color }}>{r.value}</div>
                                        <div style={{ fontSize: 10, color: '#d1d5db' }}>{r.hint}</div>
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {/* Late arrival warning */}
                                {(s.late_shifts ?? 0) > 0 && (
                                  <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 12 }}>
                                    <span style={{ fontWeight: 600, color: '#d97706' }}>Late arrivals:</span>
                                    <span style={{ color: '#92400e', marginLeft: 6 }}>
                                      {s.late_shifts} shift{s.late_shifts !== 1 ? 's' : ''} started late
                                      {s.avg_late_minutes > 0 ? `, avg ${s.avg_late_minutes} min` : ''}
                                    </span>
                                  </div>
                                )}

                                {/* OB supplement by type — per staff member */}
                                {s.ob_types && Object.keys(s.ob_types).length > 0 && (
                                  <div style={{ marginBottom: 12 }}>
                                    <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 6 }}>OB supplement by type</div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6 }}>
                                      {Object.entries(s.ob_types)
                                        .sort((a: any, b: any) => b[1] - a[1])
                                        .map(([type, kr]: any) => (
                                          <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: '#f0f0ff', borderRadius: 6, border: '0.5px solid #e0e0ff' }}>
                                            <span style={{ fontSize: 11, color: '#4f46e5' }}>{type}</span>
                                            <span style={{ fontSize: 11, fontWeight: 700, color: '#111' }}>{Math.round(kr).toLocaleString('en-GB')} kr</span>
                                          </div>
                                        ))}
                                    </div>
                                  </div>
                                )}

                                {/* Cost by section */}
                                {s.costgroups && Object.keys(s.costgroups).length > 0 ? (
                                  <div>
                                    <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 8 }}>Cost by section</div>
                                    {Object.entries(s.costgroups).sort((a: any, b: any) => b[1] - a[1]).map(([section, cost]: any) => (
                                      <div key={section} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '0.5px solid #f3f4f6', fontSize: 12 }}>
                                        <span style={{ color: '#6b7280' }}>{section}</span>
                                        <span style={{ fontWeight: 600, color: '#111' }}>{fmtKr(cost)}</span>
                                      </div>
                                    ))}
                                  </div>
                                ) : !hasActivity ? (
                                  <div style={{ fontSize: 12, color: '#9ca3af' }}>No shifts logged in this period   try expanding the date range.</div>
                                ) : (
                                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, fontSize: 12 }}>
                                    {[
                                      { label: 'Hours logged',  value: fmtH(s.hours_logged) },
                                      { label: 'Cost/hour',     value: s.cost_per_hour > 0 ? fmtKr(s.cost_per_hour) : '—' },
                                      { label: 'Shifts logged', value: String(s.shifts_logged) },
                                    ].map(r => (
                                      <div key={r.label}>
                                        <div style={{ color: '#9ca3af', marginBottom: 2 }}>{r.label}</div>
                                        <div style={{ fontWeight: 600, color: '#111' }}>{r.value}</div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })}
                  {sorted.length === 0 && (
                    <tr><td colSpan={8} style={{ padding: '40px', textAlign: 'center' as const, color: '#d1d5db', fontSize: 13 }}>
                      {search ? `No staff matching "${search}"` : 'No staff data for this period'}
                    </td></tr>
                  )}
                </tbody>
              </table>
              </div>{/* end table-scroll */}
              <div style={{ padding: '10px 20px', borderTop: '0.5px solid #f3f4f6', fontSize: 11, color: '#9ca3af', display: 'flex', gap: 16, flexWrap: 'wrap' as const }}>
                <span>{sorted.length} staff</span>
                {totalEstimated > 0 && <span>Estimated: <strong style={{ color: '#6366f1' }}>{fmtKr(totalEstimated)}</strong></span>}
                {totalActual > 0 && <span>Actual: <strong style={{ color: '#111' }}>{fmtKr(totalActual)}</strong></span>}
                {taxMultiplier && <span>Multiplier: <strong style={{ color: '#9ca3af' }}>{taxMultiplier.toFixed(2)}×</strong></span>}
              </div>
            </div>
          </>
        )}
      </div>

      {/* AI panel — sees staff summary and individual staff member costs */}
      <AskAI
        page="staff"
        context={summary ? [
          `Period: ${fromDate} to ${toDate}`,
          `Total logged hours: ${fmtH(summary.logged_hours)}`,
          `Total scheduled hours: ${fmtH(summary.scheduled_hours)}`,
          `Variance (logged vs scheduled): ${fmtH(variance)}`,
          `Total staff cost: ${fmtKr(summary.staff_cost_actual)}`,
          `Shifts logged: ${summary.shifts_logged}`,
          totalEstimated > 0 ? `Estimated salary: ${fmtKr(totalEstimated)} (net pay before taxes)` : '',
          totalActual > 0 ? `Actual employer cost: ${fmtKr(totalActual)} (incl. taxes & vacation pay)` : payrollPending ? 'Payroll not yet approved — using estimated salary' : '',
          taxMultiplier ? `Tax multiplier: ${taxMultiplier.toFixed(2)}× (${Math.round((taxMultiplier - 1) * 100)}% employer overhead)` : '',
          costVariance !== 0 ? `Cost variance: ${costVariance > 0 ? '+' : ''}${fmtKr(costVariance)} vs estimate` : '',
          totalTips > 0 ? `Tips earned this period: ${fmtKr(totalTips)} (${tipPct.toFixed(1)}% of staff cost, avg ${fmtKr(avgDailyTip)}/day)` : 'No tip data available',
          totalTips > 0 ? `Net staff cost after tips: ${fmtKr(netBurden)}` : '',
          deptLateness.filter((d: any) => d.late_count > 0).length > 0
            ? `Lateness by dept: ${deptLateness.filter((d: any) => d.late_count > 0).map((d: any) => `${d.dept} ${d.late_rate_pct.toFixed(1)}% (${d.late_count} late, avg ${d.avg_late_minutes} min)`).join('; ')}`
            : '',
          weekdayLateness.filter((d: any) => d.late_count > 0).length > 0
            ? `Lateness by weekday: ${weekdayLateness.filter((d: any) => d.late_count > 0).map((d: any) => `${d.label} ${d.late_count} late (${d.late_rate_pct.toFixed(0)}%)`).join(', ')}`
            : '',
          hasObTypes ? `OB supplement by type (total ${fmtKr(totalObSupplement)}): ${obTypeBreakdown.map((ob: any) => `${ob.type} ${fmtKr(ob.kr)} (${Math.round((ob.kr / totalObSupplement) * 100)}%)`).join(', ')}` : '',
          sorted.length > 0 ? `Top staff by cost:\n${sorted.slice(0,10).map((s: any) => `  ${s.name} (${s.group}): ${fmtKr(s.cost_actual)}, ${fmtH(s.hours_worked)}`).join('\n')}` : 'No staff data',
        ].filter(Boolean).join('\n') : 'No staff data loaded'}
      />
    </AppShell>
  )
}
