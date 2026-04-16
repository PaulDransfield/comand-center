'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'
import { deptColor, deptBg, KPI_CARD, CARD, BTN, CC_DARK, CC_PURPLE, CC_GREEN, CC_RED } from '@/lib/constants/colors'

const fmtKr  = (n: number) => Math.round(n).toLocaleString('sv-SE') + ' kr'
const fmtDay = (d: string) => new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

const PERIODS = ['Breakfast','Lunch','Dinner','Takeaway','Catering','Other']
const TABS    = ['Daily Revenue', 'Revenue Detail']

export default function RevenuePage() {
  const now = new Date()
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10)

  const [businesses,  setBusinesses]  = useState<any[]>([])
  const [selected,    setSelected]    = useState('')
  const [covers,      setCovers]      = useState<any[]>([])
  const [revDetail,   setRevDetail]   = useState<any>(null)
  const [loading,     setLoading]     = useState(true)
  const [tab,         setTab]         = useState('Daily Revenue')
  const [showForm,    setShowForm]    = useState(false)
  const [form,        setForm]        = useState<any>({ date: now.toISOString().slice(0,10), total: '', revenue: '', breakdown: {} })
  const [saving,      setSaving]      = useState(false)
  const [fromDate,    setFromDate]    = useState(defaultFrom)
  const [toDate,      setToDate]      = useState(now.toISOString().slice(0,10))

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
    const [coversRes, revRes] = await Promise.all([
      fetch(`/api/covers?business_id=${selected}&from=${fromDate}&to=${toDate}`),
      fetch(`/api/revenue-detail?business_id=${selected}&from=${fromDate}&to=${toDate}`),
    ])
    if (coversRes.ok) setCovers(await coversRes.json())
    if (revRes.ok)    setRevDetail(await revRes.json())
    setLoading(false)
  }, [selected, fromDate, toDate])

  useEffect(() => { if (selected) load() }, [selected])

  async function saveCovers() {
    setSaving(true)
    await fetch('/api/covers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, business_id: selected }),
    })
    setSaving(false)
    setShowForm(false)
    load()
  }

  // Covers stats
  const totalCovers = covers.reduce((s, c) => s + (c.total ?? 0), 0)
  const totalRev    = covers.reduce((s, c) => s + (c.revenue ?? 0), 0)
  const avgRpc      = totalCovers > 0 ? Math.round(totalRev / totalCovers) : 0
  const bestDay     = covers.reduce((best, c) => c.total > (best?.total ?? 0) ? c : best, null)
  const splitData: Record<string, number> = {}
  PERIODS.forEach(p => { splitData[p] = covers.reduce((s, c) => s + ((c.breakdown ?? {})[p.toLowerCase()] ?? 0), 0) })

  // Revenue detail stats
  const rev = revDetail?.summary ?? {}

  return (
    <AppShell>
      <div style={{ padding: '28px', maxWidth: 1000, width: '100%' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: '#111' }}>Revenue</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Daily revenue, covers, and breakdown from all sources</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={selected} onChange={e => { setSelected(e.target.value); localStorage.setItem('cc_selected_biz', e.target.value) }}
              style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: 'white' }}>
              {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
            <button onClick={load}
              style={{ padding: '8px 14px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>
              Load
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', background: '#f3f4f6', borderRadius: 12, padding: 3, marginBottom: 20, width: 'fit-content', gap: 2 }}>
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)}
              style={{ padding: '7px 18px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer',
                background: tab === t ? 'white' : 'transparent',
                color: tab === t ? '#111' : '#6b7280',
                boxShadow: tab === t ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>
              {t}
            </button>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
        ) : tab === 'Daily Revenue' ? (
          <>
            {/* KPI cards */}
            <div className="grid-4" style={{ marginBottom: 20 }}>
              {[
                { label: 'Total covers',    value: totalCovers.toString(),  sub: `${covers.length} days logged` },
                { label: 'Total revenue',   value: fmtKr(totalRev),         sub: 'From covers data' },
                { label: 'Avg per cover',   value: fmtKr(avgRpc),           sub: 'Revenue per guest' },
                { label: 'Best day',        value: bestDay ? bestDay.total.toString() : '--', sub: bestDay ? fmtDay(bestDay.date) : 'No data' },
              ].map(k => (
                <div key={k.label} style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 18px' }}>
                  <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 8 }}>{k.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 600, color: '#111', marginBottom: 3 }}>{k.value}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{k.sub}</div>
                </div>
              ))}
            </div>

            {/* Period breakdown */}
            {Object.values(splitData).some(v => v > 0) && (
              <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 20px', marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 14 }}>Covers by period</div>
                <div style={{ display: 'flex', gap: 20 }}>
                  {PERIODS.filter(p => splitData[p] > 0).map(p => (
                    <div key={p} style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 20, fontWeight: 700, color: '#111' }}>{splitData[p]}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{p}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Add covers button */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
              <button onClick={() => setShowForm(!showForm)}
                style={{ padding: '8px 16px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                + Log covers
              </button>
            </div>

            {/* Add form */}
            {showForm && (
              <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '20px', marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#111', marginBottom: 16 }}>Log covers</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Date</label>
                    <input type="date" value={form.date} onChange={e => setForm((f: any) => ({ ...f, date: e.target.value }))}
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' as const }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Total covers</label>
                    <input type="number" value={form.total} onChange={e => setForm((f: any) => ({ ...f, total: e.target.value }))} placeholder="0"
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' as const }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Revenue (kr)</label>
                    <input type="number" value={form.revenue} onChange={e => setForm((f: any) => ({ ...f, revenue: e.target.value }))} placeholder="0"
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' as const }} />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 8, marginBottom: 16 }}>
                  {PERIODS.map(p => (
                    <div key={p}>
                      <label style={{ fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 4 }}>{p}</label>
                      <input type="number" placeholder="0"
                        value={((form.breakdown ?? {}) as any)[p.toLowerCase()] ?? ''}
                        onChange={e => setForm((f: any) => ({ ...f, breakdown: { ...(f.breakdown ?? {}), [p.toLowerCase()]: parseInt(e.target.value) || 0 } }))}
                        style={{ width: '100%', padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, boxSizing: 'border-box' as const }} />
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={saveCovers} disabled={saving}
                    style={{ padding: '9px 20px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                    {saving ? 'Saving...' : 'Save covers'}
                  </button>
                  <button onClick={() => setShowForm(false)}
                    style={{ padding: '9px 14px', background: '#f3f4f6', border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer', color: '#374151' }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Covers table */}
            <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#fafafa' }}>
                    {['Date','Covers','Revenue','Per cover','Source'].map(h => (
                      <th key={h} style={{ textAlign: h === 'Date' ? 'left' : 'right', padding: '10px 16px', color: '#9ca3af', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {covers.length === 0 ? (
                    <tr><td colSpan={5} style={{ padding: '40px', textAlign: 'center', color: '#d1d5db', fontSize: 13 }}>
                      No covers data. Log covers manually or connect Personalkollen to sync automatically.
                    </td></tr>
                  ) : covers.map((c: any) => (
                    <tr key={c.id ?? c.date} style={{ borderTop: '0.5px solid #f3f4f6' }}>
                      <td style={{ padding: '10px 16px', fontWeight: 500, color: '#111' }}>{fmtDay(c.date)}</td>
                      <td style={{ padding: '10px 16px', textAlign: 'right', fontWeight: 700, color: '#111' }}>{c.total}</td>
                      <td style={{ padding: '10px 16px', textAlign: 'right', color: '#374151' }}>{c.revenue > 0 ? fmtKr(c.revenue) : '--'}</td>
                      <td style={{ padding: '10px 16px', textAlign: 'right', color: '#6b7280' }}>{c.revenue_per_cover > 0 ? fmtKr(c.revenue_per_cover) : '--'}</td>
                      <td style={{ padding: '10px 16px', textAlign: 'right' }}>
                        <span style={{ fontSize: 11, background: '#f3f4f6', color: '#6b7280', padding: '2px 7px', borderRadius: 4 }}>
                          {c.source ?? 'manual'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          /* Revenue Detail Tab */
          <>
            {/* Covers unavailable notice */}
            {rev.total_revenue > 0 && rev.total_covers === 0 && (
              <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 14px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                <span>⚠️</span>
                <span style={{ color: '#92400e' }}>
                  <strong>Covers not reported by your POS.</strong> Revenue-per-cover cannot be calculated. Contact your Inzii/Swess account manager to check if guest count tracking is enabled.
                </span>
              </div>
            )}
            {/* KPI cards */}
            <div className="grid-5" style={{ marginBottom: 20 }}>
              {[
                { label: 'Total revenue',   value: fmtKr(rev.total_revenue ?? 0),  sub: `${rev.days_with_data ?? 0} days`, color: '#111' },
                { label: 'Dine-in',         value: fmtKr(rev.total_dine_in ?? 0),  sub: rev.total_revenue > 0 ? Math.round((rev.total_dine_in / rev.total_revenue) * 100) + '%' : '—', color: '#1a1f2e' },
                { label: 'Takeaway',        value: fmtKr(rev.total_takeaway ?? 0), sub: rev.total_revenue > 0 ? Math.round((rev.total_takeaway / rev.total_revenue) * 100) + '%' : '—', color: '#6366f1' },
                { label: 'Food revenue',    value: fmtKr(rev.total_food_revenue ?? 0), sub: rev.total_revenue > 0 && rev.total_food_revenue > 0 ? Math.round(((rev.total_food_revenue ?? 0) / rev.total_revenue) * 100) + '% of sales' : '—', color: '#f59e0b' },
                { label: 'Avg per cover',   value: rev.avg_rpc > 0 ? fmtKr(rev.avg_rpc) : '—',  sub: rev.total_covers > 0 ? `${rev.total_covers} total covers` : 'Not reported by POS', color: rev.avg_rpc > 0 ? '#111' : '#9ca3af' },
              ].map(k => (
                <div key={k.label} style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '14px 16px' }}>
                  <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 8 }}>{k.label}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: k.color, marginBottom: 3 }}>{k.value}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{k.sub}</div>
                </div>
              ))}
            </div>

            {/* Channel split visuals */}
            {(rev.total_dine_in > 0 || rev.total_takeaway > 0 || (rev.total_food_revenue ?? 0) > 0 || (rev.total_bev_revenue ?? 0) > 0) && (
              <div style={{ display: 'grid', gridTemplateColumns: (rev.total_dine_in > 0 || rev.total_takeaway > 0) && ((rev.total_food_revenue ?? 0) > 0 || (rev.total_bev_revenue ?? 0) > 0) ? '1fr 1fr' : '1fr', gap: 12, marginBottom: 16 }}>

                {/* Dine-in vs takeaway */}
                {(rev.total_dine_in > 0 || rev.total_takeaway > 0) && (
                  <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 20px' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 12 }}>Dine-in vs takeaway</div>
                    <div style={{ display: 'flex', height: 16, borderRadius: 8, overflow: 'hidden', marginBottom: 10, background: '#f3f4f6' }}>
                      {rev.total_revenue > 0 && (
                        <>
                          {rev.total_dine_in > 0 && <div style={{ width: `${(rev.total_dine_in / rev.total_revenue) * 100}%`, background: '#1a1f2e' }} />}
                          {rev.total_takeaway > 0 && <div style={{ width: `${(rev.total_takeaway / rev.total_revenue) * 100}%`, background: '#6366f1' }} />}
                        </>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 20, fontSize: 12 }}>
                      {[
                        { color: '#1a1f2e', label: 'Dine-in',  value: fmtKr(rev.total_dine_in ?? 0),  pct: rev.total_revenue > 0 ? Math.round((rev.total_dine_in / rev.total_revenue) * 100) : 0 },
                        { color: '#6366f1', label: 'Takeaway', value: fmtKr(rev.total_takeaway ?? 0), pct: rev.total_revenue > 0 ? Math.round((rev.total_takeaway / rev.total_revenue) * 100) : 0 },
                        { color: '#10b981', label: 'Tips',     value: fmtKr(rev.total_tips ?? 0),     pct: null },
                      ].map(l => (
                        <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ width: 10, height: 10, borderRadius: 2, background: l.color }} />
                          <span style={{ color: '#6b7280' }}>{l.label}</span>
                          <span style={{ fontWeight: 600, color: '#111' }}>{l.value}</span>
                          {l.pct !== null && l.pct > 0 && <span style={{ color: '#9ca3af' }}>({l.pct}%)</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Food vs Beverage */}
                {((rev.total_food_revenue ?? 0) > 0 || (rev.total_bev_revenue ?? 0) > 0) && (
                  <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '16px 20px' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 12 }}>Food vs beverage</div>
                    <div style={{ display: 'flex', height: 16, borderRadius: 8, overflow: 'hidden', marginBottom: 10, background: '#f3f4f6' }}>
                      {rev.total_revenue > 0 && (
                        <>
                          {(rev.total_food_revenue ?? 0) > 0 && <div style={{ width: `${((rev.total_food_revenue ?? 0) / rev.total_revenue) * 100}%`, background: '#f59e0b' }} />}
                          {(rev.total_bev_revenue  ?? 0) > 0 && <div style={{ width: `${((rev.total_bev_revenue  ?? 0) / rev.total_revenue) * 100}%`, background: '#10b981' }} />}
                        </>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 20, fontSize: 12 }}>
                      {[
                        { color: '#f59e0b', label: 'Food',     value: fmtKr(rev.total_food_revenue ?? 0), pct: rev.total_revenue > 0 ? Math.round(((rev.total_food_revenue ?? 0) / rev.total_revenue) * 100) : 0 },
                        { color: '#10b981', label: 'Beverage', value: fmtKr(rev.total_bev_revenue  ?? 0), pct: rev.total_revenue > 0 ? Math.round(((rev.total_bev_revenue  ?? 0) / rev.total_revenue) * 100) : 0 },
                      ].map(l => (
                        <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ width: 10, height: 10, borderRadius: 2, background: l.color }} />
                          <span style={{ color: '#6b7280' }}>{l.label}</span>
                          <span style={{ fontWeight: 600, color: '#111' }}>{l.value}</span>
                          {l.pct > 0 && <span style={{ color: '#9ca3af' }}>({l.pct}%)</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Daily breakdown table */}
            <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px', borderBottom: '0.5px solid #f3f4f6' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>Daily revenue breakdown</div>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#fafafa' }}>
                    {['Date','Revenue','Dine-in','Takeaway','Tips','Covers','Per cover','Source'].map(h => (
                      <th key={h} style={{ textAlign: h === 'Date' ? 'left' : 'right', padding: '9px 12px', color: '#9ca3af', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {!revDetail?.rows?.length ? (
                    <tr><td colSpan={8} style={{ padding: '40px', textAlign: 'center', color: '#d1d5db', fontSize: 13 }}>
                      No revenue data. Connect Personalkollen, Ancon or Swess to sync POS data automatically.
                    </td></tr>
                  ) : revDetail.rows.map((r: any) => (
                    <tr key={r.date} style={{ borderTop: '0.5px solid #f3f4f6', background: r.is_closed ? '#fafafa' : 'white' }}>
                      <td style={{ padding: '9px 12px', fontWeight: 500, color: r.is_closed ? '#9ca3af' : '#111', whiteSpace: 'nowrap' }}>
                        {fmtDay(r.date)}
                        {r.is_closed && <span style={{ marginLeft: 6, fontSize: 10, color: '#d1d5db', background: '#f3f4f6', padding: '1px 5px', borderRadius: 3 }}>{r.is_future ? 'no data' : 'no revenue'}</span>}
                      </td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', fontWeight: 700, color: r.is_closed ? '#d1d5db' : '#111' }}>
                        {r.revenue > 0 ? fmtKr(r.revenue) : '—'}
                      </td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: r.dine_in_revenue > 0 ? '#1a1f2e' : '#d1d5db' }}>
                        {r.dine_in_revenue > 0 ? fmtKr(r.dine_in_revenue) : '—'}
                      </td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: r.takeaway_revenue > 0 ? '#6366f1' : '#d1d5db' }}>
                        {r.takeaway_revenue > 0 ? fmtKr(r.takeaway_revenue) : '—'}
                        {r.takeaway_pct > 0 && <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 4 }}>{r.takeaway_pct}%</span>}
                      </td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: r.tip_revenue > 0 ? '#10b981' : '#d1d5db' }}>
                        {r.tip_revenue > 0 ? fmtKr(r.tip_revenue) : '—'}
                      </td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: '#374151' }}>
                        {r.covers > 0 ? r.covers : '—'}
                      </td>
                      <td style={{ padding: '9px 12px', textAlign: 'right', color: '#6b7280' }}>
                        {r.revenue_per_cover > 0 ? fmtKr(r.revenue_per_cover) : '—'}
                      </td>
                      <td style={{ padding: '9px 12px', textAlign: 'right' }}>
                        {r.is_closed
                          ? <span style={{ fontSize: 10, color: '#d1d5db' }}>—</span>
                          : <span style={{ fontSize: 10, background: '#f3f4f6', color: '#6b7280', padding: '2px 6px', borderRadius: 3 }}>
                              {r.providers?.length ? r.providers.join(', ') : 'manual'}
                            </span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* AI panel — sees the current revenue data */}
      <AskAI
        page="revenue"
        context={[
          `Period: ${fromDate} to ${toDate}`,
          `Total covers: ${totalCovers}`,
          `Total revenue: ${fmtKr(totalRev)}`,
          `Average per cover: ${fmtKr(avgRpc)}`,
          `Best day: ${bestDay ? fmtDay(bestDay.date) + ' with ' + bestDay.total + ' covers' : 'No data'}`,
          tab === 'Daily Revenue' 
            ? `Covers by period: ${PERIODS.filter(p => splitData[p] > 0).map(p => `${p}: ${splitData[p]}`).join(', ')}`
            : `Revenue breakdown: Dine-in ${fmtKr(rev.total_dine_in ?? 0)}, Takeaway ${fmtKr(rev.total_takeaway ?? 0)}, Tips ${fmtKr(rev.total_tips ?? 0)}`,
          revDetail?.rows?.length > 0 ? `Daily data: ${revDetail.rows.length} days with revenue` : 'No daily revenue data',
        ].filter(Boolean).join('\n')}
      />
    </AppShell>
  )
}
