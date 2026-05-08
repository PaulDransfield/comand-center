'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import AppShell from '@/components/AppShell'
import dynamicImport from 'next/dynamic'
// FIXES §0ll: lazy-load AskAI — see /dashboard for rationale.
const AskAI = dynamicImport(() => import('@/components/AskAI'), { ssr: false, loading: () => null })
import TopBar from '@/components/ui/TopBar'
import { UX } from '@/lib/constants/tokens'
import { fmtKr, fmtPct, fmtHrs as fmtH } from '@/lib/format'
// FIXES §0rr (2026-04-28): swapped AiSchedulePanel for AiHoursReductionMap
// — the new hours-first layout with the labour-ratio hero + Open
// Personalkollen action card. Old AiSchedulePanel.tsx is kept on disk
// for one cycle in case rollback is needed; can be deleted in a
// follow-up if the new layout sticks.
import AiHoursReductionMap from '@/components/scheduling/AiHoursReductionMap'
import WeekGridView        from '@/components/scheduling/WeekGridView'
import { computeWeekStats } from '@/components/scheduling/computeWeekStats'

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
// Labels/hints are read from translations at render time; this map keeps colours only.
const STATUS_COLOURS: Record<string, any> = {
  lean:        { bg: '#f0fdf4', border: '#bbf7d0', dot: '#15803d', text: '#15803d' },
  on_target:   { bg: '#eff6ff', border: '#bfdbfe', dot: '#2563eb', text: '#2563eb' },
  overstaffed: { bg: '#fffbeb', border: '#fde68a', dot: '#d97706', text: '#d97706' },
  no_data:     { bg: '#f9fafb', border: '#e5e7eb', dot: '#9ca3af', text: '#9ca3af' },
}

// Map API status → UI status
const mapStatus = (s: string) =>
  s === 'understaffed' ? 'lean'
  : s === 'efficient'  ? 'on_target'
  : s === 'overstaffed'? 'overstaffed'
  : 'no_data'

