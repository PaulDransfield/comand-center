'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'

const fmtKr  = (n: number) => Math.round(n).toLocaleString('en-GB') + ' kr'
const fmtH   = (n: number) => (Math.round(n * 10) / 10) + 'h'
const fmtPct = (n: number) => (Math.round(n * 10) / 10) + '%'

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
  const now = new Date()
  const ninetyDaysAgo = new Date(); ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

  const [data,        setData]       = useState<any>(null)
  const [loading,     setLoading]    = useState(true)
  const [error,       setError]      = useState('')
  const [selectedBiz, setSelectedBiz] = useState('')
  const [fromDate,    setFromDate]   = useState(ninetyDaysAgo.toISOString().slice(0, 10))
  const [toDate,      setToDate]     = useState(now.toISOString().slice(0, 10))

  useEffect(() => {
    const sync = () => {
      const saved = localStorage.getItem('cc_selected_biz')
      if (saved) setSelectedBiz(saved)
    }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

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

  useEffect(() => { if (selectedBiz) load() }, [selectedBiz])

  const weekdaysRaw      = data?.weekday_efficiency ?? []
  const daily            = data?.daily_revpah       ?? []
  const summary          = data?.summary            ?? null
  const recommendation   = data?.latest_recommendation ?? null

  // Normalise weekday rows to new status names
  const weekdays = weekdaysRaw.map((w: any) => ({ ...w, uiStatus: w.days_with_data >= 2 ? mapStatus(w.status) : 'no_data' }))

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
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
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
                      title={meta.hint}
                      style={{
                        background: has ? meta.bg : '#fafafa',
                        border: `1px solid ${has ? meta.border : '#f3f4f6'}`,
                        borderRadius: 10,
                        padding: '12px 12px 10px',
                        display: 'flex', flexDirection: 'column' as const, gap: 4,
                        opacity: has ? 1 : 0.6,
                      }}
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
