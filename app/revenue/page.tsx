'use client'
// @ts-nocheck
// app/revenue/page.tsx — Revenue, covers, food/bev split
// Same W/M navigator pattern as dashboard

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'
import PageHero from '@/components/ui/PageHero'
import SupportingStats from '@/components/ui/SupportingStats'
import SegmentedToggle from '@/components/ui/SegmentedToggle'
import TopBar from '@/components/ui/TopBar'
import { UX } from '@/lib/constants/tokens'

const fmtKr  = (n: number) => Math.round(n).toLocaleString('en-GB') + ' kr'
const fmtPct = (n: number) => (Math.round(n * 10) / 10).toFixed(1) + '%'
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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
  const wk = getISOWeek(mon), mStr = localDate(mon), sStr = localDate(sun)
  const mM = MONTHS[mon.getMonth()], sM = MONTHS[sun.getMonth()]
  const label = mM === sM ? `${mon.getDate()}–${sun.getDate()} ${mM}` : `${mon.getDate()} ${mM} – ${sun.getDate()} ${sM}`
  return { from: mStr, to: sStr, weekNum: wk, label, mon }
}

function getMonthBounds(offset = 0) {
  const now = new Date(), d = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return { from: localDate(d), to: localDate(last), label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, firstDay: d, daysInMonth: last.getDate() }
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
  // Default to month — week view lands on the current week which early in
  // the week has no synced data yet and shows blanks. Month matches the
  // other detail pages and gives something useful on first load.
  const [viewMode,    setViewMode]    = useState<'week'|'month'>('month')
  const [revData,     setRevData]     = useState<any>(null)
  const [prevRev,     setPrevRev]     = useState<any>(null)
  const [loading,     setLoading]     = useState(true)
  const [tooltip,     setTooltip]     = useState<any>(null)
  const [showForm,    setShowForm]    = useState(false)
  const [form,        setForm]        = useState<any>({ date: localDate(new Date()), total: '', revenue: '' })
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
  const daysWithData = sum.days_with_data ?? 0

  // Surface the single day when that's all we've got — the hero, the chart
  // state, and the "only day" copy all key off it.
  const onlyDayRow = (() => {
    const nonClosed = rows.filter((r: any) => !r.is_closed && Number(r.revenue ?? 0) > 0)
    return nonClosed.length === 1 ? nonClosed[0] : null
  })()
  const foodOnly = foodRev > 0 && bevRev === 0 && totalRev > 0
  const hasChannelData = dineIn > 0 || takeaway > 0

  // Chart
  const dayCount  = viewMode === 'week' ? 7 : (curr as any).daysInMonth ?? 30
  const chartDays = Array.from({ length: dayCount }, (_, i) => {
    const d = viewMode === 'week' ? new Date((curr as any).mon) : new Date((curr as any).firstDay)
    d.setDate(d.getDate() + i)
    const ds  = localDate(d)
    const row = rows.find((r: any) => r.date === ds)
    const isToday  = ds === localDate(now)
    const isFuture = d > now
    const dayIdx   = (d.getDay() + 6) % 7
    return {
      dateStr: ds, isToday, isFuture, dayIdx,
      dayName: viewMode === 'week' ? DAYS[dayIdx] : String(i + 1),
      revenue:  row?.revenue ?? 0,
      covers:   row?.covers ?? 0,
      tips:     row?.tip_revenue ?? 0,
      food:     row?.food_revenue ?? 0,
      bev:      row?.bev_revenue ?? 0,
      takeaway: row?.takeaway_revenue ?? 0,
      dine_in:  row?.dine_in_revenue ?? 0,
    }
  })
  const maxDayRev = Math.max(...chartDays.map(d => d.revenue), 1)

  return (
    <AppShell>
      <div className="page-wrap">

        {/* TopBar — crumb + period navigator + W/M toggle in the right slot.
            Replaces the free-floating navigator that was competing with the
            hero's SupportingStats for visual weight. */}
        <TopBar
          crumbs={[
            { label: 'Operations' },
            { label: 'Revenue', active: true },
          ]}
          rightSlot={
            <>
              {viewMode === 'week' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button onClick={() => setWeekOffset(o => o - 1)} style={navBtn}>‹</button>
                  <div style={{ minWidth: 120, textAlign: 'center' as const, fontSize: UX.fsBody, fontWeight: UX.fwMedium, color: UX.ink1 }}>
                    Week {(curr as any).weekNum} · {curr.label}
                  </div>
                  <button onClick={() => setWeekOffset(o => Math.min(o + 1, 0))} disabled={weekOffset === 0} style={{ ...navBtn, color: weekOffset === 0 ? UX.ink5 : UX.ink2, cursor: weekOffset === 0 ? 'not-allowed' : 'pointer' }}>›</button>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button onClick={() => setMonthOffset(o => o - 1)} style={navBtn}>‹</button>
                  <div style={{ minWidth: 120, textAlign: 'center' as const, fontSize: UX.fsBody, fontWeight: UX.fwMedium, color: UX.ink1 }}>{curr.label}</div>
                  <button onClick={() => setMonthOffset(o => Math.min(o + 1, 0))} disabled={monthOffset === 0} style={{ ...navBtn, color: monthOffset === 0 ? UX.ink5 : UX.ink2, cursor: monthOffset === 0 ? 'not-allowed' : 'pointer' }}>›</button>
                </div>
              )}
              <SegmentedToggle
                options={[{ value: 'week', label: 'W' }, { value: 'month', label: 'M' }]}
                value={viewMode}
                onChange={(v) => setViewMode(v as 'week' | 'month')}
              />
            </>
          }
        />

        {/* PageHero */}
        <PageHero
          eyebrow={`${curr.label.toUpperCase()} · ${daysWithData} DAY${daysWithData === 1 ? '' : 'S'} OF DATA`}
          headline={<RevenueHeadline totalRev={totalRev} prevRev={prevSum.total_revenue ?? 0} foodRev={foodRev} bevRev={bevRev} foodOnly={foodOnly} takeaway={takeaway} dineIn={dineIn} viewMode={viewMode} onlyDayRow={onlyDayRow} />}
          context={buildRevenueContext({ totalRev, totalCovers, takeaway, dineIn, foodRev, bevRev, hasChannelData, foodOnly })}
          right={
            <SupportingStats
              items={[
                {
                  label: 'Revenue',
                  value: totalRev > 0 ? fmtKr(totalRev) : '—',
                  delta: deltaLabel(totalRev, prevSum.total_revenue ?? 0),
                  deltaTone: (prevSum.total_revenue ?? 0) > 0 ? (totalRev >= (prevSum.total_revenue ?? 0) ? 'good' : 'bad') : 'neutral',
                },
                {
                  label: 'Per cover',
                  value: avgRpc > 0 ? fmtKr(avgRpc) : '—',
                  sub:   totalCovers > 0 ? `${totalCovers} covers` : 'No cover data',
                },
                {
                  label: 'Takeaway',
                  value: takeaway > 0 ? fmtKr(takeaway) : '—',
                  sub:   takeaway > 0 && totalRev > 0 ? `${fmtPct((takeaway / totalRev) * 100)} · 6% VAT` : 'No takeaway data',
                },
              ]}
            />
          }
        />

        {loading ? (
          <div style={{ padding: 80, textAlign: 'center' as const, color: UX.ink4, fontSize: UX.fsBody }}>Loading…</div>
        ) : (
          <>

            {/* ── Daily revenue chart ────────────────────────────────── */}
            <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '20px 24px', marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>Revenue — {periodLabel}</div>
                  {daysWithData > 0 && daysWithData < Math.max(3, Math.floor(dayCount / 3)) && (
                    <div style={{ fontSize: 11, color: UX.ink4, marginTop: 2 }}>
                      Only {daysWithData} day{daysWithData === 1 ? '' : 's'} of data in this {viewMode === 'week' ? 'week' : 'month'} — the rest will fill in as they sync.
                    </div>
                  )}
                </div>
                {(foodRev > 0 && bevRev > 0) && (
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
                    { label: 'Revenue',  value: fmtKr(tooltip.revenue), color: 'white' },
                    { label: 'Takeaway', value: tooltip.takeaway > 0 ? fmtKr(tooltip.takeaway) : '—', color: '#a5b4fc' },
                    { label: 'Dine-in',  value: tooltip.dine_in  > 0 ? fmtKr(tooltip.dine_in)  : '—', color: '#e5e7eb' },
                    { label: 'Covers',   value: tooltip.covers > 0 ? String(tooltip.covers) : '—', color: '#86efac' },
                    { label: 'Tips',     value: tooltip.tips > 0 ? fmtKr(tooltip.tips) : '—', color: '#10b981' },
                    { label: 'Food',     value: tooltip.food > 0 ? fmtKr(tooltip.food) : '—', color: '#f59e0b' },
                    { label: 'Bev',      value: tooltip.bev > 0 ? fmtKr(tooltip.bev) : '—', color: '#06b6d4' },
                  ].map(col => (
                    <div key={col.label}>
                      <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 2 }}>{col.label}</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: col.color }}>{col.value}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Revenue splits + table ────────────────────────────────
                The sidebar column only opens when at least one card inside
                it will actually render. Channel Split needs dine-in OR
                takeaway; Food vs Bev needs BOTH food and beverage; Tips
                needs totalTips > 0. Anything less → single-column layout.
                Stops an empty sidebar appearing on food-only / single-day
                states (FIX-PROMPT § Phase 6). */}
            <div style={{ display: 'grid', gridTemplateColumns: (hasChannelData || (foodRev > 0 && bevRev > 0) || totalTips > 0) ? '3fr 1fr' : '1fr', gap: 12, marginBottom: 16 }}>

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
                      {['Date', 'Revenue', 'Takeaway', 'Dine-in', 'Covers', 'Per Cover', 'Tips', 'Source'].map(h => (
                        <th key={h} style={{ padding: '9px 14px', textAlign: h === 'Date' ? 'left' : 'right', fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: '.05em' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.filter((r: any) => !r.is_closed).length === 0 ? (
                      <tr><td colSpan={8} style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 13 }}>No revenue data for this period</td></tr>
                    ) : rows.filter((r: any) => !r.is_closed).map((r: any) => {
                      const takePct = r.revenue > 0 && r.takeaway_revenue > 0 ? Math.round((r.takeaway_revenue / r.revenue) * 100) : 0
                      return (
                        <tr key={r.date} style={{ borderBottom: '1px solid #f9fafb' }}>
                          <td style={{ padding: '10px 14px', fontSize: 13, fontWeight: 500, color: '#111' }}>
                            {new Date(r.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' as const, fontSize: 13, fontWeight: 600, color: '#111' }}>{r.revenue > 0 ? fmtKr(r.revenue) : '—'}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' as const, fontSize: 13, color: r.takeaway_revenue > 0 ? '#4338ca' : '#d1d5db' }}>
                            {r.takeaway_revenue > 0
                              ? <>{fmtKr(r.takeaway_revenue)} <span style={{ fontSize: 10, color: '#9ca3af' }}>({takePct}%)</span></>
                              : '—'}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' as const, fontSize: 13, color: r.dine_in_revenue > 0 ? '#374151' : '#d1d5db' }}>{r.dine_in_revenue > 0 ? fmtKr(r.dine_in_revenue) : '—'}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' as const, fontSize: 13, color: '#374151' }}>{r.covers > 0 ? r.covers : '—'}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' as const, fontSize: 13, color: '#6b7280' }}>{r.revenue_per_cover > 0 ? fmtKr(r.revenue_per_cover) : '—'}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' as const, fontSize: 12, color: r.tip_revenue > 0 ? '#10b981' : '#d1d5db' }}>{r.tip_revenue > 0 ? fmtKr(r.tip_revenue) : '—'}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right' as const }}>
                            <span style={{ fontSize: 10, background: '#f3f4f6', color: '#6b7280', padding: '2px 6px', borderRadius: 3 }}>{r.providers?.length ? r.providers.join(', ') : 'manual'}</span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>

              </div>

              {/* Breakdown sidebar — same gate as the grid column above. */}
              {(hasChannelData || (foodRev > 0 && bevRev > 0) || totalTips > 0) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

                  {/* Dine-in vs takeaway — tax-treatment matters: Swedish
                      takeaway food sits at 6% VAT vs dine-in at 12%, so the
                      channel mix directly affects how much VAT we owe. */}
                  {(dineIn > 0 || takeaway > 0) && (
                    <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e5e7eb', padding: '16px 18px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#9ca3af' }}>Channel Split</div>
                        <div style={{ fontSize: 10, color: '#9ca3af' }}>VAT-weighted</div>
                      </div>
                      <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', marginBottom: 10, background: '#f3f4f6' }}>
                        {totalRev > 0 && (<>
                          {dineIn > 0 && <div style={{ width: `${(dineIn / totalRev) * 100}%`, background: '#1a1f2e' }} />}
                          {takeaway > 0 && <div style={{ width: `${(takeaway / totalRev) * 100}%`, background: '#6366f1' }} />}
                        </>)}
                      </div>
                      {[
                        { label: 'Dine-in',  value: dineIn,   color: '#1a1f2e', vat: '12%' },
                        { label: 'Takeaway', value: takeaway, color: '#6366f1', vat: '6%'  },
                      ].map(r => (
                        <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '5px 0', fontSize: 12, borderBottom: '1px solid #f3f4f6' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <div style={{ width: 8, height: 8, borderRadius: 2, background: r.color }} />
                            <span style={{ color: '#6b7280' }}>{r.label}</span>
                            <span style={{ fontSize: 10, color: '#9ca3af', padding: '1px 5px', background: '#f9fafb', borderRadius: 3 }}>{r.vat} VAT</span>
                          </div>
                          <span style={{ fontWeight: 600, color: '#111' }}>
                            {r.value > 0 ? fmtKr(r.value) : '—'}{' '}
                            {r.value > 0 && totalRev > 0 && <span style={{ fontSize: 10, color: '#9ca3af', fontWeight: 400 }}>({Math.round((r.value / totalRev) * 100)}%)</span>}
                          </span>
                        </div>
                      ))}
                      {dineIn === 0 && takeaway > 0 && (
                        <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 6 }}>
                          No dine-in flag from POS — all revenue here is tagged takeaway.
                        </div>
                      )}
                    </div>
                  )}

                  {/* Food vs beverage — hide entirely when it'd just show
                      "Food 100% · Beverage 0%". That's already called out
                      in the hero (foodOnly flag), so the card adds noise
                      rather than signal. FIX-PROMPT § Phase 6. */}
                  {(foodRev > 0 && bevRev > 0) && (
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
        takeaway > 0 && totalRev > 0 ? `Takeaway: ${fmtKr(takeaway)} (${fmtPct((takeaway / totalRev) * 100)} of revenue, 6% VAT), Dine-in: ${fmtKr(dineIn)} (12% VAT)` : '',
        totalTips > 0 ? `Tips: ${fmtKr(totalTips)}` : '',
        foodRev > 0 ? `Food: ${fmtKr(foodRev)}, Beverage: ${fmtKr(bevRev)}` : '',
      ].filter(Boolean).join('\n')} />
    </AppShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Revenue hero headline — prioritises single-day / food-only honesty over a
// generic delta template. Per FIX-PROMPT § Phase 6 the hero must reflect
// what's actually in the data, not inject a vague "mix steady" platitude.
// ─────────────────────────────────────────────────────────────────────────────
function RevenueHeadline({ totalRev, prevRev, foodRev, bevRev, takeaway, dineIn, foodOnly, viewMode, onlyDayRow }: any) {
  if (totalRev <= 0) {
    return <>Waiting on the sync — no revenue data for this {viewMode === 'week' ? 'week' : 'month'} yet.</>
  }
  // Single day with data + food-only is the most specific state the page
  // typically sees early in a month. Name it explicitly — Paul's exact
  // copy from FIX-PROMPT.
  if (onlyDayRow) {
    const d = new Date(onlyDayRow.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
    const kr = Math.round(Number(onlyDayRow.revenue ?? 0)).toLocaleString('en-GB').replace(/,/g, ' ') + ' kr'
    if (foodOnly) {
      return <>Only <span style={{ fontWeight: UX.fwMedium }}>{d}</span> has data — <span style={{ fontWeight: UX.fwMedium }}>{kr}</span>, <span style={{ color: UX.amberInk, fontWeight: UX.fwMedium }}>food-only</span>.</>
    }
    return <>Only <span style={{ fontWeight: UX.fwMedium }}>{d}</span> has data — <span style={{ fontWeight: UX.fwMedium }}>{kr}</span>.</>
  }
  if (prevRev > 0) {
    const pct = ((totalRev - prevRev) / prevRev) * 100
    const delta = (pct >= 0 ? '+' : '−') + (Math.round(Math.abs(pct) * 10) / 10).toFixed(1) + '%'
    const tone = pct >= 0 ? UX.greenInk : UX.redInk
    // Describe mix from the actual data, not a template.
    let mix: string
    if (foodOnly) mix = 'food-only'
    else if (foodRev > bevRev * 2) mix = 'food-heavy'
    else if (bevRev > foodRev * 2) mix = 'beverage-heavy'
    else if (takeaway > 0 && dineIn > 0) {
      const takePct = Math.round((takeaway / (takeaway + dineIn)) * 100)
      mix = `dine-in ${100 - takePct}% / takeaway ${takePct}%`
    }
    else if (takeaway > 0) mix = 'takeaway-only'
    else mix = 'dine-in'
    return (
      <>
        Revenue <span style={{ color: tone, fontWeight: UX.fwMedium }}>{delta}</span> vs last {viewMode === 'week' ? 'week' : 'month'} — {mix}.
      </>
    )
  }
  return (
    <>
      Revenue <span style={{ fontWeight: UX.fwMedium }}>{Math.round(totalRev).toLocaleString('en-GB').replace(/,/g, ' ')} kr</span> this {viewMode === 'week' ? 'week' : 'month'}.
    </>
  )
}

function buildRevenueContext({ totalRev, totalCovers, takeaway, dineIn, foodRev, bevRev, hasChannelData, foodOnly }: any): string | undefined {
  const parts: string[] = []
  // Channel split — surface the same 63/37 that the Channel Split card
  // shows, so the hero and the card don't contradict each other.
  if (hasChannelData && totalRev > 0) {
    const dinePct = Math.round((dineIn / totalRev) * 100)
    const takePct = Math.round((takeaway / totalRev) * 100)
    if (dineIn > 0 && takeaway > 0)      parts.push(`dine-in ${dinePct}% / takeaway ${takePct}%`)
    else if (takeaway > 0)               parts.push(`takeaway only (6% VAT)`)
    else if (dineIn > 0)                 parts.push(`dine-in only`)
  }
  if (totalCovers > 0) parts.push(`${totalCovers} covers`)
  if (foodOnly)        parts.push(`beverage shows 0 kr — check POS sync if this seems wrong`)
  if (!parts.length) return undefined
  return parts.join(' · ')
}

function deltaLabel(cur: number, prev: number): string | undefined {
  if (!prev) return undefined
  const pct = ((cur - prev) / prev) * 100
  return `${pct >= 0 ? '↑' : '↓'} ${Math.abs(Math.round(pct * 10) / 10).toFixed(1)}%`
}

const navBtn = {
  width: 28, height: 28, borderRadius: UX.r_md, border: `0.5px solid ${UX.border}`,
  background: UX.cardBg, cursor: 'pointer', fontSize: 14,
  display: 'flex', alignItems: 'center', justifyContent: 'center', color: UX.ink2,
} as const