export default function SchedulingPage() {
  const t        = useTranslations('scheduling')
  const tCommon  = useTranslations('common')
  const monthsLocal   = (tCommon.raw('time.monthsShort') as string[]) ?? MONTHS
  const weekdaysLocal = (tCommon.raw('time.weekdays')    as string[]) ?? WEEKDAY_NAMES
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

  // AI-suggested schedule — independent of the view selector because the
  // suggestion always targets a forward-looking window regardless of
  // whether the user is looking at this month or last week.
  //
  // aiRange lets the owner pick how far ahead to look. Default is next
  // week (the common case); 2 / 4 weeks and next month support the
  // "nobody changes a schedule mid-week — I want to see what's ahead"
  // workflow Paul flagged 2026-04-23.
  const [aiSched,      setAiSched]      = useState<any>(null)
  const [aiLoading,    setAiLoading]    = useState(false)
  const [aiError,      setAiError]      = useState('')
  const [aiRange,      setAiRange]      = useState<'this_week'|'next_week'|'2w'|'4w'|'next_month'>('next_week')

  // View toggle: "grid" = new three-row WeekGridView (default), "list" =
  // existing AiHoursReductionMap. Persists per session so reload doesn't
  // bounce the user back to grid mid-investigation.
  // Named `gridView` to avoid collision with the existing `viewMode`
  // (week/month) state used elsewhere on the page.
  const [gridView,     setGridView]     = useState<'grid'|'list'>(() => {
    if (typeof window === 'undefined') return 'grid'
    try { return (sessionStorage.getItem('cc_scheduling_view') as any) === 'list' ? 'list' : 'grid' } catch { return 'grid' }
  })
  useEffect(() => {
    try { sessionStorage.setItem('cc_scheduling_view', gridView) } catch {}
  }, [gridView])

  // target_staff_pct comes from businesses.target_staff_pct (DECIMAL, default
  // 35-40 depending on read path). Default 30 if missing — matches the mockup
  // and the conventional restaurant operating target.
  const [targetPct,    setTargetPct]    = useState<number>(30)
  useEffect(() => {
    if (!selectedBiz) return
    fetch('/api/businesses', { cache: 'no-store' })
      .then(r => r.json())
      .then((data: any[]) => {
        if (!Array.isArray(data)) return
        const biz = data.find(b => b.id === selectedBiz)
        const tp  = Number(biz?.target_staff_pct)
        if (Number.isFinite(tp) && tp > 0) setTargetPct(tp)
      })
      .catch(() => { /* keep default */ })
  }, [selectedBiz])

  // (Observations + historical scorecard expanders were removed per
  // SCHEDULING-FIX §§ 3, 5 — hero + always-visible by-day grid cover
  // what those used to.)

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
  // Re-format the bounds-helper label with localised month names so the
  // drill-down modal shows e.g. "Måndagar i Maj 2026" in Swedish.
  const localiseLabel = (raw: string) => {
    let out = raw
    MONTHS.forEach((m, i) => { out = out.replace(new RegExp(`\\b${m}\\b`, 'g'), monthsLocal[i]) })
    return out
  }
  const periodLabel = viewMode === 'week'
    ? `Week ${(curr as any).weekNum} · ${localiseLabel(curr.label)}`
    : localiseLabel(curr.label)
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

  // Compute from/to for the AI range picker. Forward ranges anchor on the
  // COMING Monday; 'This week' anchors on the CURRENT ISO week's Monday so
  // the operator can see how today + the rest of this week compare against
  // the 12-week pattern (useful mid-week for last-minute trim decisions).
  const aiBounds = (() => {
    const now = new Date()
    // Current ISO week's Monday (Mon = 1..Sun = 0 → treat Sun as 7).
    const dow = now.getDay() === 0 ? 7 : now.getDay()
    const thisMon = new Date(now); thisMon.setDate(now.getDate() - (dow - 1)); thisMon.setHours(0,0,0,0)
    const thisSun = new Date(thisMon); thisSun.setDate(thisMon.getDate() + 6)
    // Next Monday = thisMon + 7 days.
    const nextMon = new Date(thisMon); nextMon.setDate(thisMon.getDate() + 7)

    let end: Date
    let label: string
    switch (aiRange) {
      case 'this_week': {
        return { from: localDate(thisMon), to: localDate(thisSun), label: t('ranges.labelThisWeek') }
      }
      case '2w': {
        end = new Date(nextMon); end.setDate(nextMon.getDate() + 13)
        label = t('ranges.label2w')
        break
      }
      case '4w': {
        end = new Date(nextMon); end.setDate(nextMon.getDate() + 27)
        label = t('ranges.label4w')
        break
      }
      case 'next_month': {
        // First day of the month AFTER nextMon's month → last day of that month
        const y = nextMon.getFullYear(), m = nextMon.getMonth() + 1
        const start = new Date(y, m, 1)
        end = new Date(y, m + 1, 0)
        label = t('ranges.labelNextMonth')
        return { from: localDate(start), to: localDate(end), label }
      }
      case 'next_week':
      default: {
        end = new Date(nextMon); end.setDate(nextMon.getDate() + 6)
        label = t('ranges.labelNextWeek')
        break
      }
    }
    return { from: localDate(nextMon), to: localDate(end), label }
  })()

  useEffect(() => {
    if (!selectedBiz) return
    let cancelled = false
    setAiLoading(true); setAiError('')
    const qs = `business_id=${selectedBiz}&from=${aiBounds.from}&to=${aiBounds.to}`
    fetch(`/api/scheduling/ai-suggestion?${qs}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (!cancelled) { if (j.error) setAiError(j.error); else setAiSched(j) } })
      .catch(e => { if (!cancelled) setAiError(e.message) })
      .finally(() => { if (!cancelled) setAiLoading(false) })
    return () => { cancelled = true }
  }, [selectedBiz, aiRange])

  // ─── Accepted rows (persisted) ─────────────────────────────────────────
  // Map of 'YYYY-MM-DD' → { batch_id, ai_hours, ... }. Empty when nothing
  // has been accepted. Drives "Accepted ✓" state, hero recomputation, and
  // the "Undo all" window.
  const [acceptances, setAcceptances] = useState<Record<string, any>>({})
  const [lastBatch,   setLastBatch]   = useState<{ batch_id: string; at: number } | null>(null)

  async function loadAcceptances() {
    if (!selectedBiz) return
    try {
      const r = await fetch(`/api/scheduling/acceptances?business_id=${selectedBiz}&from=${aiBounds.from}&to=${aiBounds.to}`, { cache: 'no-store' })
      const j = await r.json()
      if (r.ok) {
        const map: Record<string, any> = {}
        for (const row of (j.rows ?? [])) map[row.date] = row
        setAcceptances(map)
      }
    } catch { /* non-fatal */ }
  }
  useEffect(() => { loadAcceptances() }, [selectedBiz, aiRange, aiBounds.from, aiBounds.to])

  async function acceptDay(row: { date: string; ai_hours: number; ai_cost_kr: number; current_hours: number; current_cost_kr: number; est_revenue_kr: number | null }) {
    // Optimistic local update so the UI feels instant.
    setAcceptances(prev => ({ ...prev, [row.date]: { ...row, decided_at: new Date().toISOString() } }))
    try {
      const r = await fetch('/api/scheduling/accept-day', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ business_id: selectedBiz, ...row }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? 'accept failed')
    } catch (e: any) {
      // Revert on error.
      setAcceptances(prev => { const next = { ...prev }; delete next[row.date]; return next })
      alert(`Couldn't save: ${e.message}`)
    }
  }

  async function undoDay(date: string) {
    setAcceptances(prev => { const next = { ...prev }; delete next[date]; return next })
    try {
      await fetch(`/api/scheduling/accept-day?business_id=${selectedBiz}&date=${date}`, { method: 'DELETE' })
    } catch { /* UI already reverted */ }
  }

  async function acceptAll(rows: Array<any>) {
    const payload = rows.map(r => ({
      date:            r.date,
      ai_hours:        r.ai_hours,
      ai_cost_kr:      r.ai_cost_kr,
      current_hours:   r.current_hours,
      current_cost_kr: r.current_cost_kr,
      est_revenue_kr:  r.est_revenue_kr,
    }))
    // Optimistic: flip them all locally.
    const optimistic: Record<string, any> = { ...acceptances }
    for (const r of rows) optimistic[r.date] = { ...r, decided_at: new Date().toISOString() }
    setAcceptances(optimistic)

    try {
      const r = await fetch('/api/scheduling/accept-all', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ business_id: selectedBiz, rows: payload }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'accept-all failed')
      setLastBatch({ batch_id: j.batch_id, at: Date.now() })
      // Clear the undo window after 10 s.
      setTimeout(() => setLastBatch(curr => (curr && Date.now() - curr.at >= 10_000) ? null : curr), 10_500)
    } catch (e: any) {
      // Revert everything from this batch locally.
      setAcceptances(acceptances)
      alert(`Couldn't apply all: ${e.message}`)
    }
  }

  async function undoBatch() {
    if (!lastBatch) return
    const batchId = lastBatch.batch_id
    setLastBatch(null)
    // Reload from server after undo; cheaper than replaying local diffs.
    try {
      await fetch(`/api/scheduling/accept-all?business_id=${selectedBiz}&batch_id=${batchId}`, { method: 'DELETE' })
    } finally {
      loadAcceptances()
    }
  }

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

        {/* Period nav + W/M toggle removed 2026-04-23. The scheduling
            page is now forward-looking only — the AI panel's own range
            picker (Next week / 2 weeks / 4 weeks / Next month) is the
            sole period control. The historical /api/scheduling fetch
            still runs with the default current-month window for the
            AskAI context + "no joined data yet" guard. */}
        <TopBar
          crumbs={[
            { label: t('crumb.operations') },
            { label: t('crumb.scheduling'), active: true },
          ]}
        />

        {/* SchPageHero removed 2026-04-23 — the new AI schedule panel's
            hero + saving strip cover the same information, so leaving
            both created a duplicate "saving N kr" headline. */}

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '14px 18px', marginBottom: 20, fontSize: 13, color: '#dc2626' }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ padding: 60, textAlign: 'center' as const, color: '#9ca3af' }}>{t('loading')}</div>
        ) : !hasData ? (
          <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: 48, textAlign: 'center' as const }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#111', marginBottom: 8 }}>{t('noJoinedData.title')}</div>
            <div style={{ fontSize: 13, color: '#9ca3af', maxWidth: 380, margin: '0 auto' }}>
              {t('noJoinedData.body')}
            </div>
          </div>
        ) : (
          <>

            {/* By-day-of-week overview card removed 2026-04-23 — the new
                AI schedule panel below carries the same per-day info with
                tier pills + accept controls. The drill-down modal still
                works (triggered from inside the AI panel's day rows). */}

            {/* ═══════════════════════════════════════════════════════
                AI-SUGGESTED SCHEDULE
                Section label + range picker + headline + ready card +
                info banner + view toggle, then the chosen view, then a
                rationale + signals footer. Visual spec lives at
                scheduling-page-v4.html.
            ═══════════════════════════════════════════════════════ */}
            <AiRangePicker value={aiRange} onChange={setAiRange} label={aiBounds.label} />

            <SchedulingHeader
              data={aiSched}
              targetPct={targetPct}
              acceptances={acceptances}
              rangeLabel={aiBounds.label}
              viewMode={gridView}
              onViewModeChange={setGridView}
              onAcceptAll={acceptAll}
              t={t}
              tCommon={tCommon}
            />

            {gridView === 'grid' ? (
              <WeekGridView
                loading={aiLoading}
                error={aiError}
                data={aiSched}
                rangeLabel={aiBounds.label}
                acceptances={acceptances}
                onAcceptDay={acceptDay}
                fmt={fmtKr}
                fmtHrs={fmtH}
              />
            ) : (
              <AiHoursReductionMap
                loading={aiLoading}
                error={aiError}
                data={aiSched}
                rangeLabel={aiBounds.label}
                acceptances={acceptances}
                onAcceptAll={acceptAll}
                fmt={fmtKr}
                fmtHrs={fmtH}
              />
            )}

            <SchedulingFooter targetPct={targetPct} t={t} />

            {/* ═══════════════════════════════════════════════════════
                Observations — removed from the page.
                SCHEDULING-FIX § 5 called the collapsed "Weekly AI
                observations" row "dead UI" (click didn't do anything
                visible). The hero already carries the actionable insight.
                The per-period AI recommendation feature can return as a
                help-icon popover once the feature ships as promised.
            ═══════════════════════════════════════════════════════ */}
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
                  {t('drill.headerEyebrow', { day: weekdaysLocal[drillDay], period: periodLabel })}
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#111' }}>
                  {drillLoading ? t('drill.loading')
                    : drillData?.error ? t('drill.error')
                    : drillData ? t('drill.totalsRevLabour', {
                        rev: fmtKr(drillData.totals.revenue),
                        labour: fmtKr(drillData.totals.cost),
                        ratePerHour: drillData.totals.rev_per_hour
                          ? fmtKr(drillData.totals.rev_per_hour) + '/hr'
                          : t('drill.ratePerHourMissing'),
                      })
                    : ''}
                </div>
                {!drillLoading && drillData && !drillData.error && (
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                    {t('drill.subEyebrow', {
                      count: drillData.dates.length,
                      staff: drillData.totals.staff_count,
                      shifts: drillData.totals.shifts,
                      hours: fmtH(drillData.totals.hours),
                    })}
                  </div>
                )}
              </div>
              <button onClick={() => setDrillDay(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#9ca3af', lineHeight: 1 }}>×</button>
            </div>

            {/* Body */}
            <div style={{ overflowY: 'auto', flex: 1, padding: '14px 24px 18px' }}>
              {drillLoading ? (
                <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 13 }}>{t('drill.loadingDay')}</div>
              ) : drillData?.error ? (
                <div style={{ fontSize: 13, color: '#dc2626' }}>{drillData.error}</div>
              ) : drillData && drillData.dates.length > 0 ? (
                <>
                  {/* Per-date rows */}
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 8 }}>{t('drill.byDate')}</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 20 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                        {[
                          { key: 'date',     label: t('drill.th.date') },
                          { key: 'revenue',  label: t('drill.th.revenue') },
                          { key: 'labour',   label: t('drill.th.labour') },
                          { key: 'hours',    label: t('drill.th.hours') },
                          { key: 'staff',    label: t('drill.th.staff') },
                          { key: 'revPerHr', label: t('drill.th.revPerHr') },
                        ].map(h => (
                          <th key={h.key} style={{ padding: '6px 8px', textAlign: h.key === 'date' ? 'left' : 'right', fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: '.06em' }}>{h.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {drillData.dates.map((d: any) => {
                        const dt = new Date(d.date)
                        const dateStr = `${dt.getDate()} ${monthsLocal[dt.getMonth()]}`
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
                    {t('drill.whoWorked', { count: drillData.staff.length })}
                  </div>
                  {drillData.staff.length === 0 ? (
                    <div style={{ fontSize: 12, color: '#9ca3af', padding: '8px 0' }}>{t('drill.noStaffShifts')}</div>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                          {[
                            { key: 'name',       label: t('drill.th.name'),       align: 'left'  },
                            { key: 'department', label: t('drill.th.department'), align: 'left'  },
                            { key: 'shifts',     label: t('drill.th.shifts'),     align: 'right' },
                            { key: 'hours',      label: t('drill.th.hours'),      align: 'right' },
                            { key: 'cost',       label: t('drill.th.cost'),       align: 'right' },
                            { key: 'costPerHr',  label: t('drill.th.costPerHr'),  align: 'right' },
                          ].map(h => (
                            <th key={h.key} style={{ padding: '6px 8px', textAlign: h.align as any, fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: '.06em' }}>{h.label}</th>
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
                <div style={{ fontSize: 13, color: '#9ca3af', padding: '20px 0' }}>{t('drill.noDataForDay', { day: weekdaysLocal[drillDay] })}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Contextual AI — updated wording to match new terminology */}
      {/*
        FIXES §0jj (2026-04-27): when the displayed period is forward-
        looking (Week 18 selected before any of those days have happened),
        every actual is 0. Sending `Total revenue: 0 kr` etc. to the AI
        used to make Claude anchor on those zeros and reply "no data
        available" — even though the contextBuilder enrichments
        (forecast, schedule, trend) had injected the right numbers.
        Fix: when the period has zero days of actuals AND the date range
        is in the future, send an explicit "future period" preamble
        instead of zero-valued summary lines. The enrichments handle the
        rest.
      */}
      <AskAI
        page="scheduling"
        context={(() => {
          if (!summary) return 'No scheduling data loaded yet'
          const isFuturePeriod =
            (summary.days_analyzed ?? 0) === 0 &&
            (summary.total_revenue ?? 0) === 0 &&
            fromDate >= new Date().toISOString().slice(0, 10)
          if (isFuturePeriod) {
            return [
              `Period: ${fromDate} to ${toDate} (FUTURE PERIOD — has not happened yet)`,
              `Labour cost target: ${labourTarget}%`,
              `[INSTRUCTION TO CLAUDE: zero actuals are EXPECTED for a future period — do NOT respond "no data". Use the forecast/schedule/trend blocks below to predict and recommend. The user wants forward-looking advice.]`,
            ].join('\n')
          }
          return [
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
          ].filter(Boolean).join('\n')
        })()}
      />
    </AppShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// AI-suggested schedule card — renders inline below the past-week analysis.
// Cuts-only: delta is always ≤0, days the model would have added show as a
// soft "note" row with no numeric recommendation.
// ─────────────────────────────────────────────────────────────────────────────
function AiRangePicker({ value, onChange, label }: { value: string; onChange: (v: any) => void; label: string }) {
  const t = useTranslations('scheduling.ranges')
  const opts: Array<{ value: 'this_week'|'next_week'|'2w'|'4w'|'next_month'; label: string }> = [
    { value: 'this_week',  label: t('this_week') },
    { value: 'next_week',  label: t('next_week') },
    { value: '2w',         label: t('2w') },
    { value: '4w',         label: t('4w') },
    { value: 'next_month', label: t('next_month') },
  ]
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' as const, gap: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' as const, color: '#9ca3af' }}>
        {t('title')} · {label}
      </div>
      <div style={{ display: 'inline-flex', gap: 4, padding: 3, background: '#f3f4f6', borderRadius: 8 }}>
        {opts.map(o => {
          const active = value === o.value
          return (
            <button
              key={o.value}
              onClick={() => onChange(o.value)}
              style={{
                padding:    '5px 10px',
                fontSize:   11,
                fontWeight: active ? 700 : 500,
                color:      active ? '#111'    : '#6b7280',
                background: active ? 'white'   : 'transparent',
                border:     active ? '0.5px solid #e5e7eb' : '0.5px solid transparent',
                borderRadius: 6,
                cursor:     'pointer',
                boxShadow:  active ? '0 1px 2px rgba(0,0,0,.06)' : 'none',
                whiteSpace: 'nowrap' as const,
              }}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}


// SchSegmentedToggle + schNavBtn removed along with the historical
// period nav on 2026-04-23.

// ────────────────────────────────────────────────────────────────────
//   SchedulingHeader — page-level chrome above the toggleable view.
//   Headline labour-% card, "ready to implement" CTA, info banner,
//   day-header + legend, view toggle. All values computed from the
//   /api/scheduling/ai-suggestion payload via computeWeekStats.
// ────────────────────────────────────────────────────────────────────

function SchedulingHeader({
  data, targetPct, acceptances, rangeLabel, viewMode, onViewModeChange, onAcceptAll, t, tCommon,
}: {
  data:             any
  targetPct:        number
  acceptances:      Record<string, any>
  rangeLabel:       string
  viewMode:         'grid' | 'list'
  onViewModeChange: (v: 'grid' | 'list') => void
  onAcceptAll:      (rows: any[]) => Promise<void> | void
  t:                (key: string, vars?: any) => string
  tCommon:          (key: string, vars?: any) => string
}) {
  const stats = useMemo(() => {
    if (!data?.current?.length) return null
    return computeWeekStats({
      current:     data.current,
      suggested:   data.suggested ?? [],
      summary:     data.summary  ?? { saving_kr: 0, current_hours: 0, suggested_hours: 0 },
      acceptances,
    })
  }, [data, acceptances])

  if (!stats) return null

  const greenReady = stats.rows.filter(r => r.status === 'green' && !r.isAccepted)
  const pctCur     = stats.weekLabourPctCurrent
  const pctProj    = stats.weekLabourPctProjected
  const aboveTarget = pctCur != null && pctCur > targetPct
  const readyDayLabels = greenReady.map(r => {
    const wd = r.weekday ?? new Date(r.date).toLocaleDateString('en-GB', { weekday: 'short' })
    return `${wd} ${fmtSignedHrs(-r.deltaHours)}`
  }).join(' · ')

  return (
    <>
      <div style={{ fontSize: 11, color: '#8d8f86', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 500, marginBottom: 12, marginTop: 8 }}>
        {t('weekHeader.eyebrow', { range: rangeLabel })}
      </div>

      {/* Headline labour-% impact card */}
      <div style={cardGreenStripe}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.6fr auto auto auto', gap: 32, alignItems: 'center' }}>
          <div>
            <div style={metaLabel}>{t('weekHeader.headline.label')}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
              <span style={{ fontSize: 40, fontWeight: 700, color: aboveTarget ? '#b8412e' : '#11140f', letterSpacing: '-0.02em', lineHeight: 1 }}>
                {pctCur != null ? `${Math.round(pctCur)}%` : '—'}
              </span>
              <span style={{ fontSize: 22, color: '#8d8f86', fontWeight: 300 }}>→</span>
              <span style={{ fontSize: 40, fontWeight: 700, color: '#0f7a3e', letterSpacing: '-0.02em', lineHeight: 1 }}>
                {pctProj != null ? `${Math.round(pctProj)}%` : '—'}
              </span>
              <span style={{ fontSize: 13, color: '#5e6058', fontWeight: 500, marginLeft: 6 }}>{t('weekHeader.headline.ofRevenue')}</span>
            </div>
            <div style={{ fontSize: 13, color: '#5e6058', marginTop: 8 }}>
              {t('weekHeader.headline.statesLine', { count: greenReady.length })}
            </div>
          </div>
          <Stat label={t('weekHeader.stat.saves')} value={fmtKr(stats.weekSavingsKr)} sub={t('weekHeader.stat.savesSub')} valueColor="#0f7a3e" />
          <Stat label={t('weekHeader.stat.hoursCut')} value={fmtSignedHrs(stats.weekHoursCut)} sub={t('weekHeader.stat.hoursCutSub', { count: greenReady.length })} valueColor="#0f7a3e" />
          <Stat
            label={t('weekHeader.stat.days')}
            value={t('weekHeader.stat.daysValue', { ready: stats.daysReadyCount, amber: stats.daysAmberCount })}
            sub={t('weekHeader.stat.daysSub', { count: stats.daysUnchangedCount })}
            valueColor="#11140f"
          />
        </div>
      </div>

      {/* Ready-to-implement card. Renders only when there ARE green ready
          rows; otherwise hidden so we don't show an "Open PK" CTA on a
          quiet week. */}
      {greenReady.length > 0 && (
        <div style={cardGreenStripe}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 24, alignItems: 'center' }}>
            <div>
              <div style={metaLabel}>{t('weekHeader.ready.label')}</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: '#11140f', marginBottom: 4, lineHeight: 1.3 }}>
                {t('weekHeader.ready.headline', { count: greenReady.length })}{' · '}
                <span style={{ color: '#0f7a3e', fontWeight: 700 }}>{t('weekHeader.ready.savePrefix', { amount: fmtKr(stats.weekSavingsKr) })}</span>
              </div>
              <div style={{ fontSize: 13, color: '#5e6058' }}>{readyDayLabels}</div>
            </div>
            <a
              href="https://app.personalkollen.se/"
              target="_blank"
              rel="noopener noreferrer"
              style={btnPrimaryLink}
            >
              {t('weekHeader.ready.openPk')} ↗
            </a>
          </div>
        </div>
      )}

      {/* Info banner — daily-vs-weekly framing */}
      <div style={infoBanner}>
        <div style={infoBannerIcon}>i</div>
        <span>
          <strong style={{ color: '#3a6f9a', fontWeight: 600 }}>{t('weekHeader.banner.strong')}</strong>{' '}
          {t('weekHeader.banner.body')}
        </span>
      </div>

      {/* Day-header + legend */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '20px 0 10px' }}>
        <div style={{ fontSize: 11, color: '#8d8f86', textTransform: 'uppercase' as const, letterSpacing: '0.08em', fontWeight: 500 }}>
          {t('weekHeader.dayHeaderTitle', { range: rangeLabel })}
        </div>
        <div style={{ display: 'flex', gap: 18, fontSize: 12, color: '#5e6058' }}>
          <LegendDot color="#0f7a3e" label={t('weekHeader.legend.ready', { count: stats.daysReadyCount })} />
          <LegendDot color="#c46a18" label={t('weekHeader.legend.amber', { count: stats.daysAmberCount })} />
          <LegendDot color="#b6b8af" label={t('weekHeader.legend.unchanged', { count: stats.daysUnchangedCount })} />
        </div>
      </div>

      {/* View toggle */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <ToggleButton active={viewMode === 'grid'} onClick={() => onViewModeChange('grid')}>
          {t('weekHeader.toggle.grid')}
        </ToggleButton>
        <ToggleButton active={viewMode === 'list'} onClick={() => onViewModeChange('list')}>
          {t('weekHeader.toggle.list')}
        </ToggleButton>
      </div>
    </>
  )
}

// ────────────────────────────────────────────────────────────────────
//   SchedulingFooter — rationale + signals row, always at the bottom.
// ────────────────────────────────────────────────────────────────────

function SchedulingFooter({ targetPct, t }: {
  targetPct: number
  t:         (key: string, vars?: any) => string
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16, marginTop: 18, marginBottom: 24 }}>
      <div style={{ background: 'white', border: '1px solid #dcddd6', borderRadius: 10, padding: '20px 24px' }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: '#11140f', marginBottom: 12 }}>{t('footer.rationale.title')}</h3>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: '#2c2e28' }}>
          <p style={{ marginBottom: 12 }}>
            <strong style={{ color: '#11140f' }}>{t('footer.rationale.p1Strong')}</strong>{' '}
            {t('footer.rationale.p1Body')}
          </p>
          <p>
            <strong style={{ color: '#11140f' }}>{t('footer.rationale.p2Strong')}</strong>{' '}
            {t('footer.rationale.p2Body', { target: Math.round(targetPct) })}
          </p>
        </div>
      </div>

      <div style={{ background: 'white', border: '1px solid #dcddd6', borderRadius: 10, padding: '20px 24px' }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, color: '#11140f', marginBottom: 12 }}>{t('footer.signals.title')}</h3>
        {[
          { name: t('footer.signals.historicalRevenue.name'), value: t('footer.signals.historicalRevenue.value') },
          { name: t('footer.signals.weatherForecast.name'),   value: t('footer.signals.weatherForecast.value') },
          { name: t('footer.signals.scheduleLive.name'),       value: t('footer.signals.scheduleLive.value') },
          { name: t('footer.signals.paceBaseline.name'),       value: t('footer.signals.paceBaseline.value') },
          { name: t('footer.signals.holidayGate.name'),        value: t('footer.signals.holidayGate.value') },
        ].map(s => (
          <div key={s.name} style={{ display: 'grid', gridTemplateColumns: '1fr auto', padding: '8px 0', borderBottom: '1px solid #f0f0eb', fontSize: 12 }}>
            <span style={{ color: '#5e6058' }}>{s.name}</span>
            <span style={{ color: '#11140f', fontWeight: 500 }}>{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Sub-components for the header ───────────────────────────────────

function Stat({ label, value, sub, valueColor }: {
  label: string; value: string; sub?: string; valueColor?: string
}) {
  return (
    <div style={{ borderLeft: '1px solid #e8e8e2', paddingLeft: 26 }}>
      <div style={metaLabel}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: valueColor ?? '#11140f', letterSpacing: '-0.015em', lineHeight: 1 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 12, color: '#5e6058', marginTop: 6 }}>{sub}</div>}
    </div>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
      <span>{label}</span>
    </div>
  )
}

function ToggleButton({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background:    active ? '#11140f' : 'white',
        color:         active ? '#fbfbf9' : '#2c2e28',
        border:        '1px solid ' + (active ? '#11140f' : '#dcddd6'),
        padding:       '8px 16px',
        borderRadius:  100,
        fontSize:      13,
        fontWeight:    500,
        cursor:        'pointer',
        fontFamily:    'inherit',
        transition:    'all 0.15s',
      }}
    >
      {children}
    </button>
  )
}

// ── Style tokens used by this header (kept inline; tokens.ts equivalents
//    don't fully cover the v4 mockup colour palette). ─────────────────────

const cardGreenStripe: React.CSSProperties = {
  background:   'white',
  border:       '1px solid #dcddd6',
  borderLeft:   '4px solid #0f7a3e',
  borderRadius: 10,
  padding:      '20px 24px',
  marginBottom: 14,
}

const metaLabel: React.CSSProperties = {
  fontSize:      11,
  color:         '#8d8f86',
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
  fontWeight:    500,
  marginBottom:  8,
}

const infoBanner: React.CSSProperties = {
  background:   '#ebf2f8',
  border:       '1px solid #cfdce9',
  borderRadius: 8,
  padding:      '12px 16px',
  margin:       '20px 0 0',
  display:      'flex',
  alignItems:   'center',
  gap:          12,
  fontSize:     13,
  color:        '#3a6f9a',
}
const infoBannerIcon: React.CSSProperties = {
  width:        18,
  height:       18,
  background:   '#3a6f9a',
  color:        '#fff',
  borderRadius: '50%',
  display:      'grid',
  placeItems:   'center',
  fontSize:     11,
  fontWeight:   700,
  flexShrink:   0,
}
const btnPrimaryLink: React.CSSProperties = {
  background:     '#0f7a3e',
  color:          '#fff',
  border:         'none',
  padding:        '12px 22px',
  borderRadius:   100,
  fontSize:       14,
  fontWeight:     600,
  cursor:         'pointer',
  display:        'inline-flex',
  alignItems:     'center',
  gap:            8,
  fontFamily:     'inherit',
  textDecoration: 'none' as const,
}

function fmtSignedHrs(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) < 0.05) return '0h'
  const sign = n < 0 ? '−' : '+'
  return `${sign}${Math.abs(n).toFixed(1)}h`
}
