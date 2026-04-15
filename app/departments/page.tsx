'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import { deptColor, deptBg, DEPT_COLORS, KPI_CARD, CC_DARK, CC_PURPLE } from '@/lib/constants/colors'

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const fmtKr = (n: number) => Math.round(n).toLocaleString('sv-SE') + ' kr'
const fmtH  = (n: number) => Math.round(n * 10) / 10 + 'h'

// deptColor() imported from @/lib/constants/colors
// deptColor imported from @/lib/constants/colors

export default function DepartmentsPage() {
  const now = new Date()
  const [data,      setData]      = useState<any>(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [year,      setYear]      = useState(now.getFullYear())
  const [view,      setView]      = useState<'cost'|'hours'>('cost')
  const [expanded,  setExpanded]  = useState<string|null>(null)
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
      const res  = await fetch(`/api/departments?year=${year}${bizParam}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      setData(json)
    } catch (e: any) { setError(e.message) }
    setLoading(false)
  }, [year, selectedBiz])

  useEffect(() => { load() }, [load])

  const depts: string[]     = data?.departments ?? []
  const monthly: any[]      = data?.monthly ?? []
  const totals: any         = data?.totals ?? {}
  const staffTotals: any[]  = data?.staff ?? []

  return (
    <AppShell>
      <div style={{ padding: '28px', maxWidth: 1100, width: '100%' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: '#111' }}>Departments</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Staff cost and hours by department · {year}</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ display: 'flex', background: '#f3f4f6', borderRadius: 8, padding: 3 }}>
              {(['cost','hours'] as const).map(v => (
                <button key={v} onClick={() => setView(v)}
                  style={{ padding: '6px 14px', borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    background: view === v ? 'white' : 'transparent',
                    color: view === v ? '#111' : '#9ca3af',
                    boxShadow: view === v ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>
                  {v === 'cost' ? 'Cost (kr)' : 'Hours'}
                </button>
              ))}
            </div>
            <select value={year} onChange={e => setYear(parseInt(e.target.value))}
              style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: 'white' }}>
              {[now.getFullYear()-1, now.getFullYear()].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>

        {error && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '14px 18px', marginBottom: 20, fontSize: 13, color: '#dc2626' }}>{error}</div>}

        {loading ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>Loading department data...</div>
        ) : !data || depts.length === 0 ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
            No staff data yet. Connect Personalkollen and run a sync to see department breakdowns.
          </div>
        ) : (
          <>
            {/* Department KPI cards */}
            <div className="grid-auto" style={{ marginBottom: 24 }}>
              {depts.map(dept => {
                const t = totals[dept] ?? { cost: 0, hours: 0, staff: 0 }
                return (
                  <div key={dept} onClick={() => setExpanded(expanded === dept ? null : dept)}
                    style={{ background: 'white', border: `1.5px solid ${expanded === dept ? deptColor(dept) : '#e5e7eb'}`, borderRadius: 12, padding: '14px 16px', cursor: 'pointer' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <div style={{ width: 10, height: 10, borderRadius: '50%', background: deptColor(dept), flexShrink: 0 }} />
                      <div style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{dept}</div>
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#111', marginBottom: 2 }}>
                      {view === 'cost' ? fmtKr(t.cost) : fmtH(t.hours)}
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{t.staff} staff · {fmtH(t.hours)}</div>
                  </div>
                )
              })}
            </div>

            {/* Monthly breakdown table */}
            <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', marginBottom: 20 }}>
              <div style={{ padding: '14px 20px', borderBottom: '0.5px solid #f3f4f6' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>Monthly breakdown by department</div>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#fafafa' }}>
                      <th style={{ textAlign: 'left', padding: '8px 16px', color: '#9ca3af', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap' }}>Month</th>
                      {depts.map(d => (
                        <th key={d} style={{ textAlign: 'right', padding: '8px 12px', color: '#9ca3af', fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap' }}>
                          <span style={{ color: deptColor(d) }}>●</span> {d}
                        </th>
                      ))}
                      <th style={{ textAlign: 'right', padding: '8px 16px', color: '#9ca3af', fontWeight: 600, fontSize: 11 }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthly.map((row: any) => {
                      const total = depts.reduce((s, d) => s + (view === 'cost' ? (row[d]?.cost ?? 0) : (row[d]?.hours ?? 0)), 0)
                      return (
                        <tr key={row.month} style={{ borderTop: '0.5px solid #f3f4f6' }}>
                          <td style={{ padding: '9px 16px', fontWeight: 600, color: '#111', whiteSpace: 'nowrap' }}>
                            {MONTHS_SHORT[row.month - 1]} {row.year}
                          </td>
                          {depts.map(d => {
                            const val = view === 'cost' ? (row[d]?.cost ?? 0) : (row[d]?.hours ?? 0)
                            return (
                              <td key={d} style={{ padding: '9px 12px', textAlign: 'right', color: val > 0 ? '#111' : '#e5e7eb' }}>
                                {val > 0 ? (view === 'cost' ? fmtKr(val) : fmtH(val)) : '—'}
                              </td>
                            )
                          })}
                          <td style={{ padding: '9px 16px', textAlign: 'right', fontWeight: 700, color: '#111' }}>
                            {view === 'cost' ? fmtKr(total) : fmtH(total)}
                          </td>
                        </tr>
                      )
                    })}
                    {/* Totals row */}
                    <tr style={{ borderTop: '1.5px solid #e5e7eb', background: '#f9fafb' }}>
                      <td style={{ padding: '10px 16px', fontWeight: 700, color: '#111' }}>Total</td>
                      {depts.map(d => {
                        const t = totals[d] ?? { cost: 0, hours: 0 }
                        return (
                          <td key={d} style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: deptColor(d) }}>
                            {view === 'cost' ? fmtKr(t.cost) : fmtH(t.hours)}
                          </td>
                        )
                      })}
                      <td style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 700, color: '#111' }}>
                        {view === 'cost'
                          ? fmtKr(depts.reduce((s,d) => s + (totals[d]?.cost ?? 0), 0))
                          : fmtH(depts.reduce((s,d) => s + (totals[d]?.hours ?? 0), 0))}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* Staff detail for selected department */}
            {expanded && (
              <div style={{ background: 'white', border: `1.5px solid ${deptColor(expanded)}`, borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ padding: '14px 20px', borderBottom: '0.5px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>
                    <span style={{ color: deptColor(expanded) }}>●</span> {expanded} — staff detail
                  </div>
                  <button onClick={() => setExpanded(null)} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#9ca3af' }}>×</button>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#fafafa' }}>
                      {['Name','Hours','Cost','Cost/h','Shifts'].map(h => (
                        <th key={h} style={{ textAlign: h === 'Name' ? 'left' : 'right', padding: '9px 16px', color: '#9ca3af', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(staffTotals.filter((s: any) => s.group === expanded) ?? [])
                      .sort((a: any, b: any) => b.cost - a.cost)
                      .map((s: any) => (
                        <tr key={s.name} style={{ borderTop: '0.5px solid #f3f4f6' }}>
                          <td style={{ padding: '10px 16px', fontWeight: 500, color: '#111' }}>{s.name}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', color: '#374151' }}>{fmtH(s.hours)}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 600, color: '#111' }}>{fmtKr(s.cost)}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', color: '#6b7280' }}>{s.hours > 0 ? fmtKr(Math.round(s.cost / s.hours)) : '—'}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', color: '#6b7280' }}>{s.shifts}</td>
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
