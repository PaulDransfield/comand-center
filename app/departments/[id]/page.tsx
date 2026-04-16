'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { deptColor } from '@/lib/constants/colors'

const fmtKr  = (n: number) => Math.round(n).toLocaleString('sv-SE') + ' kr'
const fmtPct = (n: number | null) => n != null ? n.toFixed(1) + '%' : '—'
const fmtH   = (n: number) => (Math.round(n * 10) / 10).toLocaleString('sv-SE') + 'h'

function monthStart() {
  const d = new Date()
  // Default to 3 months of data for a meaningful trend
  const from = new Date(d.getFullYear(), d.getMonth() - 2, 1)
  return from.toISOString().slice(0, 10)
}
function today() { return new Date().toISOString().slice(0, 10) }

export default function DepartmentDetailPage() {
  const params       = useParams()
  const router       = useRouter()
  const searchParams = useSearchParams()

  const deptName   = decodeURIComponent(params.id as string)
  const bizFromUrl = searchParams.get('business_id') ?? ''

  const [data,        setData]        = useState<any>(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')
  const [from,        setFrom]        = useState(monthStart())
  const [to,          setTo]          = useState(today())
  const [selectedBiz, setSelectedBiz] = useState(bizFromUrl)

  // Sync with sidebar business switcher
  useEffect(() => {
    const sync = () => {
      const saved = localStorage.getItem('cc_selected_biz')
      if (saved && !bizFromUrl) setSelectedBiz(saved)
    }
    if (!bizFromUrl) sync()
    window.addEventListener('storage', sync)
    window.addEventListener('cc_biz_change', sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener('cc_biz_change', sync)
    }
  }, [bizFromUrl])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const biz = selectedBiz ? `&business_id=${selectedBiz}` : ''
      const res  = await fetch(`/api/departments/${encodeURIComponent(deptName)}?from=${from}&to=${to}${biz}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load')
      setData(json)
    } catch (e: any) { setError(e.message) }
    setLoading(false)
  }, [deptName, from, to, selectedBiz])

  useEffect(() => { load() }, [load])

  const summary   = data?.summary ?? {}
  const trend     = data?.trend   ?? []
  const staff     = data?.staff   ?? []
  const deptColor_ = data?.color  ?? deptColor(deptName)

  // Revenue trend chart — max for scaling
  const trendMax = Math.max(...trend.map((t: any) => t.revenue), 1)
  // Only show days that have revenue (filter out zeros for cleaner chart)
  const trendWithData = trend.filter((t: any) => t.revenue > 0)

  // Labour % colour coding
  const labourColor = summary.labour_pct == null ? '#9ca3af'
    : summary.labour_pct > 40 ? '#dc2626'
    : summary.labour_pct > 30 ? '#d97706'
    : '#10b981'

  const gpColor = summary.gp_pct == null ? '#9ca3af'
    : summary.gp_pct >= 60 ? '#10b981'
    : summary.gp_pct >= 40 ? '#d97706'
    : '#dc2626'

  return (
    <AppShell>
      <div className="page-wrap" style={{ maxWidth: 1000 }}>

        {/* ── Breadcrumb + header ───────────────────────────────────────── */}
        <div style={{ marginBottom: 8 }}>
          <button onClick={() => router.push('/departments')}
            style={{ background: 'none', border: 'none', fontSize: 12, color: '#9ca3af', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
            ← Departments
          </button>
        </div>

        <div className="page-header" style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 14, height: 14, borderRadius: '50%', background: deptColor_, flexShrink: 0 }} />
            <div>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: '#111' }}>{deptName}</h1>
              <p style={{ margin: '3px 0 0', fontSize: 13, color: '#6b7280' }}>Revenue, labour cost and staff detail</p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
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

        {summary.payroll_pending && (
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 12,
            padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#92400e', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>⚠</span> Payroll not yet approved — showing estimated salary. Numbers will update after approval.
          </div>
        )}

        {loading ? (
          <div style={{ padding: 80, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading {deptName}...</div>
        ) : (
          <>
            {/* ── KPI cards ────────────────────────────────────────────── */}
            <div className="grid-4" style={{ marginBottom: 20 }}>
              {[
                {
                  label: 'Revenue',
                  value: summary.revenue > 0 ? fmtKr(summary.revenue) : '—',
                  sub:   summary.covers > 0 ? `${summary.covers} covers · ${fmtKr(summary.avg_spend)} avg` : 'No POS data',
                  accent: deptColor_,
                },
                {
                  label: 'Labour Cost',
                  value: summary.staff_cost > 0 ? fmtKr(summary.staff_cost) : '—',
                  sub:   fmtH(summary.hours ?? 0) + ' · ' + (summary.shifts ?? 0) + ' shifts',
                  accent: null,
                },
                {
                  label: 'Labour %',
                  value: fmtPct(summary.labour_pct),
                  sub:   'of revenue',
                  accent: labourColor,
                  valueColor: labourColor,
                },
                {
                  label: 'GP%',
                  value: fmtPct(summary.gp_pct),
                  sub:   summary.rev_per_hour > 0 ? `${fmtKr(summary.rev_per_hour)} / hour` : 'No revenue data',
                  accent: gpColor,
                  valueColor: gpColor,
                },
              ].map(k => (
                <div key={k.label} style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '14px 16px',
                  borderTop: k.accent ? `3px solid ${k.accent}` : '0.5px solid #e5e7eb' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 6 }}>{k.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 2, color: (k as any).valueColor ?? '#111' }}>{k.value}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{k.sub}</div>
                </div>
              ))}
            </div>

            {/* ── Secondary KPIs row ────────────────────────────────────── */}
            {(summary.ob_supplement > 0 || summary.late_shifts > 0) && (
              <div className="grid-2" style={{ marginBottom: 20 }}>
                {summary.ob_supplement > 0 && (
                  <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '14px 16px' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 4 }}>OB Supplement</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#111', marginBottom: 6 }}>{fmtKr(summary.ob_supplement)}</div>
                    {summary.ob_type_breakdown?.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 4 }}>
                        {summary.ob_type_breakdown.map((ob: any) => (
                          <span key={ob.type} style={{ fontSize: 11, background: '#eff6ff', color: '#3b82f6', borderRadius: 4, padding: '2px 6px', fontWeight: 500 }}>
                            {ob.type}: {fmtKr(ob.kr)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {summary.late_shifts > 0 && (
                  <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '14px 16px' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 4 }}>Late Arrivals</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#d97706', marginBottom: 2 }}>
                      {summary.late_shifts} shift{summary.late_shifts !== 1 ? 's' : ''}
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>avg {summary.avg_late_minutes} min late</div>
                  </div>
                )}
              </div>
            )}

            {/* ── Revenue trend chart ───────────────────────────────────── */}
            {trendWithData.length > 0 && (
              <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '18px 20px', marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 16 }}>Daily revenue</div>
                <div className="chart-scroll">
                  <div className="chart-inner" style={{ minWidth: Math.max(trendWithData.length * 28, 460) }}>
                    {/* Bar chart */}
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120, paddingBottom: 4 }}>
                      {trendWithData.map((t: any) => {
                        const pct = (t.revenue / trendMax) * 100
                        const dateLabel = new Date(t.date).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' })
                        return (
                          <div key={t.date} style={{ flex: 1, minWidth: 20, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 2, height: '100%', justifyContent: 'flex-end' }}
                            title={`${dateLabel}: ${fmtKr(t.revenue)}${t.covers > 0 ? ` · ${t.covers} covers` : ''}`}>
                            <div style={{ width: '100%', background: deptColor_, borderRadius: '3px 3px 0 0', opacity: 0.85,
                              height: `${Math.max(pct, 2)}%`, transition: 'height 0.3s ease' }} />
                          </div>
                        )
                      })}
                    </div>
                    {/* Date labels — show every 7th day */}
                    <div style={{ display: 'flex', gap: 3, marginTop: 4 }}>
                      {trendWithData.map((t: any, i: number) => {
                        const show = i === 0 || i === trendWithData.length - 1 || i % 7 === 0
                        const d    = new Date(t.date)
                        return (
                          <div key={t.date} style={{ flex: 1, minWidth: 20, fontSize: 9, color: '#9ca3af', textAlign: 'center', whiteSpace: 'nowrap' as const }}>
                            {show ? `${d.getUTCDate()}/${d.getUTCMonth() + 1}` : ''}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Staff breakdown ───────────────────────────────────────── */}
            {staff.length > 0 && (
              <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ padding: '14px 20px', borderBottom: '0.5px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>Staff in {deptName}</div>
                  <div style={{ fontSize: 12, color: '#9ca3af' }}>{staff.length} people · {fmtH(summary.hours ?? 0)} total</div>
                </div>
                <div className="table-scroll">
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#fafafa' }}>
                        {['Name', 'Hours', 'Cost', 'Cost/h', 'Shifts', 'Late'].map(h => (
                          <th key={h} style={{ textAlign: h === 'Name' ? 'left' : 'right', padding: '9px 16px',
                            color: '#9ca3af', fontWeight: 600, fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '.06em', whiteSpace: 'nowrap' as const }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {staff.map((s: any) => {
                        // Cost share bar
                        const costShare = summary.staff_cost > 0 ? (s.cost / summary.staff_cost) * 100 : 0
                        return (
                          <tr key={s.name} style={{ borderTop: '0.5px solid #f3f4f6' }}>
                            <td style={{ padding: '10px 16px' }}>
                              <div style={{ fontWeight: 500, color: '#111', marginBottom: 3 }}>{s.name}</div>
                              {/* Cost share bar */}
                              <div style={{ height: 3, background: '#f3f4f6', borderRadius: 2, width: 80, overflow: 'hidden' }}>
                                <div style={{ height: '100%', background: deptColor_, borderRadius: 2, width: `${costShare}%` }} />
                              </div>
                            </td>
                            <td style={{ padding: '10px 16px', textAlign: 'right', color: '#374151' }}>{fmtH(s.hours)}</td>
                            <td style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 600, color: '#111' }}>{fmtKr(s.cost)}</td>
                            <td style={{ padding: '10px 16px', textAlign: 'right', color: '#6b7280' }}>
                              {s.cost_per_hour > 0 ? fmtKr(s.cost_per_hour) : '—'}
                            </td>
                            <td style={{ padding: '10px 16px', textAlign: 'right', color: '#6b7280' }}>{s.shifts}</td>
                            <td style={{ padding: '10px 16px', textAlign: 'right' }}>
                              {s.late_shifts > 0
                                ? <span style={{ color: '#d97706', fontSize: 12 }}>{s.late_shifts}× ({s.avg_late_minutes}m)</span>
                                : <span style={{ color: '#e5e7eb' }}>—</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Empty state */}
            {staff.length === 0 && trendWithData.length === 0 && (
              <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                No data for this department in the selected period.
              </div>
            )}
          </>
        )}
      </div>
    </AppShell>
  )
}
