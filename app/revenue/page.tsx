'use client'
// @ts-nocheck
// app/revenue/page.tsx — Revenue, covers, food/bev split
// Same W/M navigator pattern as dashboard

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'

const fmtKr  = (n: number) => Math.round(n).toLocaleString('en-GB') + ' kr'
const fmtPct = (n: number) => (Math.round(n * 10) / 10).toFixed(1) + '%'
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const DAYS   = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']

// ── Period helpers ────────────────────────────────────────────────────────────
function getISOWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day  = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const y1   = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - y1.getTime()) / 86400000 + 1) / 7)
}

function getWeekBounds(offset = 0) {
  const today = new Date(), dow = today.getDay()
  const mon = new Date(today); mon.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1) + offset * 7); mon.setHours(0,0,0,0)
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
  const wk = getISOWeek(mon), mStr = mon.toISOString().slice(0,10), sStr = sun.toISOString().slice(0,10)
  const mM = MONTHS[mon.getMonth()], sM = MONTHS[sun.getMonth()]
  const label = mM === sM ? `${mon.getDate()}–${sun.getDate()} ${mM}` : `${mon.getDate()} ${mM} – ${sun.getDate()} ${sM}`
  return { from: mStr, to: sStr, weekNum: wk, label, mon }
}

function getMonthBounds(offset = 0) {
  const now = new Date(), d = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return { from: d.toISOString().slice(0,10), to: last.toISOString().slice(0,10), label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, firstDay: d, daysInMonth: last.getDate() }
}

function delta(cur: number, prev: number) {
  if (!prev) return null
  const p = ((cur - prev) / prev) * 100
  return { pct: Math.round(p * 10) / 10, up: p >= 0 }
}

