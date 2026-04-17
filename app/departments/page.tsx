'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { deptColor, DEPT_COLORS } from '@/lib/constants/colors'

const fmtKr  = (n: number) => Math.round(n).toLocaleString('en-GB') + ' kr'
const fmtPct = (n: number | null) => n != null ? n.toFixed(1) + '%' : '—'
const fmtH   = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-GB') + 'h'

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// Date helpers
function monthStart() {
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`
}
function today() { return new Date().toISOString().slice(0,10) }

export default function DepartmentsPage() {
  const router = useRouter()
  const now    = new Date()

  const [data,        setData]        = useState<any>(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')
  const [from,        setFrom]        = useState(monthStart())
  const [to,          setTo]          = useState(today())
  const [view,        setView]        = useState<'revenue'|'cost'|'gp'>('revenue')
  const [selectedBiz, setSelectedBiz] = useState('')

  // Sync with sidebar business switcher
  useEffect(() => {
    const sync = () => {
      const saved = localStorage.getItem('cc_selected_biz')
      if (saved) setSelectedBiz(saved)
    }
    sync()
    window.addEventListener('storage', sync)
    window.addEventListener('cc_biz_change', sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener('cc_biz_change', sync)
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const biz  = selectedBiz ? `&business_id=${selectedBiz}` : ''
      const res  = await fetch(`/api/departments?from=${from}&to=${to}${biz}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load')
      setData(json)
    } catch (e: any) { setError(e.message) }
    setLoading(false)
  }, [from, to, selectedBiz])

  // Load on mount (using whatever business is already in state) and whenever deps change
  useEffect(() => { load() }, [load])

  const depts: any[]  = data?.departments ?? []
  const summary: any  = data?.summary     ?? {}
  const monthly: any[] = data?.monthly    ?? []
  const hasRevenue     = depts.some(d => d.revenue > 0)
  const hasCost        = depts.some(d => d.staff_cost > 0)

  // Best/worst by GP%
  const deptsWithGP    = depts.filter(d => d.gp_pct != null && d.revenue > 0)
  const best           = deptsWithGP.reduce((a, b) => (b.gp_pct > a.gp_pct ? b : a), deptsWithGP[0] ?? null)
  const worst          = deptsWithGP.reduce((a, b) => (b.gp_pct < a.gp_pct ? b : a), deptsWithGP[0] ?? null)

  // Bar chart max for comparison
  const barMax = Math.max(...depts.map(d =>
    view === 'revenue' ? d.revenue :
    view === 'cost'    ? d.staff_cost :
    Math.abs(d.gp_pct ?? 0)
  ), 1)

  return (
    <AppShell>
      <div className="page-wrap" style={{ maxWidth: 1100 }}>

        {/* ── Header ───────────────────────────────────────────────────────── */}
        <div className="page-header" style={{ marginBottom: 24 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: '#111' }}>Departments</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
              Revenue, labour cost and margin per department
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const, alignItems: 'center' }}>
            {/* View toggle */}
            <div style={{ display: 'flex', background: '#f3f4f6', borderRadius: 8, padding: 3 }}>
              {(['revenue','cost','gp'] as const).map(v => (
                <button key={v} onClick={() => setView(v)}
                  style={{ padding: '6px 12px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    background: view === v ? 'white' : 'transparent',
                    color:      view === v ? '#111'  : '#9ca3af',
                    boxShadow:  view === v ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>
                  {v === 'revenue' ? 'Revenue' : v === 'cost' ? 'Labour' : 'GP%'}
                </button>
              ))}
            </div>
            {/* Date range */}
            <input type="date" value={from} onChange={e => setFrom(e.target.value)}
              style={{ padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12 }} />
            <span style={{ color: '#9ca3af', fontSize: 12 }}>→</span>
            <input type="date" value={to} onChange={e => setTo(e.target.value)}
              style={{ padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12 }} />
          </div>
        </div>

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12,
            padding: '14px 18px', marginBottom: 20, fontSize: 13, color: '#dc2626' }}>{error}</div>
        )}

        {loading ? (
          <div style={{ padding: 80, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading departments...</div>
        ) : depts.length === 0 ? (
          <div style={{ padding: 80, textAlign: 'center', color: '#9ca3af' }}>
            <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 8 }}>No department data found</div>
            <div style={{ fontSize: 13, marginBottom: 8 }}>No staff data found for this period. Try widening the date range, or check that Personalkollen has synced.</div>
            <div style={{ fontSize: 12, color: '#d1d5db' }}>If you haven't run the M006 SQL migration yet, do that first, then click "Setup Departments" in the Admin panel.</div>
          </div>
        ) : (
          <>
            {/* ── Group summary KPIs ─────────────────────────────────────── */}
            <div className="grid-4" style={{ marginBottom: 20 }}>
              {[
                { label: 'Total Revenue', value: fmtKr(summary.total_revenue ?? 0), sub: `${summary.total_covers ?? 0} covers`, show: hasRevenue },
                { label: 'Total Labour',  value: fmtKr(summary.total_staff_cost ?? 0), sub: fmtH(summary.total_hours ?? 0) + ' hours', show: hasCost },
                { label: 'Labour %',      value: fmtPct(summary.labour_pct),     sub: 'of revenue', show: hasRevenue && hasCost },
                { label: 'Rev / Hour',    value: summary.rev_per_hour ? fmtKr(summary.rev_per_hour) : '—', sub: 'revenue per labour hour', show: hasRevenue && hasCost },
              ].filter(k => k.show !== false).map(k => (
                <div key={k.label} style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '14px 16px' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 6 }}>{k.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#111', marginBottom: 2 }}>{k.value}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{k.sub}</div>
                </div>
              ))}
            </div>

            {/* ── Best / worst callout ───────────────────────────────────── */}
            {deptsWithGP.length >= 2 && best && worst && best.name !== worst.name && (
              <div className="grid-2" style={{ marginBottom: 20 }}>
                <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: best.color ?? deptColor(best.name), flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#15803d', textTransform: 'uppercase' as const, letterSpacing: '.06em' }}>Best GP%</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{best.name} — {fmtPct(best.gp_pct)}</div>
                  </div>
                </div>
                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: worst.color ?? deptColor(worst.name), flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#dc2626', textTransform: 'uppercase' as const, letterSpacing: '.06em' }}>Needs attention</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{worst.name} — {fmtPct(worst.gp_pct)}</div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Department cards ───────────────────────────────────────── */}
            <div className="grid-auto" style={{ marginBottom: 24 }}>
              {depts.map(dept => {
                const c = dept.color ?? deptColor(dept.name)
                return (
                  <div key={dept.name}
                    onClick={() => router.push(`/departments/${encodeURIComponent(dept.name)}${selectedBiz ? `?business_id=${selectedBiz}` : ''}`)}
                    style={{ background: 'white', border: `1.5px solid #e5e7eb`, borderRadius: 12, padding: '16px', cursor: 'pointer',
                      transition: 'border-color 0.15s, box-shadow 0.15s' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor = c; (e.currentTarget as HTMLDivElement).style.boxShadow = `0 4px 16px ${c}30` }}
                    onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = '#e5e7eb'; (e.currentTarget as HTMLDivElement).style.boxShadow = 'none' }}>

                    {/* Dept name + colour dot */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                      <div style={{ width: 10, height: 10, borderRadius: '50%', background: c, flexShrink: 0 }} />
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{dept.name}</div>
                      <div style={{ marginLeft: 'auto', fontSize: 10, color: '#9ca3af' }}>→</div>
                    </div>

                    {/* Primary metric */}
                    {dept.revenue > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '.06em', marginBottom: 2 }}>Revenue</div>
                        <div style={{ fontSize: 19, fontWeight: 700, color: '#111' }}>{fmtKr(dept.revenue)}</div>
                        {dept.covers > 0 && (
                          <div style={{ fontSize: 11, color: '#9ca3af' }}>{dept.covers} covers · {fmtKr(dept.avg_spend)} avg</div>
                        )}
                      </div>
                    )}

                    {/* Labour cost */}
                    {dept.staff_cost > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '.06em', marginBottom: 2 }}>Labour</div>
                        <div style={{ fontSize: 15, fontWeight: 600, color: '#374151' }}>{fmtKr(dept.staff_cost)}</div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{fmtH(dept.hours)} · {dept.staff.length} staff</div>
                      </div>
                    )}

                    {/* GP% bar */}
                    {dept.gp_pct != null && (
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '.06em' }}>GP%</div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: dept.gp_pct >= 60 ? '#10b981' : dept.gp_pct >= 40 ? '#d97706' : '#dc2626' }}>
                            {fmtPct(dept.gp_pct)}
                          </div>
                        </div>
                        <div style={{ height: 4, background: '#f3f4f6', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{ height: '100%', borderRadius: 2, width: `${Math.min(dept.gp_pct, 100)}%`,
                            background: dept.gp_pct >= 60 ? '#10b981' : dept.gp_pct >= 40 ? '#d97706' : '#dc2626' }} />
                        </div>
                      </div>
                    )}

                    {(!dept.revenue && !dept.staff_cost) && (
                      <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', padding: '8px 0' }}>No data for period</div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* ── Comparison bar chart ───────────────────────────────────── */}
            <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '18px 20px', marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 16 }}>
                {view === 'revenue' ? 'Revenue by department' : view === 'cost' ? 'Labour cost by department' : 'GP% by department'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
                {[...depts].sort((a, b) => {
                  const va = view === 'revenue' ? a.revenue : view === 'cost' ? a.staff_cost : (a.gp_pct ?? 0)
                  const vb = view === 'revenue' ? b.revenue : view === 'cost' ? b.staff_cost : (b.gp_pct ?? 0)
                  return vb - va
                }).map(dept => {
                  const val = view === 'revenue' ? dept.revenue : view === 'cost' ? dept.staff_cost : (dept.gp_pct ?? 0)
                  const pct = Math.min((val / barMax) * 100, 100)
                  const c   = dept.color ?? deptColor(dept.name)
                  return (
                    <div key={dept.name} style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}
                      onClick={() => router.push(`/departments/${encodeURIComponent(dept.name)}${selectedBiz ? `?business_id=${selectedBiz}` : ''}`)}>
                      <div style={{ width: 90, fontSize: 12, fontWeight: 500, color: '#374151', textAlign: 'right', flexShrink: 0 }}>{dept.name}</div>
                      <div style={{ flex: 1, height: 20, background: '#f9fafb', borderRadius: 4, overflow: 'hidden', position: 'relative' }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: c, borderRadius: 4, transition: 'width 0.4s ease' }} />
                      </div>
                      <div style={{ width: 100, fontSize: 12, fontWeight: 600, color: '#111', flexShrink: 0 }}>
                        {view === 'gp' ? fmtPct(dept.gp_pct) : fmtKr(val)}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* ── Side-by-side summary table ─────────────────────────────── */}
            <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', marginBottom: 20 }}>
              <div style={{ padding: '14px 20px', borderBottom: '0.5px solid #f3f4f6' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>Full comparison</div>
              </div>
              <div className="table-scroll">
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#fafafa' }}>
                      {['Department','Revenue','Labour Cost','Labour %','GP%','Rev/Hour','Hours','Covers','Avg Spend'].map(h => (
                        <th key={h} style={{ textAlign: h === 'Department' ? 'left' : 'right', padding: '9px 14px',
                          color: '#9ca3af', fontWeight: 600, fontSize: 11, textTransform: 'uppercase' as const,
                          letterSpacing: '.06em', whiteSpace: 'nowrap' as const }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {depts.map(dept => {
                      const c = dept.color ?? deptColor(dept.name)
                      return (
                        <tr key={dept.name} style={{ borderTop: '0.5px solid #f3f4f6', cursor: 'pointer' }}
                          onClick={() => router.push(`/departments/${encodeURIComponent(dept.name)}${selectedBiz ? `?business_id=${selectedBiz}` : ''}`)}>
                          <td style={{ padding: '10px 14px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ width: 8, height: 8, borderRadius: '50%', background: c, flexShrink: 0 }} />
                              <span style={{ fontWeight: 600, color: '#111' }}>{dept.name}</span>
                            </div>
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: '#111' }}>
                            {dept.revenue > 0 ? fmtKr(dept.revenue) : <span style={{ color: '#e5e7eb' }}>—</span>}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', color: '#374151' }}>
                            {dept.staff_cost > 0 ? fmtKr(dept.staff_cost) : <span style={{ color: '#e5e7eb' }}>—</span>}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right',
                            color: dept.labour_pct == null ? '#e5e7eb' : dept.labour_pct > 40 ? '#dc2626' : dept.labour_pct > 30 ? '#d97706' : '#10b981' }}>
                            {fmtPct(dept.labour_pct)}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700,
                            color: dept.gp_pct == null ? '#e5e7eb' : dept.gp_pct >= 60 ? '#10b981' : dept.gp_pct >= 40 ? '#d97706' : '#dc2626' }}>
                            {fmtPct(dept.gp_pct)}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', color: '#374151' }}>
                            {dept.rev_per_hour > 0 ? fmtKr(dept.rev_per_hour) : <span style={{ color: '#e5e7eb' }}>—</span>}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', color: '#6b7280' }}>
                            {dept.hours > 0 ? fmtH(dept.hours) : <span style={{ color: '#e5e7eb' }}>—</span>}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', color: '#6b7280' }}>
                            {dept.covers > 0 ? dept.covers : <span style={{ color: '#e5e7eb' }}>—</span>}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', color: '#6b7280' }}>
                            {dept.avg_spend > 0 ? fmtKr(dept.avg_spend) : <span style={{ color: '#e5e7eb' }}>—</span>}
                          </td>
                        </tr>
                      )
                    })}
                    {/* Totals row */}
                    <tr style={{ borderTop: '1.5px solid #e5e7eb', background: '#f9fafb' }}>
                      <td style={{ padding: '10px 14px', fontWeight: 700, color: '#111' }}>Total</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: '#111' }}>{fmtKr(summary.total_revenue ?? 0)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: '#111' }}>{fmtKr(summary.total_staff_cost ?? 0)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700,
                        color: summary.labour_pct == null ? '#9ca3af' : summary.labour_pct > 40 ? '#dc2626' : '#10b981' }}>
                        {fmtPct(summary.labour_pct)}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700,
                        color: summary.gp_pct == null ? '#9ca3af' : summary.gp_pct >= 60 ? '#10b981' : '#d97706' }}>
                        {fmtPct(summary.gp_pct)}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: '#111' }}>
                        {summary.rev_per_hour > 0 ? fmtKr(summary.rev_per_hour) : '—'}
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: '#111' }}>{fmtH(summary.total_hours ?? 0)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: '#111' }}>{summary.total_covers ?? 0}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', color: '#9ca3af' }}>—</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── Monthly breakdown ──────────────────────────────────────── */}
            {monthly.length > 1 && (
              <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ padding: '14px 20px', borderBottom: '0.5px solid #f3f4f6' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>Monthly breakdown</div>
                </div>
                <div className="table-scroll">
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: '#fafafa' }}>
                        <th style={{ textAlign: 'left', padding: '8px 16px', color: '#9ca3af', fontWeight: 600, fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '.06em', whiteSpace: 'nowrap' as const }}>Month</th>
                        {depts.map(d => {
                          const c = d.color ?? deptColor(d.name)
                          return (
                            <th key={d.name} style={{ textAlign: 'right', padding: '8px 12px', color: '#9ca3af', fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap' as const }}>
                              <span style={{ color: c }}>●</span> {d.name}
                            </th>
                          )
                        })}
                        <th style={{ textAlign: 'right', padding: '8px 16px', color: '#9ca3af', fontWeight: 600, fontSize: 11 }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthly.map((row: any) => {
                        const total = depts.reduce((s, d) => s + (row[d.name]?.revenue ?? 0), 0)
                        return (
                          <tr key={`${row.year}-${row.month}`} style={{ borderTop: '0.5px solid #f3f4f6' }}>
                            <td style={{ padding: '9px 16px', fontWeight: 600, color: '#111', whiteSpace: 'nowrap' as const }}>
                              {MONTHS_SHORT[row.month - 1]} {row.year}
                            </td>
                            {depts.map(d => {
                              const val = row[d.name]?.revenue ?? 0
                              return (
                                <td key={d.name} style={{ padding: '9px 12px', textAlign: 'right', color: val > 0 ? '#111' : '#e5e7eb' }}>
                                  {val > 0 ? fmtKr(val) : '—'}
                                </td>
                              )
                            })}
                            <td style={{ padding: '9px 16px', textAlign: 'right', fontWeight: 700, color: '#111' }}>
                              {total > 0 ? fmtKr(total) : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  )
}
