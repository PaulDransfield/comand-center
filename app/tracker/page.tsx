'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'
import { deptColor, deptBg, KPI_CARD, CARD, BTN, CC_DARK, CC_PURPLE, CC_GREEN, CC_RED } from '@/lib/constants/colors'

interface Business { id: string; name: string; city: string | null }
interface TrackerRow {
  id?: string; period_month: number; period_year: number
  revenue: number; food_cost: number; staff_cost: number
  net_profit: number; margin_pct: number
}
interface DailyRow {
  date: string; total: number; revenue: number; revenue_per_cover: number
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const fmtKr  = (n: number) => Math.round(n).toLocaleString('en-SE') + ' kr'
const fmtPct = (n: number) => n.toFixed(1) + '%'

export default function TrackerPage() {
  const now = new Date()
  const [businesses,   setBusinesses]   = useState<Business[]>([])
  const [selected,     setSelected]     = useState('')
  const [year,         setYear]         = useState(now.getFullYear())
  const [rows,         setRows]         = useState<TrackerRow[]>([])
  const [editing,      setEditing]      = useState<number | null>(null)
  const [form,         setForm]         = useState<Partial<TrackerRow>>({})
  const [loading,      setLoading]      = useState(true)
  const [saving,       setSaving]       = useState(false)
  const [expanded,     setExpanded]     = useState<number | null>(null)
  const [dailyData,    setDailyData]    = useState<Record<number, DailyRow[]>>({})
  const [loadingDaily, setLoadingDaily] = useState<number | null>(null)

  useEffect(() => {
    fetch('/api/businesses').then(r => r.json()).then((data: any[]) => {
      if (!Array.isArray(data) || !data.length) return
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
    if (!selected) return
    setLoading(true)
    const res  = await fetch(`/api/tracker?business_id=${selected}&year=${year}`)
    const data = await res.json()
    if (Array.isArray(data)) setRows(data)
    setLoading(false)
  }, [selected, year])

  useEffect(() => { if (selected) load() }, [selected])

  async function save() {
    if (!form.period_month) return
    setSaving(true)
    await fetch('/api/tracker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, business_id: selected, period_year: year }),
    })
    setSaving(false)
    setEditing(null)
    load()
  }

  async function toggleExpand(month: number) {
    if (expanded === month) {
      setExpanded(null)
      return
    }
    setExpanded(month)

    // Load daily covers/revenue data if not already loaded
    if (!dailyData[month]) {
      setLoadingDaily(month)
      const fromDate = `${year}-${String(month).padStart(2,'0')}-01`
      const lastDay  = new Date(year, month, 0).getDate()
      const toDate   = `${year}-${String(month).padStart(2,'0')}-${lastDay}`
      try {
        // Try revenue-detail first (has POS data), fall back to covers
        const res  = await fetch(`/api/revenue-detail?business_id=${selected}&from=${fromDate}&to=${toDate}`)
        const data = await res.json()
        if (data.rows) {
          // Map revenue-detail format to covers format
          const mapped = data.rows.map((r: any) => ({
            date:              r.date,
            total:             r.covers ?? 0,
            revenue:           r.revenue ?? 0,
            revenue_per_cover: r.revenue_per_cover ?? 0,
            is_closed:         r.is_closed,
          }))
          setDailyData(prev => ({ ...prev, [month]: mapped }))
        } else if (Array.isArray(data)) {
          setDailyData(prev => ({ ...prev, [month]: data }))
        }
      } catch {}
      setLoadingDaily(null)
    }
  }

  const totRev    = rows.reduce((s, r) => s + Number(r.revenue ?? 0), 0)
  const totProfit = rows.reduce((s, r) => s + Number(r.net_profit ?? 0), 0)
  const avgMargin = rows.length ? rows.reduce((s, r) => s + Number(r.margin_pct ?? 0), 0) / rows.length : 0
  const best      = rows.length ? rows.reduce((a, b) => Number(a.revenue) > Number(b.revenue) ? a : b) : null

  const allMonths = Array.from({ length: 12 }, (_, i) => {
    const existing = rows.find(r => r.period_month === i + 1)
    return existing ?? { period_month: i + 1, period_year: year, revenue: 0, food_cost: 0, staff_cost: 0, net_profit: 0, margin_pct: 0 }
  })

  return (
    <AppShell>
      <div style={{ padding: '28px', maxWidth: 1000 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: '#111' }}>P&L Tracker</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Monthly profit & loss · click a month to see daily breakdown</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={selected} onChange={e => setSelected(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: 'white' }}>
              {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <select value={year} onChange={e => setYear(parseInt(e.target.value))}
              style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: 'white' }}>
              {[2024,2025,2026,2027].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>

        {/* KPIs */}
        <div className="grid-4" style={{ marginBottom: 20 }}>
          {[
            { label: 'YTD Revenue',    value: fmtKr(totRev),    sub: `${rows.length} months` },
            { label: 'YTD Profit',     value: fmtKr(totProfit), sub: fmtPct(avgMargin) + ' avg margin' },
            { label: 'Best month',     value: best ? MONTHS_SHORT[(best.period_month??1)-1] : '--', sub: best ? fmtKr(Number(best.revenue)) : '' },
            { label: 'Months entered', value: `${rows.length} / 12`, sub: 'Click any month row to expand' },
          ].map(k => (
            <div key={k.label} style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 18px' }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 6 }}>{k.label}</div>
              <div style={{ fontSize: 20, fontWeight: 600, color: '#111' }}>{k.value}</div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>{k.sub}</div>
            </div>
          ))}
        </div>

        {/* Table */}
        <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <div className="table-scroll">
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 600 }}>
            <thead>
              <tr style={{ background: '#fafafa', borderBottom: '1px solid #e5e7eb' }}>
                {['','Month','Revenue','Food %','Staff %','Net profit','Margin',''].map((h,i) => (
                  <th key={i} className={i === 3 || i === 4 ? 'hide-mobile' : ''}
                    style={{ textAlign: i === 0 ? 'center' : i === 7 ? 'center' : 'left', padding: '10px 12px', fontSize: 11, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.06em', width: i === 0 ? 32 : 'auto' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {allMonths.map((row, i) => {
                const hasData  = rows.some(r => r.period_month === row.period_month)
                const isEdit   = editing === row.period_month
                const isExpanded = expanded === row.period_month
                const foodPct  = Number(row.revenue) > 0 ? (Number(row.food_cost)  / Number(row.revenue)) * 100 : 0
                const staffPct = Number(row.revenue) > 0 ? (Number(row.staff_cost) / Number(row.revenue)) * 100 : 0
                const daily    = dailyData[row.period_month] ?? []

                return (
                  <>
                    {/* Edit row */}
                    {isEdit ? (
                      <tr key={`edit-${i}`} style={{ background: 'white', borderBottom: '1px solid #e5e7eb' }}>
                        <td />
                        <td style={{ padding: '10px 12px', fontWeight: 600 }}>{MONTHS_SHORT[row.period_month - 1]}</td>
                        {(['revenue','food_cost','staff_cost'] as const).map(field => (
                          <td key={field} style={{ padding: '6px 8px' }}>
                            <input type="number" placeholder="0"
                              value={(form as any)[field] ?? ''}
                              onChange={e => setForm(f => ({ ...f, [field]: parseFloat(e.target.value) || 0 }))}
                              style={{ width: '100%', padding: '6px 10px', border: '1px solid #6366f1', borderRadius: 6, fontSize: 13 }} />
                          </td>
                        ))}
                        <td colSpan={2} />
                        <td style={{ padding: '6px 10px', textAlign: 'center' }}>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                            <button onClick={save} disabled={saving}
                              style={{ padding: '5px 12px', background: '#6366f1', color: 'white', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
                              {saving ? '...' : 'Save'}
                            </button>
                            <button onClick={() => setEditing(null)}
                              style={{ padding: '5px 10px', background: '#f3f4f6', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
                              Cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      /* Month row */
                      <tr key={`row-${i}`}
                        onClick={() => hasData && toggleExpand(row.period_month)}
                        style={{ borderBottom: isExpanded ? 'none' : '0.5px solid #f3f4f6', opacity: hasData ? 1 : 0.5, cursor: hasData ? 'pointer' : 'default', background: isExpanded ? '#fafbff' : 'white' }}>
                        <td style={{ padding: '11px 12px', textAlign: 'center', fontSize: 11, color: '#9ca3af' }}>
                          {hasData ? (isExpanded ? '▼' : '▶') : ''}
                        </td>
                        <td style={{ padding: '11px 12px', fontWeight: 600, color: '#111' }}>{MONTHS_SHORT[row.period_month - 1]}</td>
                        <td style={{ padding: '11px 12px', color: hasData ? '#111' : '#d1d5db' }}>{hasData ? fmtKr(Number(row.revenue)) : '--'}</td>
                        <td style={{ padding: '11px 12px' }}>
                          {hasData ? (
                            <span style={{ color: foodPct > 31 ? '#dc2626' : '#15803d', fontWeight: 500 }}>{fmtPct(foodPct)}</span>
                          ) : '--'}
                        </td>
                        <td style={{ padding: '11px 12px' }}>
                          {hasData ? (
                            <span style={{ color: staffPct > 40 ? '#dc2626' : '#15803d', fontWeight: 500 }}>{fmtPct(staffPct)}</span>
                          ) : '--'}
                        </td>
                        <td style={{ padding: '11px 12px', fontWeight: 600, color: '#111' }}>{hasData ? fmtKr(Number(row.net_profit)) : '--'}</td>
                        <td style={{ padding: '11px 12px' }}>
                          {hasData ? (
                            <span style={{ background: Number(row.margin_pct) >= 12 ? '#f0fdf4' : '#fef3c7', color: Number(row.margin_pct) >= 12 ? '#15803d' : '#d97706', padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>
                              {fmtPct(Number(row.margin_pct))}
                            </span>
                          ) : '--'}
                        </td>
                        <td style={{ padding: '11px 12px', textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                          <button onClick={() => { setEditing(row.period_month); setForm({ period_month: row.period_month, revenue: Number(row.revenue), food_cost: Number(row.food_cost), staff_cost: Number(row.staff_cost) }) }}
                            style={{ padding: '4px 12px', background: '#f3f4f6', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer', color: '#374151' }}>
                            {hasData ? 'Edit' : '+ Add'}
                          </button>
                        </td>
                      </tr>
                    )}

                    {/* Daily breakdown */}
                    {isExpanded && !isEdit && (
                      <tr key={`daily-${i}`}>
                        <td colSpan={8} style={{ padding: 0, background: 'white', borderBottom: '1px solid #e5e7eb' }}>
                          <div style={{ padding: '0 16px 12px 48px' }}>
                            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', padding: '10px 0 8px' }}>
                              Daily breakdown — {MONTHS[row.period_month - 1]} {year}
                            </div>
                            {loadingDaily === row.period_month ? (
                              <div style={{ fontSize: 12, color: '#9ca3af', padding: '8px 0' }}>Loading daily data...</div>
                            ) : daily.length === 0 ? (
                              <div style={{ fontSize: 12, color: '#d1d5db', padding: '8px 0' }}>
                                No daily covers data for this month. Log covers daily to see the breakdown.
                                <a href="/covers" style={{ color: '#6366f1', marginLeft: 6 }}>Log covers →</a>
                              </div>
                            ) : (
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                <thead>
                                  <tr style={{ borderBottom: '0.5px solid #e5e7eb' }}>
                                    {['Date','Covers','Revenue','Rev / cover'].map(h => (
                                      <th key={h} style={{ textAlign: 'left', padding: '4px 10px', color: '#9ca3af', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {daily.map((d: DailyRow) => (
                                    <tr key={d.date} style={{ borderBottom: '0.5px solid #f3f4f6', background: (d as any).is_closed ? '#fafafa' : 'white' }}>
                                      <td style={{ padding: '6px 10px', fontWeight: 500, color: (d as any).is_closed ? '#9ca3af' : '#374151' }}>
                                        {new Date(d.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                                        {(d as any).is_closed && <span style={{ marginLeft: 6, fontSize: 10, color: '#d1d5db' }}>{(d as any).is_future ? 'no data' : 'no revenue'}</span>}
                                      </td>
                                      <td style={{ padding: '6px 10px', color: (d as any).is_closed ? '#d1d5db' : '#374151' }}>{d.total > 0 ? d.total : '—'}</td>
                                      <td style={{ padding: '6px 10px', color: d.revenue > 0 ? '#111' : '#d1d5db', fontWeight: d.revenue > 0 ? 600 : 400 }}>{d.revenue > 0 ? fmtKr(d.revenue) : '—'}</td>
                                      <td style={{ padding: '6px 10px', color: d.revenue_per_cover > 0 ? '#374151' : '#d1d5db' }}>{d.revenue_per_cover > 0 ? fmtKr(d.revenue_per_cover) : '—'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                                <tfoot>
                                  <tr style={{ borderTop: '1px solid #e5e7eb', background: '#f3f4f6' }}>
                                    <td style={{ padding: '7px 10px', fontWeight: 600, color: '#111', fontSize: 12 }}>Total</td>
                                    <td style={{ padding: '7px 10px', fontWeight: 600, color: '#111' }}>{daily.reduce((s: number, d: DailyRow) => s + d.total, 0)}</td>
                                    <td style={{ padding: '7px 10px', fontWeight: 600, color: '#111' }}>{fmtKr(daily.reduce((s: number, d: DailyRow) => s + d.revenue, 0))}</td>
                                    <td style={{ padding: '7px 10px', color: '#9ca3af' }}>
                                      {(() => {
                                        const totCovers = daily.reduce((s: number, d: DailyRow) => s + d.total, 0)
                                        const totRev    = daily.reduce((s: number, d: DailyRow) => s + d.revenue, 0)
                                        return totCovers > 0 ? fmtKr(Math.round(totRev / totCovers)) : '--'
                                      })()}
                                    </td>
                                  </tr>
                                </tfoot>
                              </table>
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
          </div>
        </div>
      </div>

      {/* AI panel — sees the full year P&L table */}
      <AskAI
        page="tracker"
        context={rows.length > 0 ? [
          `Year: ${year}`,
          `Monthly P&L:`,
          ...rows.map((r: TrackerRow) =>
            `  ${MONTHS[r.period_month - 1]}: Revenue ${fmtKr(r.revenue)}, Food cost ${fmtKr(r.food_cost)} (${fmtPct(r.revenue > 0 ? r.food_cost/r.revenue*100 : 0)}), Staff cost ${fmtKr(r.staff_cost)} (${fmtPct(r.revenue > 0 ? r.staff_cost/r.revenue*100 : 0)}), Net profit ${fmtKr(r.net_profit)}, Margin ${fmtPct(r.margin_pct)}`
          ),
          `YTD totals: Revenue ${fmtKr(rows.reduce((s,r) => s+r.revenue,0))}, Net profit ${fmtKr(rows.reduce((s,r) => s+r.net_profit,0))}, Avg margin ${fmtPct(rows.reduce((s,r) => s+r.margin_pct,0)/rows.length)}`,
        ].join('\n') : 'No P&L data entered yet'}
      />
    </AppShell>
  )
}