function KpiCard({ label, value, sub, deltaVal }: any) {
  return (
    <div style={{ background: 'white', borderRadius: 12, padding: '18px 20px', border: '1px solid #e5e7eb', flex: 1 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 10 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: '#111', marginBottom: 6, letterSpacing: '-0.5px' }}>{value}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 18 }}>
        {deltaVal && <span style={{ fontSize: 12, fontWeight: 700, color: deltaVal.up ? '#16a34a' : '#dc2626' }}>{deltaVal.up ? '↑' : '↓'} {Math.abs(deltaVal.pct)}%</span>}
        {sub && <span style={{ fontSize: 12, color: '#9ca3af' }}>{sub}</span>}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function RevenuePage() {
  const [bizId,       setBizId]       = useState<string | null>(null)
  const [weekOffset,  setWeekOffset]  = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  const [viewMode,    setViewMode]    = useState<'week'|'month'>('week')
  const [revData,     setRevData]     = useState<any>(null)
  const [prevRev,     setPrevRev]     = useState<any>(null)
  const [loading,     setLoading]     = useState(true)
  const [tooltip,     setTooltip]     = useState<any>(null)
  const [showForm,    setShowForm]    = useState(false)
  const [form,        setForm]        = useState<any>({ date: new Date().toISOString().slice(0,10), total: '', revenue: '' })
  const [saving,      setSaving]      = useState(false)

  useEffect(() => {
    const sync = () => { const s = localStorage.getItem('cc_selected_biz'); if (s) setBizId(s) }
    sync(); window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  useEffect(() => {
    if (!bizId) return
    setLoading(true)
    const biz  = `business_id=${bizId}`
    const curr = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
    const prev = viewMode === 'week' ? getWeekBounds(weekOffset - 1) : getMonthBounds(monthOffset - 1)

    Promise.all([
      fetch(`/api/revenue-detail?${biz}&from=${curr.from}&to=${curr.to}`).then(r => r.json()).catch(() => ({})),
      fetch(`/api/revenue-detail?${biz}&from=${prev.from}&to=${prev.to}`).then(r => r.json()).catch(() => ({})),
    ]).then(([cur, prv]) => {
      setRevData(cur)
      setPrevRev(prv)
      setLoading(false)
    })
  }, [bizId, weekOffset, monthOffset, viewMode])

  async function saveCovers() {
    setSaving(true)
    await fetch('/api/covers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, business_id: bizId }) })
    setSaving(false); setShowForm(false)
    // Trigger refetch
    setWeekOffset(o => o); setMonthOffset(o => o)
  }

  // ── Derived values ─────────────────────────────────────────────────────────
  const now  = new Date()
  const curr = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
  const periodLabel = viewMode === 'week' ? `Week ${(curr as any).weekNum}` : curr.label

  const rows    = revData?.rows ?? []
  const sum     = revData?.summary ?? {}
  const prevSum = prevRev?.summary ?? {}

  const totalRev    = sum.total_revenue ?? 0
  const totalCovers = sum.total_covers ?? 0
  const avgRpc      = sum.avg_rpc ?? 0
  const totalTips   = sum.total_tips ?? 0
  const foodRev     = sum.total_food_revenue ?? 0
  const bevRev      = sum.total_bev_revenue ?? 0
  const dineIn      = sum.total_dine_in ?? 0
  const takeaway    = sum.total_takeaway ?? 0

  // Chart
  const dayCount  = viewMode === 'week' ? 7 : (curr as any).daysInMonth ?? 30
  const chartDays = Array.from({ length: dayCount }, (_, i) => {
    const d = viewMode === 'week' ? new Date((curr as any).mon) : new Date((curr as any).firstDay)
    d.setDate(d.getDate() + i)
    const ds  = d.toISOString().slice(0, 10)
    const row = rows.find((r: any) => r.date === ds)
    const isToday  = ds === now.toISOString().slice(0, 10)
    const isFuture = d > now
    const dayIdx   = (d.getDay() + 6) % 7
    return {
      dateStr: ds, isToday, isFuture, dayIdx,
      dayName: viewMode === 'week' ? DAYS[dayIdx] : String(i + 1),
      revenue: row?.revenue ?? 0,
      covers: row?.covers ?? 0,
      tips: row?.tip_revenue ?? 0,
      food: row?.food_revenue ?? 0,
      bev: row?.bev_revenue ?? 0,
    }
  })
  const maxDayRev = Math.max(...chartDays.map(d => d.revenue), 1)

  return (
    <AppShell>
      <div className="page-wrap">

        {/* ── Header ──────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#111' }}>Revenue</h1>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#9ca3af' }}>Daily revenue, covers & breakdown</p>
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
                <button key={m} onClick={() => setViewMode(m)} style={{
                  padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  background: viewMode === m ? 'white' : 'transparent', color: viewMode === m ? '#111' : '#9ca3af',
                  boxShadow: viewMode === m ? '0 1px 3px rgba(0,0,0,.1)' : 'none',
                }}>{m === 'week' ? 'W' : 'M'}</button>
              ))}
            </div>
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 80, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading...</div>
        ) : (
          <>
            {/* ── 4 KPI cards ────────────────────────────────────────── */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
              <KpiCard label="Revenue" value={totalRev > 0 ? fmtKr(totalRev) : '—'} deltaVal={delta(totalRev, prevSum.total_revenue ?? 0)} sub={`vs prev ${viewMode === 'week' ? 'week' : 'month'}`} />
              <KpiCard label="Covers" value={totalCovers > 0 ? totalCovers.toLocaleString('en-GB') : '—'} deltaVal={delta(totalCovers, prevSum.total_covers ?? 0)} sub={`${sum.days_with_data ?? 0} days with data`} />
              <KpiCard label="Avg per Cover" value={avgRpc > 0 ? fmtKr(avgRpc) : '—'} sub={totalCovers > 0 ? `${totalCovers} covers` : 'No cover data'} />
              <KpiCard label="Tips" value={totalTips > 0 ? fmtKr(totalTips) : '—'} deltaVal={delta(totalTips, prevSum.total_tips ?? 0)} sub={totalTips > 0 && totalRev > 0 ? `${fmtPct((totalTips / totalRev) * 100)} of revenue` : 'No tip data'} />
            </div>

            {/* ── Daily revenue chart ────────────────────────────────── */}
            <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>Revenue — {periodLabel}</div>
                {(foodRev > 0 || bevRev > 0) && (
                  <div style={{ display: 'flex', gap: 16 }}>
                    {[{ color: '#1a1f2e', label: 'Food' }, { color: '#10b981', label: 'Beverage' }].map(l => (
                      <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <div style={{ width: 10, height: 10, borderRadius: 2, background: l.color }} />
                        <span style={{ fontSize: 11, color: '#9ca3af' }}>{l.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: viewMode === 'week' ? 8 : 2, height: 200, alignItems: 'flex-end', position: 'relative' }}>
                {chartDays.map((day) => {
                  const revH    = day.revenue > 0 ? Math.max((day.revenue / maxDayRev) * 180, 3) : 0
                  const foodPct = day.revenue > 0 && day.food > 0 ? (day.food / day.revenue) * 100 : 0
                  const isHover = tooltip?.dateStr === day.dateStr

                  return (
                    <div key={day.dateStr} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, cursor: day.revenue > 0 ? 'pointer' : 'default' }}
                      onMouseEnter={() => day.revenue > 0 && setTooltip(day)}
                      onMouseLeave={() => setTooltip(null)}>
                      <div style={{ flex: 1, width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                        {day.revenue > 0 ? (
                          <div style={{
                            height: revH, borderRadius: '4px 4px 0 0',
                            background: foodPct > 0 ? `linear-gradient(to top, #10b981 ${100 - foodPct}%, #1a1f2e ${100 - foodPct}%)` : '#1a1f2e',
                            opacity: isHover ? 1 : day.isFuture ? 0.3 : 0.85,
                            transition: 'opacity 0.15s',
                            boxShadow: isHover ? '0 0 0 2px #6366f1' : 'none',
                          }} />
                        ) : (
                          <div style={{ height: 2, background: day.isFuture ? '#f3f4f6' : '#e5e7eb', borderRadius: 2 }} />
                        )}
                      </div>
                      <div style={{ fontSize: viewMode === 'week' ? 11 : 8, fontWeight: day.isToday ? 700 : 400, color: day.isToday ? '#6366f1' : day.dayIdx >= 5 ? '#d1d5db' : '#9ca3af' }}>{day.dayName}</div>
                    </div>
                  )
                })}
              </div>

              {tooltip && (
                <div style={{ marginTop: 12, padding: '12px 16px', background: '#1a1f2e', borderRadius: 10, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', alignSelf: 'center', minWidth: 80 }}>
                    {new Date(tooltip.dateStr + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}
                  </div>
                  {[
                    { label: 'Revenue', value: fmtKr(tooltip.revenue), color: 'white' },
                    { label: 'Covers',  value: tooltip.covers > 0 ? String(tooltip.covers) : '—', color: '#86efac' },
                    { label: 'Tips',    value: tooltip.tips > 0 ? fmtKr(tooltip.tips) : '—', color: '#10b981' },
                    { label: 'Food',    value: tooltip.food > 0 ? fmtKr(tooltip.food) : '—', color: '#f59e0b' },
                    { label: 'Bev',     value: tooltip.bev > 0 ? fmtKr(tooltip.bev) : '—', color: '#06b6d4' },
                  ].map(col => (
                    <div key={col.label}>
                      <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 2 }}>{col.label}</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: col.color }}>{col.value}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Revenue splits + table ──────────────────────────────── */}
            <div style={{ display: 'grid', gridTemplateColumns: (dineIn > 0 || foodRev > 0) ? '3fr 1fr' : '1fr', gap: 12, marginBottom: 16 }}>

              {/* Revenue table */}
              <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
                <div style={{ padding: '12px 20px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>Daily breakdown</div>
                  <button onClick={() => setShowForm(!showForm)} style={{ padding: '5px 12px', background: '#f3f4f6', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', color: '#374151' }}>+ Log covers</button>
                </div>

                {showForm && (
                  <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', background: '#f9fafb' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                      <div><label style={{ fontSize: 10, color: '#9ca3af', display: 'block', marginBottom: 3 }}>Date</label>
                        <input type="date" value={form.date} onChange={e => setForm((f: any) => ({ ...f, date: e.target.value }))} style={{ padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12 }} /></div>
                      <div><label style={{ fontSize: 10, color: '#9ca3af', display: 'block', marginBottom: 3 }}>Covers</label>
                        <input type="number" value={form.total} onChange={e => setForm((f: any) => ({ ...f, total: e.target.value }))} placeholder="0" style={{ padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, width: 80 }} /></div>
                      <div><label style={{ fontSize: 10, color: '#9ca3af', display: 'block', marginBottom: 3 }}>Revenue (kr)</label>
                        <input type="number" value={form.revenue} onChange={e => setForm((f: any) => ({ ...f, revenue: e.target.value }))} placeholder="0" style={{ padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, width: 100 }} /></div>
                      <button onClick={saveCovers} disabled={saving} style={{ padding: '6px 14px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{saving ? '...' : 'Save'}</button>
                      <button onClick={() => setShowForm(false)} style={{ padding: '6px 10px', background: '#e5e7eb', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer', color: '#374151' }}>Cancel</button>
                    </div>
                  </div>
                )}

                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      {['Date', 'Revenue', 'Covers', 'Per Cover', 'Tips', 'Source'].map(h => (
                        <th key={h} style={{ padding: '9px 14px', textAlign: h === 'Date' ? 'left' : 'right', fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.filter((r: any) => !r.is_closed).length === 0 ? (
                      <tr><td colSpan={6} style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No revenue data for this period</td></tr>
                    ) : rows.filter((r: any) => !r.is_closed).map((r: any) => (
                      <tr key={r.date} style={{ borderBottom: '1px solid #f9fafb' }}>
                        <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 500, color: '#111' }}>
                          {new Date(r.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, fontWeight: 600, color: '#111' }}>{r.revenue > 0 ? fmtKr(r.revenue) : '—'}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, color: '#374151' }}>{r.covers > 0 ? r.covers : '—'}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 13, color: '#6b7280' }}>{r.revenue_per_cover > 0 ? fmtKr(r.revenue_per_cover) : '—'}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontSize: 12, color: r.tip_revenue > 0 ? '#10b981' : '#d1d5db' }}>{r.tip_revenue > 0 ? fmtKr(r.tip_revenue) : '—'}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                          <span style={{ fontSize: 10, background: '#f3f4f6', color: '#6b7280', padding: '2px 6px', borderRadius: 3 }}>{r.providers?.length ? r.providers.join(', ') : 'manual'}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Breakdown sidebar */}
              {(dineIn > 0 || foodRev > 0) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

                  {/* Dine-in vs takeaway */}
                  {(dineIn > 0 || takeaway > 0) && (
                    <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '16px 18px' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 10 }}>Channel Split</div>
                      <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', marginBottom: 10, background: '#f3f4f6' }}>
                        {totalRev > 0 && (<>
                          {dineIn > 0 && <div style={{ width: `${(dineIn / totalRev) * 100}%`, background: '#1a1f2e' }} />}
                          {takeaway > 0 && <div style={{ width: `${(takeaway / totalRev) * 100}%`, background: '#6366f1' }} />}
                        </>)}
                      </div>
                      {[
                        { label: 'Dine-in',  value: fmtKr(dineIn),  color: '#1a1f2e' },
                        { label: 'Takeaway', value: fmtKr(takeaway), color: '#6366f1' },
                      ].map(r => (
                        <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12, borderBottom: '1px solid #f3f4f6' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <div style={{ width: 8, height: 8, borderRadius: 2, background: r.color }} />
                            <span style={{ color: '#6b7280' }}>{r.label}</span>
                          </div>
                          <span style={{ fontWeight: 600, color: '#111' }}>{r.value}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Food vs beverage */}
                  {(foodRev > 0 || bevRev > 0) && (
                    <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '16px 18px' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 10 }}>Food vs Beverage</div>
                      <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', marginBottom: 10, background: '#f3f4f6' }}>
                        {totalRev > 0 && (<>
                          {foodRev > 0 && <div style={{ width: `${(foodRev / totalRev) * 100}%`, background: '#f59e0b' }} />}
                          {bevRev > 0 && <div style={{ width: `${(bevRev / totalRev) * 100}%`, background: '#10b981' }} />}
                        </>)}
                      </div>
                      {[
                        { label: 'Food',     value: fmtKr(foodRev), pct: totalRev > 0 ? Math.round((foodRev / totalRev) * 100) : 0, color: '#f59e0b' },
                        { label: 'Beverage', value: fmtKr(bevRev),  pct: totalRev > 0 ? Math.round((bevRev / totalRev) * 100) : 0, color: '#10b981' },
                      ].map(r => (
                        <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12, borderBottom: '1px solid #f3f4f6' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <div style={{ width: 8, height: 8, borderRadius: 2, background: r.color }} />
                            <span style={{ color: '#6b7280' }}>{r.label}</span>
                          </div>
                          <span style={{ fontWeight: 600, color: '#111' }}>{r.value} <span style={{ fontSize: 10, color: '#9ca3af' }}>({r.pct}%)</span></span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Tips summary */}
                  {totalTips > 0 && (
                    <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '16px 18px' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af', marginBottom: 10 }}>Tips</div>
                      <div style={{ fontSize: 20, fontWeight: 700, color: '#10b981', marginBottom: 4 }}>{fmtKr(totalTips)}</div>
                      <div style={{ fontSize: 12, color: '#9ca3af' }}>{fmtPct((totalTips / totalRev) * 100)} of revenue</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <AskAI page="revenue" context={[
        `Period: ${curr.from} to ${curr.to}`,
        totalRev > 0 ? `Revenue: ${fmtKr(totalRev)}, Covers: ${totalCovers}, Avg/cover: ${fmtKr(avgRpc)}` : 'No revenue data',
        totalTips > 0 ? `Tips: ${fmtKr(totalTips)}` : '',
        foodRev > 0 ? `Food: ${fmtKr(foodRev)}, Beverage: ${fmtKr(bevRev)}` : '',
      ].filter(Boolean).join('\n')} />
    </AppShell>
  )
}
