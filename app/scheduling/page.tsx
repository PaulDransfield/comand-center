'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'

const fmtKr  = (n: number) => Math.round(n).toLocaleString('en-GB') + ' kr'
const fmtH   = (n: number) => (Math.round(n * 10) / 10) + 'h'
const fmtPct = (n: number) => (Math.round(n * 10) / 10) + '%'

// Local-date helpers matching departments/dashboard pages
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const WEEKDAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function getISOWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = date.getUTCDay() || 7; date.setUTCDate(date.getUTCDate() + 4 - day)
  const y1 = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - y1.getTime()) / 86400000 + 1) / 7)
}
function getWeekBounds(offset = 0) {
  const today = new Date(), dow = today.getDay()
  const mon = new Date(today); mon.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1) + offset * 7); mon.setHours(0,0,0,0)
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
  const mM = MONTHS[mon.getMonth()], sM = MONTHS[sun.getMonth()]
  return { from: localDate(mon), to: localDate(sun), weekNum: getISOWeek(mon), label: mM === sM ? `${mon.getDate()}–${sun.getDate()} ${mM}` : `${mon.getDate()} ${mM} – ${sun.getDate()} ${sM}` }
}
function getMonthBounds(offset = 0) {
  const now = new Date(), d = new Date(now.getFullYear(), now.getMonth() + offset, 1), last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return { from: localDate(d), to: localDate(last), label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` }
}

// Status meta — note: we remap the API's 'understaffed' status to 'lean' (it's actually
// the GOOD state: high revenue per labour hour means you're getting a lot out of every
// scheduled hour, i.e. lean efficient staffing. The old label/colour were misleading.)
//
// API → UI:  understaffed → lean (green)  ·  efficient → on_target (neutral)  ·  overstaffed → overstaffed (amber)
const STATUS_META: Record<string, any> = {
  lean:        { label: 'Lean',        bg: '#f0fdf4', border: '#bbf7d0', dot: '#15803d', text: '#15803d', hint: 'High revenue per hour — you\'re doing a lot with the hours scheduled.' },
  on_target:   { label: 'On target',   bg: '#eff6ff', border: '#bfdbfe', dot: '#2563eb', text: '#2563eb', hint: 'Revenue per labour hour within ±20% of your weekly average.' },
  overstaffed: { label: 'Overstaffed', bg: '#fffbeb', border: '#fde68a', dot: '#d97706', text: '#d97706', hint: 'Revenue per hour is low — more hours scheduled than demand needs. Consider trimming.' },
  no_data:     { label: 'No data',     bg: '#f9fafb', border: '#e5e7eb', dot: '#9ca3af', text: '#9ca3af', hint: 'Fewer than 2 days of joined data for this weekday.' },
}

// Map API status → UI status
const mapStatus = (s: string) =>
  s === 'understaffed' ? 'lean'
  : s === 'efficient'  ? 'on_target'
  : s === 'overstaffed'? 'overstaffed'
  : 'no_data'

export default function SchedulingPage() {
  const [data,        setData]        = useState<any>(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')
  const [selectedBiz, setSelectedBiz] = useState('')
  const [viewMode,    setViewMode]    = useState<'week'|'month'>('month')   // default to month — more data on the scorecard
  const [weekOffset,  setWeekOffset]  = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)

  // Drill-down modal state
  const [drillDay,    setDrillDay]    = useState<number | null>(null)       // 0=Mon..6=Sun
  const [drillData,   setDrillData]   = useState<any>(null)
  const [drillLoading,setDrillLoading] = useState(false)

  useEffect(() => {
    const sync = () => {
      const saved = localStorage.getItem('cc_selected_biz')
      if (saved) setSelectedBiz(saved)
    }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  const curr = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
  const periodLabel = viewMode === 'week' ? `Week ${(curr as any).weekNum} · ${curr.label}` : curr.label
  const fromDate = curr.from
  const toDate   = curr.to

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

  useEffect(() => { if (selectedBiz) load() }, [selectedBiz, viewMode, weekOffset, monthOffset])

  async function openDayDrill(weekday: number) {
    setDrillDay(weekday)
    setDrillData(null)
    setDrillLoading(true)
    try {
      const res = await fetch(`/api/scheduling/day-details?business_id=${selectedBiz}&from=${fromDate}&to=${toDate}&weekday=${weekday}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load day details')
      setDrillData(json)
    } catch (e: any) {
      setDrillData({ error: e.message })
    }
    setDrillLoading(false)
  }

  const weekdaysRaw      = data?.weekday_efficiency ?? []
  const daily            = data?.daily_revpah       ?? []
  const summary          = data?.summary            ?? null
  const recommendation   = data?.latest_recommendation ?? null

  // Normalise weekday rows. In month mode we trust the API's status (which requires
  // ≥2 data points for a weekday to be classified). In week mode each weekday only
  // has 1 day of data so we recompute status locally from rev/hour vs weekly average —
  // otherwise every card would be greyed out "no_data".
  const weekdays = weekdaysRaw.map((w: any) => {
    if (w.days_with_data < 1 || !w.avg_rev_per_hour || !summary?.avg_rev_per_hour) {
      return { ...w, uiStatus: 'no_data' }
    }
    if (viewMode === 'week') {
      const ratio = w.avg_rev_per_hour / summary.avg_rev_per_hour
      const uiStatus = ratio > 1.20 ? 'lean' : ratio < 0.80 ? 'overstaffed' : 'on_target'
      return { ...w, uiStatus }
    }
    return { ...w, uiStatus: w.days_with_data >= 2 ? mapStatus(w.status) : 'no_data' }
  })

  const hasData = summary?.days_analyzed > 0

  // Derive labour % from daily rows (each day has cost + revenue)
  const totalCost    = daily.reduce((s: number, d: any) => s + (d.cost ?? 0), 0)
  const totalRev     = summary?.total_revenue ?? 0
  const labourPct    = totalRev > 0 ? (totalCost / totalRev) * 100 : null
  const labourTarget = 40     // industry benchmark for Swedish casual/mid-market
  const labourStatus = labourPct === null ? 'neutral' : labourPct <= labourTarget ? 'good' : labourPct > labourTarget * 1.1 ? 'bad' : 'warn'
  const labourColor  = labourStatus === 'good' ? '#15803d' : labourStatus === 'bad' ? '#dc2626' : labourStatus === 'warn' ? '#d97706' : '#111'

  // Count buckets
  const leanCount       = weekdays.filter((w: any) => w.uiStatus === 'lean').length
  const overstaffedList = weekdays.filter((w: any) => w.uiStatus === 'overstaffed').map((w: any) => w.label)

  return (
    <AppShell>
      <div className="page-wrap" style={{ maxWidth: 1100 }}>

        {/* Header */}
        <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: '#111' }}>Scheduling Efficiency</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Labour cost vs revenue · weekly patterns · what to tweak next week</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {viewMode === 'week' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button onClick={() => setWeekOffset(o => o - 1)} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #e5e7eb', background: 'white', cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#374151' }}>‹</button>
                <div style={{ minWidth: 160, textAlign: 'center' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>Week {(curr as any).weekNum}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{curr.label}</div>
                </div>
                <button onClick={() => setWeekOffset(o => Math.min(o + 1, 0))} disabled={weekOffset === 0} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #e5e7eb', background: 'white', cursor: weekOffset === 0 ? 'not-allowed' : 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: weekOffset === 0 ? '#d1d5db' : '#374151' }}>›</button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button onClick={() => setMonthOffset(o => o - 1)} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #e5e7eb', background: 'white', cursor: 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#374151' }}>‹</button>
                <div style={{ minWidth: 140, textAlign: 'center' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>{curr.label}</div>
                </div>
                <button onClick={() => setMonthOffset(o => Math.min(o + 1, 0))} disabled={monthOffset === 0} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #e5e7eb', background: 'white', cursor: monthOffset === 0 ? 'not-allowed' : 'pointer', fontSize: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', color: monthOffset === 0 ? '#d1d5db' : '#374151' }}>›</button>
              </div>
            )}
            <div style={{ display: 'flex', background: '#f3f4f6', borderRadius: 8, padding: 3, gap: 2 }}>
              {(['week', 'month'] as const).map(m => (
                <button key={m} onClick={() => setViewMode(m)} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: viewMode === m ? 'white' : 'transparent', color: viewMode === m ? '#111' : '#9ca3af', boxShadow: viewMode === m ? '0 1px 3px rgba(0,0,0,.1)' : 'none' }}>{m === 'week' ? 'W' : 'M'}</button>
              ))}
            </div>
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
            <div style={{ fontSize: 15, fontWeight: 600, color: '#111', marginBottom: 8 }}>No joined data yet</div>
            <div style={{ fontSize: 13, color: '#9ca3af', maxWidth: 380, margin: '0 auto' }}>
              Scheduling efficiency requires both staff hours (Personalkollen) and revenue (POS) data for the same dates. Try expanding the date range.
            </div>
          </div>
        ) : (
          <>

            {/* ═══════════════════════════════════════════════════════
                HERO SCORECARD — labour % vs target is the one number
                that tells the operator whether this period worked.
            ═══════════════════════════════════════════════════════ */}
            <div style={{
              background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 14,
              padding: '22px 28px', marginBottom: 16,
              display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 1fr', gap: 24, alignItems: 'center',
            }}>
              {/* Hero: labour % */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.08em', color: '#9ca3af', marginBottom: 6 }}>
                  Labour cost % of revenue
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <div style={{ fontSize: 38, fontWeight: 800, color: labourColor, letterSpacing: '-.03em', lineHeight: 1 }}>
                    {labourPct !== null ? fmtPct(labourPct) : '—'}
                  </div>
                  {labourPct !== null && (
                    <div style={{ fontSize: 12, fontWeight: 600, color: labourStatus === 'good' ? '#15803d' : labourStatus === 'bad' ? '#dc2626' : '#d97706' }}>
                      {labourStatus === 'good' ? `✓ under ${labourTarget}% target`
                       : labourStatus === 'warn' ? `${fmtPct(labourPct - labourTarget)} over target`
                       : labourStatus === 'bad'  ? `${fmtPct(labourPct - labourTarget)} over — attention needed`
                       : ''}
                    </div>
                  )}
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
                  {summary.days_analyzed} days analysed · target {labourTarget}% (Swedish mid-market)
                </div>
              </div>

              {/* Sub-stat: revenue per hour */}
              <div style={{ borderLeft: '1px solid #f3f4f6', paddingLeft: 24 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 4 }}>Rev / labour hr</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#111' }}>{summary.avg_rev_per_hour ? fmtKr(summary.avg_rev_per_hour) : '—'}</div>
                <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>period average</div>
              </div>

              {/* Sub-stat: total hours */}
              <div style={{ borderLeft: '1px solid #f3f4f6', paddingLeft: 24 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 4 }}>Total hours</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#111' }}>{fmtH(summary.total_hours)}</div>
                <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{fmtKr(totalCost)} labour cost</div>
              </div>

              {/* Sub-stat: revenue */}
              <div style={{ borderLeft: '1px solid #f3f4f6', paddingLeft: 24 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 4 }}>Revenue</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#111' }}>{fmtKr(summary.total_revenue)}</div>
                <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>period total</div>
              </div>
            </div>

            {/* ═══════════════════════════════════════════════════════
                7-DAY GRID — each day is a small scorecard with a
                traffic light. Replaces the old bar chart entirely.
            ═══════════════════════════════════════════════════════ */}
            <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 14, padding: '18px 22px', marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap' as const, gap: 10 }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>By day of week</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                    Compared against {summary.avg_rev_per_hour ? fmtKr(summary.avg_rev_per_hour) : '—'}/hr weekly average · ±20% band = on target
                  </div>
                </div>
                {/* Summary tags */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
                  {leanCount > 0 && (
                    <span style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, background: '#f0fdf4', color: '#15803d', fontWeight: 600, border: '1px solid #bbf7d0' }}>
                      {leanCount} lean day{leanCount !== 1 ? 's' : ''}
                    </span>
                  )}
                  {overstaffedList.length > 0 && (
                    <span style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, background: '#fffbeb', color: '#d97706', fontWeight: 600, border: '1px solid #fde68a' }}>
                      Overstaffed: {overstaffedList.join(', ')}
                    </span>
                  )}
                </div>
              </div>

              {/* 7 cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 10 }}>
                {weekdays.map((w: any) => {
                  const meta = STATUS_META[w.uiStatus] ?? STATUS_META.no_data
                  const has  = w.uiStatus !== 'no_data'
                  return (
                    <div
                      key={w.weekday}
                      onClick={() => has && openDayDrill(w.weekday)}
                      title={has ? `${meta.hint} · click for staff details` : meta.hint}
                      style={{
                        background: has ? meta.bg : '#fafafa',
                        border: `1px solid ${has ? meta.border : '#f3f4f6'}`,
                        borderRadius: 10,
                        padding: '12px 12px 10px',
                        display: 'flex', flexDirection: 'column' as const, gap: 4,
                        opacity: has ? 1 : 0.6,
                        cursor: has ? 'pointer' : 'default',
                        transition: 'transform .12s, box-shadow .12s',
                      }}
                      onMouseEnter={e => { if (has) { (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 12px rgba(16,24,40,.08)' } }}
                      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.transform = 'none'; (e.currentTarget as HTMLDivElement).style.boxShadow = 'none' }}
                    >
                      {/* Day name + status dot */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.06em', color: has ? meta.text : '#9ca3af' }}>
                          {w.label}
                        </span>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: meta.dot }} />
                      </div>

                      {/* Rev/hr — the headline metric for this day */}
                      <div style={{ fontSize: 18, fontWeight: 700, color: has ? '#111' : '#d1d5db', letterSpacing: '-.02em', lineHeight: 1.1 }}>
                        {has && w.avg_rev_per_hour ? fmtKr(w.avg_rev_per_hour) : '—'}
                      </div>

                      {/* Supporting figures */}
                      <div style={{ fontSize: 10, color: '#6b7280', lineHeight: 1.4 }}>
                        {has ? (
                          <>
                            {fmtKr(w.avg_revenue ?? 0)} rev<br />
                            {fmtH(w.avg_hours ?? 0)} · {w.days_with_data} days
                          </>
                        ) : (
                          <>
                            {w.days_with_data} day{w.days_with_data !== 1 ? 's' : ''} of data
                          </>
                        )}
                      </div>

                      {/* Status label at bottom */}
                      {has && (
                        <div style={{ marginTop: 2, fontSize: 10, fontWeight: 600, color: meta.text }}>
                          {meta.label}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Legend */}
              <div style={{ marginTop: 14, paddingTop: 12, borderTop: '0.5px solid #f3f4f6', display: 'flex', gap: 18, flexWrap: 'wrap' as const, fontSize: 11, color: '#6b7280' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_META.lean.dot }} /> Lean — high output per hour (good)
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_META.on_target.dot }} /> On target — within ±20% of average
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_META.overstaffed.dot }} /> Overstaffed — more hours than demand
                </span>
              </div>
            </div>

            {/* ═══════════════════════════════════════════════════════
                OBSERVATIONS — AI-generated specifics. Falls back to
                the upgrade card when no recommendations exist yet.
            ═══════════════════════════════════════════════════════ */}
            {recommendation ? (
              <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 14, padding: '20px 24px', marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>Observations</span>
                      <span style={{ fontSize: 10, background: '#ede9fe', color: '#6d28d9', padding: '2px 7px', borderRadius: 4, fontWeight: 600, letterSpacing: '.03em' }}>AI</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>
                      Generated {new Date(recommendation.generated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                      {recommendation.analysis_period && ` · based on ${recommendation.analysis_period}`}
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.7, whiteSpace: 'pre-wrap' as const, background: '#fafbff', borderRadius: 10, padding: '14px 16px', borderLeft: '3px solid #6366f1' }}>
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
              <div style={{ background: 'linear-gradient(135deg, #312e81, #1e1b4b)', border: '0.5px solid rgba(99,102,241,0.3)', borderRadius: 14, padding: '20px 24px', marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
                  <div style={{ flexShrink: 0, width: 40, height: 40, background: 'rgba(99,102,241,0.3)', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, color: 'white' }}>✦</div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'white', marginBottom: 4 }}>Weekly AI observations</div>
                    <div style={{ fontSize: 12, color: 'rgba(199,210,254,0.7)', lineHeight: 1.6, marginBottom: 14 }}>
                      Available on the Group plan. Every Monday at 07:00, Claude Sonnet reviews your last 90 days of shifts and revenue and writes specific observations — which days are trending lean, where lateness is costing you, which shifts to trim or add.
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

      {/* Day drill-down modal */}
      {drillDay !== null && (
        <div onClick={() => setDrillDay(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'white', borderRadius: 14, width: '100%', maxWidth: 720, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' as const }}>
            {/* Header */}
            <div style={{ padding: '16px 24px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' as const, color: '#9ca3af', marginBottom: 2 }}>
                  {WEEKDAY_NAMES[drillDay]}s in {periodLabel}
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#111' }}>
                  {drillLoading ? 'Loading…'
                    : drillData?.error ? 'Error'
                    : drillData ? (
                      <>
                        {fmtKr(drillData.totals.revenue)} rev · {fmtKr(drillData.totals.cost)} labour · {drillData.totals.rev_per_hour ? fmtKr(drillData.totals.rev_per_hour) + '/hr' : '—/hr'}
                      </>
                    ) : ''}
                </div>
                {!drillLoading && drillData && !drillData.error && (
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                    {drillData.dates.length} day{drillData.dates.length !== 1 ? 's' : ''} · {drillData.totals.staff_count} staff · {drillData.totals.shifts} shifts · {fmtH(drillData.totals.hours)}
                  </div>
                )}
              </div>
              <button onClick={() => setDrillDay(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#9ca3af', lineHeight: 1 }}>×</button>
            </div>

            {/* Body */}
            <div style={{ overflowY: 'auto', flex: 1, padding: '14px 24px 18px' }}>
              {drillLoading ? (
                <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 13 }}>Loading day details…</div>
              ) : drillData?.error ? (
                <div style={{ fontSize: 13, color: '#dc2626' }}>{drillData.error}</div>
              ) : drillData && drillData.dates.length > 0 ? (
                <>
                  {/* Per-date rows */}
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 8 }}>By date</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 20 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                        {['Date','Revenue','Labour','Hours','Staff','Rev/Hr'].map(h => (
                          <th key={h} style={{ padding: '6px 8px', textAlign: h === 'Date' ? 'left' : 'right', fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: '.06em' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {drillData.dates.map((d: any) => {
                        const dt = new Date(d.date)
                        const dateStr = `${dt.getDate()} ${MONTHS[dt.getMonth()]}`
                        return (
                          <tr key={d.date} style={{ borderBottom: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '8px 8px', color: '#111', fontWeight: 500 }}>{dateStr}</td>
                            <td style={{ padding: '8px 8px', textAlign: 'right' as const, color: '#111', fontWeight: 600 }}>{fmtKr(d.revenue)}</td>
                            <td style={{ padding: '8px 8px', textAlign: 'right' as const, color: '#374151' }}>{fmtKr(d.cost)}</td>
                            <td style={{ padding: '8px 8px', textAlign: 'right' as const, color: '#6b7280' }}>{fmtH(d.hours)}</td>
                            <td style={{ padding: '8px 8px', textAlign: 'right' as const, color: '#6b7280' }}>{d.staff_count}</td>
                            <td style={{ padding: '8px 8px', textAlign: 'right' as const, fontWeight: 600, color: '#111' }}>{d.rev_per_hour ? fmtKr(d.rev_per_hour) : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>

                  {/* Staff roster */}
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 8 }}>
                    Who worked ({drillData.staff.length})
                  </div>
                  {drillData.staff.length === 0 ? (
                    <div style={{ fontSize: 12, color: '#9ca3af', padding: '8px 0' }}>No staff shifts recorded for these dates.</div>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                          {['Name','Department','Shifts','Hours','Cost','Cost/Hr'].map(h => (
                            <th key={h} style={{ padding: '6px 8px', textAlign: h === 'Name' || h === 'Department' ? 'left' : 'right', fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: '.06em' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {drillData.staff.map((s: any) => (
                          <tr key={s.name} style={{ borderBottom: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '8px 8px', color: '#111', fontWeight: 500 }}>{s.name}</td>
                            <td style={{ padding: '8px 8px', color: '#6b7280' }}>{s.group}</td>
                            <td style={{ padding: '8px 8px', textAlign: 'right' as const, color: '#6b7280' }}>{s.shifts}</td>
                            <td style={{ padding: '8px 8px', textAlign: 'right' as const, color: '#6b7280' }}>{fmtH(s.hours)}</td>
                            <td style={{ padding: '8px 8px', textAlign: 'right' as const, fontWeight: 600, color: '#111' }}>{fmtKr(s.cost)}</td>
                            <td style={{ padding: '8px 8px', textAlign: 'right' as const, color: '#6b7280' }}>{s.avg_cost_per_hour ? fmtKr(s.avg_cost_per_hour) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 13, color: '#9ca3af', padding: '20px 0' }}>No data for {WEEKDAY_NAMES[drillDay]} in this period.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Contextual AI — updated wording to match new terminology */}
      <AskAI
        page="scheduling"
        context={summary ? [
          `Period: ${fromDate} to ${toDate}`,
          `Days analysed: ${summary.days_analyzed}`,
          labourPct !== null ? `Labour cost % of revenue: ${fmtPct(labourPct)} (target ${labourTarget}%)` : '',
          `Average revenue per labour hour: ${summary.avg_rev_per_hour ? fmtKr(summary.avg_rev_per_hour) : 'N/A'}`,
          `Total labour hours: ${fmtH(summary.total_hours)}`,
          `Total labour cost: ${fmtKr(totalCost)}`,
          `Total revenue: ${fmtKr(summary.total_revenue)}`,
          summary.best_weekday  ? `Most efficient day: ${summary.best_weekday.label} (${fmtKr(summary.best_weekday.avg_rev_per_hour)}/hr)`  : '',
          summary.worst_weekday ? `Least efficient day: ${summary.worst_weekday.label} (${fmtKr(summary.worst_weekday.avg_rev_per_hour)}/hr)` : '',
          leanCount > 0            ? `Lean days (doing a lot with scheduled hours): ${weekdays.filter((w: any) => w.uiStatus === 'lean').map((w: any) => w.label).join(', ')}` : '',
          overstaffedList.length   ? `Overstaffed days: ${overstaffedList.join(', ')}` : '',
          weekdays.filter((w: any) => w.days_with_data >= 2).length > 0
            ? `By weekday: ${weekdays.filter((w: any) => w.days_with_data >= 2).map((w: any) => `${w.label}: ${fmtKr(w.avg_rev_per_hour ?? 0)}/hr (${w.avg_hours}h avg, ${w.uiStatus})`).join('; ')}`
            : '',
        ].filter(Boolean).join('\n') : 'No scheduling data loaded yet'}
      />
    </AppShell>
  )
}
