'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'
import { deptColor, deptBg, DEPT_COLORS, KPI_CARD, CC_DARK, CC_PURPLE } from '@/lib/constants/colors'

const fmtKr = (n: number) => Math.round(n).toLocaleString('sv-SE') + ' kr'
const fmtH  = (n: number) => (Math.round(n * 10) / 10) + 'h'

// deptColor() imported from @/lib/constants/colors
// deptColor imported from @/lib/constants/colors

export default function StaffPage() {
  const now = new Date()
  const defaultFrom = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`
  const defaultTo   = now.toISOString().slice(0,10)

  const [data,      setData]      = useState<any>(null)
  const [tipData,   setTipData]   = useState<any>(null)
  const [loading,   setLoading]   = useState(true)
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
      const [staffRes, revRes] = await Promise.all([
        fetch(`/api/staff?from=${fromDate}&to=${toDate}${bizParam}`),
        selectedBiz ? fetch(`/api/revenue-detail?business_id=${selectedBiz}&from=${fromDate}&to=${toDate}`) : Promise.resolve(null),
      ])
      const json = await staffRes.json()
      if (!staffRes.ok) throw new Error(json.error ?? 'Failed')
      setData(json)
      if (revRes?.ok) {
        const revJson = await revRes.json()
        setTipData(revJson)
      }
    } catch (e: any) { setError(e.message) }
    setLoading(false)
  }, [fromDate, toDate, selectedBiz])

  useEffect(() => { load() }, [load])

  const summary = data?.summary ?? null
  const staff   = data?.staff   ?? []
  const connected = data?.connected ?? false

  const filtered = staff.filter((s: any) =>
    !search ||
    (s.name ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (s.group ?? '').toLowerCase().includes(search.toLowerCase())
  )
  const sorted = [...filtered].sort((a: any, b: any) => b.cost_actual - a.cost_actual)

  const variance = summary ? Math.round((summary.logged_hours - summary.scheduled_hours) * 10) / 10 : 0

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
      <div style={{ padding: '28px', maxWidth: 1100, width: '100%' }}>

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
            {/* KPI cards — 6 staff + 1 tips */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 10, marginBottom: 16 }}>
              {[
                { label: 'Hours logged',    value: fmtH(summary.logged_hours),          sub: `${summary.shifts_logged} shifts`,        color: '#111' },
                { label: 'Hours scheduled', value: fmtH(summary.scheduled_hours),        sub: `${summary.shifts_scheduled} shifts`,      color: '#111' },
                { label: 'Variance',        value: (variance >= 0 ? '+' : '') + fmtH(variance), sub: 'logged vs scheduled',               color: Math.abs(variance) > 10 ? '#dc2626' : '#15803d' },
                { label: 'Staff cost',      value: fmtKr(summary.staff_cost_actual),     sub: `vs ${fmtKr(summary.staff_cost_scheduled)} scheduled`, color: '#111' },
                { label: 'Late arrivals',   value: String(summary.late_shifts ?? 0),     sub: 'shifts starting late',                   color: (summary.late_shifts ?? 0) > 0 ? '#dc2626' : '#15803d' },
                { label: 'OB shifts',       value: String(summary.shifts_with_ob ?? 0),  sub: 'unsocial hours',                          color: '#9ca3af' },
                { label: 'Tips earned',     value: totalTips > 0 ? fmtKr(totalTips) : '—', sub: totalTips > 0 ? `${tipPct.toFixed(1)}% of staff cost` : 'No tip data', color: tipPct >= 5 ? '#15803d' : '#9ca3af' },
                { label: 'Net staff burden', value: totalTips > 0 ? fmtKr(netBurden) : '—', sub: totalTips > 0 ? `after ${fmtKr(totalTips)} tips` : 'Connect Inzii for tips', color: '#111' },
              ].map(kpi => (
                <div key={kpi.label} style={{ background: 'white', border: `0.5px solid ${kpi.color === '#dc2626' ? '#fecaca' : '#e5e7eb'}`, borderRadius: 12, padding: '14px 16px' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 6 }}>{kpi.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: kpi.color, marginBottom: 3 }}>{kpi.value}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{kpi.sub}</div>
                </div>
              ))}
            </div>

            {/* Cost and hours panels */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>

              {/* Cost panel */}
              <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 20px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 14 }}>Cost   scheduled vs actual</div>
                {[
                  { label: 'Scheduled', value: fmtKr(summary.staff_cost_scheduled), color: '#6366f1' },
                  { label: 'Actual',    value: fmtKr(summary.staff_cost_actual),    color: '#1a1f2e' },
                  { label: 'Difference', value: fmtKr(Math.abs(summary.staff_cost_actual - summary.staff_cost_scheduled)),
                    color: summary.staff_cost_actual > summary.staff_cost_scheduled ? '#dc2626' : '#15803d' },
                ].map(row => (
                  <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '0.5px solid #f3f4f6' }}>
                    <span style={{ fontSize: 13, color: '#6b7280' }}>{row.label}</span>
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
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>

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
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#fafafa' }}>
                    {['', 'Name', 'Department', 'Hours', 'Scheduled', 'Cost', 'Cost/h', 'Shifts'].map((h, i) => (
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
                          {/* Scheduled */}
                          <td style={{ padding: '10px 12px', textAlign: 'right' as const, color: '#6b7280' }}>
                            {s.hours_scheduled > 0 ? fmtH(s.hours_scheduled) : <span style={{ color: '#d1d5db' }}> </span>}
                          </td>
                          {/* Cost */}
                          <td style={{ padding: '10px 12px', textAlign: 'right' as const, fontWeight: 700, color: hasActivity ? '#111' : '#d1d5db' }}>
                            {hasActivity ? fmtKr(s.cost_actual) : ' '}
                          </td>
                          {/* Cost/h */}
                          <td style={{ padding: '10px 12px', textAlign: 'right' as const, color: '#6b7280' }}>
                            {s.cost_per_hour > 0 ? fmtKr(s.cost_per_hour) : <span style={{ color: '#d1d5db' }}> </span>}
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
                                      { label: 'Hours logged',   value: fmtH(s.hours_logged) },
                                      { label: 'Cost actual',    value: fmtKr(s.cost_actual) },
                                      { label: 'Cost/hour',      value: s.cost_per_hour > 0 ? fmtKr(s.cost_per_hour) : ' ' },
                                      { label: 'Shifts logged',  value: String(s.shifts_logged) },
                                      { label: 'Scheduled hrs',  value: fmtH(s.hours_scheduled) },
                                      { label: 'Variance',       value: fmtH(s.variance_hours) },
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
              <div style={{ padding: '10px 20px', borderTop: '0.5px solid #f3f4f6', fontSize: 11, color: '#9ca3af' }}>
                {sorted.length} staff - {sorted.reduce((s: number, m: any) => s + m.cost_actual, 0) > 0 ? fmtKr(sorted.reduce((s: number, m: any) => s + m.cost_actual, 0)) + ' total cost' : 'no cost data for this period'}
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
          totalTips > 0 ? `Tips earned this period: ${fmtKr(totalTips)} (${tipPct.toFixed(1)}% of staff cost, avg ${fmtKr(avgDailyTip)}/day)` : 'No tip data available',
          totalTips > 0 ? `Net staff cost after tips: ${fmtKr(netBurden)}` : '',
          sorted.length > 0 ? `Top staff by cost:\n${sorted.slice(0,10).map((s: any) => `  ${s.name} (${s.group}): ${fmtKr(s.cost_actual)}, ${fmtH(s.hours_worked)}`).join('\n')}` : 'No staff data',
        ].filter(Boolean).join('\n') : 'No staff data loaded'}
      />
    </AppShell>
  )
}
