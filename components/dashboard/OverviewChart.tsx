// @ts-nocheck
'use client'
// components/dashboard/OverviewChart.tsx
//
// Interactive daily-performance chart for the dashboard overview. Replaces
// the old RevenueMarginChart. Hosts its own controls (period dropdown, W/M
// toggle, day-filter calendar, compare toggle) + KPI strip + SVG chart with
// bars for revenue/labour, a gross-margin line, and optional forecast
// whiskers for the selected compare target (Prev / AI).
//
// Data contract is unchanged — parent still fetches daily_metrics +
// ai-suggestion and passes DayRow[]. Filter + compare state is optionally
// controlled from the parent so /dashboard can sync them to URL query
// params; uncontrolled fallback keeps the component usable on its own.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

// ─── Types ───────────────────────────────────────────────────────────────────
interface DayRow {
  date:       string
  revenue:    number
  staff_cost: number
  staff_pct:  number | null
  dateStr:    string
  dayName:    string
  dayIdx?:    number
  isToday:    boolean
  isFuture:   boolean
  // FIXES §0xx: hasActualData = a daily_metrics row exists for this date.
  // isClosed = past day with no row (restaurant closed). Set by parent.
  hasActualData?: boolean
  isClosed?:    boolean
  pred: {
    est_revenue:  number
    planned_cost: number
    ai_cost:      number
    delta_cost:   number
    weather?: any
    bucket_days:  number
    under_staffed_note: boolean
  } | null
  // Optional — parent may supply matching day from the previous period so
  // compare=Prev can draw whiskers + deltas. Missing → no per-day prev data.
  prevDay?: { revenue: number; staff_cost: number } | null
}

export interface PeriodOption {
  key:      string
  label:    string
  view:     'week' | 'month'
  dateFrom: string
  dateTo:   string
}

export interface OverviewChartProps {
  days:             DayRow[]
  viewMode:         'week' | 'month'
  onViewModeChange?: (m: 'week' | 'month') => void
  periodLabel:      string
  businessName:     string
  targetLabourPct?: number
  availablePeriods?: PeriodOption[]
  onPeriodChange?:   (key: string) => void
  onDayClick?:       (day: DayRow) => void

  // Optional controlled filter + compare state. URL-param sync in the parent
  // passes these; unspecified = component manages its own local state.
  selectedDates?:          string[]
  onSelectedDatesChange?:  (next: string[]) => void
  compareMode?:            'none' | 'prev' | 'ai'
  onCompareChange?:        (m: 'none' | 'prev' | 'ai') => void

  fmtKr:  (n: number) => string
  fmtPct: (n: number) => string

  // Optional: dates the parent has identified as public/observed
  // holidays. The X-axis day labels for these dates render in red so
  // owners can visually spot upcoming holidays alongside weekends.
  // Source: lib/holidays/getUpcomingHolidays(country, ...). Pass an
  // empty Set or omit to disable. Works the same for SE today; nb/gb
  // pick it up automatically once their holiday modules land.
  holidayDates?: Set<string>

  // v7 redesign: optional inline anomaly callout. When the parent has
  // an active high/critical alert mapping to a date in the visible
  // range, the chart paints a soft dot+connector+label near that day's
  // labour bar. Title is the detector's deterministic format
  // ("OB supplement spike +X% — {bizName}"); description is the
  // Haiku-rewritten subtitle. Strictly additive — passing nothing keeps
  // the chart's pre-v7 behaviour unchanged.
  anomalyCallout?: {
    date:        string
    title:       string
    description?: string | null
  } | null
}

// Per-day labour ratio tier classifier. Green ≤ targetPct, amber within
// +5pp, red beyond. Returns the colour AND a soft variant for the
// matching predicted-labour fill.
function labourTier(staffPct: number | null | undefined, targetPct: number): {
  ink: string
  predFill: string
  tier: 'good' | 'amber' | 'red'
} {
  const pct = typeof staffPct === 'number' ? staffPct : null
  // Unknown defaults to amber — visually neutral. The page hides bars
  // that have no data via the no-data path, so this is rare.
  if (pct == null || !Number.isFinite(pct)) {
    return { ink: C.tierAmber, predFill: C.predLabAmber, tier: 'amber' }
  }
  if (pct <= targetPct) return { ink: C.tierGood,  predFill: C.predLabGood,  tier: 'good' }
  if (pct <= targetPct + 5) return { ink: C.tierAmber, predFill: C.predLabAmber, tier: 'amber' }
  return { ink: C.tierRed, predFill: C.predLabRed, tier: 'red' }
}

// ─── Tokens ──────────────────────────────────────────────────────────────────
const C = {
  rev:       '#1a1d18',   // refined ink — matches v7 mockup
  revBg:     'rgba(26,29,24,0.28)',
  revAccent: '#6366f1',
  lab:       '#c2410c',
  labBg:     'rgba(194,65,12,0.28)',
  mar:       '#0f7a3e',   // gross margin (actual) — solid green, the truth
  marAi:     '#5e6058',   // AI forecast — dashed neutral grey, the projection
  axis:      '#dcddd6',   // slightly darker baseline
  axisGrid:  '#f0f0eb',   // very faint horizontal-only gridlines
  axisInk:   '#b6b8af',   // lighter y-axis labels
  axisInk2:  '#8d8f86',
  ttBg:      '#0a0e1a',
  ttMute:    'rgba(255,255,255,0.55)',
  goodGreen: '#86efac',
  badRed:    '#fca5a5',
  // v7 modernization: tier colours for labour bars based on
  // (labour_cost / revenue) vs targetLabourPct. Green ≤ target,
  // amber within +5pp, red beyond.
  tierGood:  '#3d8a5a',
  tierAmber: '#c98847',
  tierRed:   '#b8412e',
  // Predicted-revenue bar fill — soft solid (no diagonal stripes per v7).
  // Indigo-grey so it reads as "tentative / forecast" against the dark
  // actuals. Subtle border keeps it visible on white.
  predRev:   '#dde6ee',
  predRevBorder: '#c4d2dc',
  // Predicted-labour soft fills — tier-coloured, lower saturation than
  // the actuals so forecasts fade.
  predLabGood:  '#cae3d2',
  predLabAmber: '#f0d4ad',
  predLabRed:   '#e8c5be',
  // Predicted-revenue bar fill: legacy-compat names retained because
  // some helpers still reference them while the chart transitions.
  predFill1: '#c7d2fe',
  predFill2: '#e0e7ff',
  predBorder:'#a5b4fc',   // soft outline to separate from white bg
}

// Chart geometry — viewBox is fixed, width scales with container.
const VB_W    = 660
const VB_H    = 320
const PAD_T   = 18
const PAD_R   = 14
const PAD_B   = 48
const PAD_L   = 52
const PLOT_W  = VB_W - PAD_L - PAD_R
const PLOT_H  = VB_H - PAD_T - PAD_B

// ─── Helpers ─────────────────────────────────────────────────────────────────
function weatherIconLocal(code?: number): string {
  if (code == null) return ''
  if (code === 0)                 return '☀️'
  if (code <= 3)                  return '⛅'
  if (code === 45 || code === 48) return '🌫️'
  if (code >= 51 && code <= 57)   return '🌦️'
  if (code >= 61 && code <= 67)   return '🌧️'
  if (code >= 71 && code <= 77)   return '❄️'
  if (code >= 80 && code <= 82)   return '🌦️'
  if (code >= 85 && code <= 86)   return '🌨️'
  if (code >= 95)                 return '⛈️'
  return ''
}

// effective AI cost — respects the "cuts only" policy (never recommend adding)
function effectiveAiCost(d: DayRow): number {
  if (!d.pred) return 0
  return d.pred.under_staffed_note ? d.pred.planned_cost : d.pred.ai_cost
}

// Per-day margin value used for the line. Null = break.
// FIXES §0xx: handle CLOSED days explicitly. Pre-fix this only checked
// `revenue > 0` and fell through to predicted on any zero-revenue day —
// closed past days inherited the AI forecast (~100k phantom gross).
//
// Order matters:
//   1. Closed past day → 0 (real, draws line at zero)
//   2. Day has actual data → real gross (revenue - staff_cost)
//   3. Day has prediction → predicted gross (drawn dashed via dayMarginKind)
//   4. Nothing → null (line breaks)
function dayMargin(d: DayRow): number | null {
  if (d.isClosed) return 0
  if (d.hasActualData) return d.revenue - d.staff_cost
  if (d.pred?.est_revenue > 0) return d.pred.est_revenue - effectiveAiCost(d)
  return null
}

// Classifies the kind of value dayMargin returns so the chart can split
// the line into solid (real / closed) and dashed (predicted) segments.
type MarginKind = 'real' | 'pred'
function dayMarginKind(d: DayRow): MarginKind | null {
  if (d.isClosed)      return 'real'
  if (d.hasActualData) return 'real'
  if (d.pred?.est_revenue > 0) return 'pred'
  return null
}

// Shown revenue — actual if we have it, else predicted. (Bar height.)
function shownRev(d: DayRow): number {
  return d.revenue > 0 ? d.revenue : (d.pred?.est_revenue ?? 0)
}
// Shown labour cost — actual if we have it, else planned (what the owner's
// schedule says they'll spend). The AI-cost forecast is rendered separately
// as a whisker.
function shownLabour(d: DayRow): number {
  return d.staff_cost > 0 ? d.staff_cost : (d.pred?.planned_cost ?? 0)
}

// Per-day forecast values given current compareMode. Returns null when we
// have no comparable value for that day (e.g. past-day AI forecast).
function dayForecast(d: DayRow, mode: 'none' | 'prev' | 'ai'): { rev: number | null; lab: number | null } {
  if (mode === 'none') return { rev: null, lab: null }
  if (mode === 'prev') {
    if (!d.prevDay) return { rev: null, lab: null }
    return { rev: d.prevDay.revenue ?? null, lab: d.prevDay.staff_cost ?? null }
  }
  // 'ai' — only populated when d.pred exists (i.e. future days)
  if (!d.pred) return { rev: null, lab: null }
  return { rev: d.pred.est_revenue, lab: effectiveAiCost(d) }
}

// Number of-day helpers
function pad2(n: number) { return n < 10 ? '0' + n : String(n) }
function toDate(iso: string) { return new Date(iso + 'T12:00:00') }
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// ─── Main component ──────────────────────────────────────────────────────────
export default function OverviewChart({
  days, viewMode, onViewModeChange,
  periodLabel, businessName,
  targetLabourPct = 35,
  availablePeriods, onPeriodChange,
  onDayClick,
  selectedDates, onSelectedDatesChange,
  compareMode: cmpProp, onCompareChange,
  fmtKr, fmtPct,
  holidayDates,
  anomalyCallout,
}: OverviewChartProps) {
  const t = useTranslations('dashboard.chart')
  const isWeek = viewMode === 'week'

  // ── Controlled / uncontrolled state ────────────────────────────────────────
  const [internalSelected,   setInternalSelected] = useState<Set<string>>(new Set())
  const [internalCompare,    setInternalCompare]  = useState<'none'|'prev'|'ai'>('ai')

  const selected = useMemo(
    () => new Set(selectedDates ?? Array.from(internalSelected)),
    [selectedDates, internalSelected],
  )
  const compareMode: 'none'|'prev'|'ai' = cmpProp ?? internalCompare

  function setSelected(next: Set<string>) {
    if (onSelectedDatesChange) onSelectedDatesChange(Array.from(next))
    else setInternalSelected(next)
  }
  function setCompare(m: 'none'|'prev'|'ai') {
    if (onCompareChange) onCompareChange(m)
    else setInternalCompare(m)
  }

  // Reset selection when the period flips completely to a different range —
  // keeping a Mon-date selected across weeks would be surprising.
  const prevRangeKey = useRef<string>('')
  useEffect(() => {
    const key = days.length ? `${days[0].date}|${days[days.length - 1].date}` : ''
    if (key && key !== prevRangeKey.current) {
      prevRangeKey.current = key
      // Only clear internal selection — if parent controls via URL param they
      // keep their own policy. Avoid fighting parent state.
      if (!onSelectedDatesChange && internalSelected.size) setInternalSelected(new Set())
    }
  }, [days, onSelectedDatesChange]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Visible days (after filter) ────────────────────────────────────────────
  const hasFilter = selected.size > 0
  const visibleDays = useMemo(
    () => days.filter(d => !hasFilter || selected.has(d.date)),
    [days, hasFilter, selected],
  )

  // ── Controls: dropdowns ────────────────────────────────────────────────────
  const [periodOpen,   setPeriodOpen]   = useState(false)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const periodBtnRef   = useRef<HTMLButtonElement | null>(null)
  const periodMenuRef  = useRef<HTMLDivElement | null>(null)
  const calendarBtnRef = useRef<HTMLButtonElement | null>(null)
  const calendarMenuRef= useRef<HTMLDivElement | null>(null)

  useOutsideClose(periodOpen,   setPeriodOpen,   [periodBtnRef, periodMenuRef])
  useOutsideClose(calendarOpen, setCalendarOpen, [calendarBtnRef, calendarMenuRef])

  // ── Hover for tooltip ──────────────────────────────────────────────────────
  const [hoverDate, setHoverDate] = useState<string | null>(null)
  const hoverDay = useMemo(
    () => hoverDate ? days.find(d => d.date === hoverDate) ?? null : null,
    [days, hoverDate],
  )

  // ── Chart scales ───────────────────────────────────────────────────────────
  const { yMax, yMin, zeroY, yAt, ticksPos, ticksNeg } = useMemo(() => buildScale(days), [days])
  const dayW   = PLOT_W / Math.max(days.length, 1)
  const barW   = isWeek ? 30 : Math.max(10, dayW - 7)
  const barR   = isWeek ? 3 : 2
  const xAt    = (i: number) => PAD_L + dayW * (i + 0.5)
  const markerR = isWeek ? 2.8 : 1.8

  // ── Day-filter calendar helper ─────────────────────────────────────────────
  const dayFilterLabel = useMemo(
    () => buildFilterLabel(selected, days),
    [selected, days],
  )

  // Week month-label for the calendar grid
  const calLabel = useMemo(() => {
    if (!days.length) return ''
    const first = toDate(days[0].date)
    const last  = toDate(days[days.length - 1].date)
    const fm = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    const lm = last .toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    return fm === lm ? fm : `${fm} – ${lm}`
  }, [days])

  const lastClickedRef = useRef<string | null>(null)

  // ── Bar / tooltip callbacks ────────────────────────────────────────────────
  function handleToggle(date: string, shift: boolean) {
    const next = new Set(selected)
    if (shift && lastClickedRef.current) {
      // Range: inclusive from lastClickedRef.current → date (by date order)
      const a = lastClickedRef.current
      const b = date
      const lo = a < b ? a : b
      const hi = a < b ? b : a
      for (const d of days) {
        if (d.date >= lo && d.date <= hi) next.add(d.date)
      }
    } else if (next.has(date)) {
      next.delete(date)
    } else {
      next.add(date)
    }
    lastClickedRef.current = date
    setSelected(next)
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{
      background: 'white', border: '1px solid #e5e7eb', borderRadius: 12,
      padding: '18px 20px', marginBottom: 16,
    }}>

      {/* Title row removed — period label already shown on the period dropdown
          button below and business name is in the sidebar. Duplicate branding
          per FIX-PROMPT § Phase 1. */}

      {/* Controls row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' as const, gap: 10, marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>

          {/* Period dropdown */}
          {availablePeriods && availablePeriods.length > 0 && (
            <div style={{ position: 'relative' as const }}>
              <button
                ref={periodBtnRef}
                onClick={() => setPeriodOpen(o => !o)}
                onKeyDown={e => { if (e.key === 'Escape') setPeriodOpen(false) }}
                aria-haspopup="listbox"
                aria-expanded={periodOpen}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 10px', background: 'white',
                  border: '1px solid #e5e7eb', borderRadius: 8,
                  fontSize: 12, fontWeight: 500, color: '#374151', cursor: 'pointer',
                }}
              >
                {periodLabel}
                <span style={{ fontSize: 10, color: '#9ca3af' }}>▾</span>
              </button>
              {periodOpen && (
                <div
                  ref={periodMenuRef}
                  role="listbox"
                  style={{
                    position: 'absolute' as const, top: 'calc(100% + 4px)', left: 0,
                    background: 'white', border: '1px solid #e5e7eb', borderRadius: 10,
                    boxShadow: '0 8px 24px rgba(0,0,0,.08)', padding: 8, minWidth: 220, zIndex: 30,
                  }}
                >
                  <PeriodSection
                    title={t('weeks')}
                    items={availablePeriods.filter(p => p.view === 'week')}
                    onPick={k => { onPeriodChange?.(k); setPeriodOpen(false) }}
                    currentLabel={periodLabel}
                  />
                  <PeriodSection
                    title={t('months')}
                    items={availablePeriods.filter(p => p.view === 'month')}
                    onPick={k => { onPeriodChange?.(k); setPeriodOpen(false) }}
                    currentLabel={periodLabel}
                  />
                </div>
              )}
            </div>
          )}

          {/* W / M toggle */}
          <SegmentedToggle
            options={[
              { key: 'week',  label: t('viewWeek')  },
              { key: 'month', label: t('viewMonth') },
            ]}
            value={viewMode}
            onChange={k => onViewModeChange?.(k as 'week' | 'month')}
          />

          {/* Day filter calendar */}
          <div style={{ position: 'relative' as const }}>
            <button
              ref={calendarBtnRef}
              onClick={() => setCalendarOpen(o => !o)}
              onKeyDown={e => { if (e.key === 'Escape') setCalendarOpen(false) }}
              aria-haspopup="dialog"
              aria-expanded={calendarOpen}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '6px 10px', background: 'white',
                border: '1px solid #e5e7eb', borderRadius: 8,
                fontSize: 12, fontWeight: 500, color: '#374151', cursor: 'pointer',
              }}
            >
              <span aria-hidden>📅</span>
              {dayFilterLabel}
              {hasFilter && (
                <span
                  role="button"
                  aria-label={t('clearFilter')}
                  onClick={e => { e.stopPropagation(); setSelected(new Set()) }}
                  style={{ marginLeft: 4, color: '#9ca3af', fontSize: 11 }}
                >✕</span>
              )}
            </button>
            {calendarOpen && (
              <DayFilterCalendar
                innerRef={calendarMenuRef}
                days={days}
                selected={selected}
                onToggle={handleToggle}
                onQuickAll={() => setSelected(new Set())}
                onQuickWeekdays={() => {
                  const next = new Set<string>()
                  for (const d of days) {
                    const dow = toDate(d.date).getDay() // 0=Sun..6=Sat
                    if (dow >= 1 && dow <= 5) next.add(d.date)
                  }
                  setSelected(next)
                }}
                onQuickWeekends={() => {
                  const next = new Set<string>()
                  for (const d of days) {
                    const dow = toDate(d.date).getDay()
                    if (dow === 0 || dow === 6) next.add(d.date)
                  }
                  setSelected(next)
                }}
                label={calLabel}
              />
            )}
          </div>
        </div>

        {/* Compare toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: '#9ca3af', letterSpacing: '.04em', textTransform: 'uppercase' as const, fontWeight: 600 }}>{t('compare')}</span>
          <SegmentedToggle
            options={[
              { key: 'none', label: t('compareNone') },
              { key: 'prev', label: isWeek ? t('comparePrevWeek') : t('comparePrevMonth') },
              { key: 'ai',   label: t('compareAi') },
            ]}
            value={compareMode}
            onChange={k => setCompare(k as 'none' | 'prev' | 'ai')}
          />
        </div>
      </div>

      {/* KPI strip removed per FIX-PROMPT § Phase 1 — the same four numbers
          (Revenue / Labour / Labour % / Gross margin) already live in the
          page-hero SupportingStats. Keeping them here duplicated the hero. */}

      {/* Chart card */}
      <div style={{
        position: 'relative' as const,
        background: 'white', border: '1px solid #eef0f4', borderRadius: 12,
        padding: '18px 12px 10px', marginBottom: 12,
      }}>
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          preserveAspectRatio="none"
          width="100%"
          height={320}
          role="img"
          aria-label={t('ariaChart', { period: periodLabel })}
          style={{ display: 'block' as const }}
          onMouseLeave={() => setHoverDate(null)}
        >
          {/* v7 modernization — soft solid fills (no diagonal stripes) +
              area gradient under the AI forecast line. Striped patterns
              stay defined for back-compat with anything else that may
              still reference them. */}
          <defs>
            {/* Area gradient under AI forecast line — fades very softly.
                Neutral fill so it doesn't compete with the (solid green)
                actual margin line. v8 rule: only the truth gets vivid
                colour; projections recede. */}
            <linearGradient id="cc-forecast-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.marAi} stopOpacity={0.08} />
              <stop offset="100%" stopColor={C.marAi} stopOpacity={0} />
            </linearGradient>
            {/* Soft drop shadow used for emphasis on the today marker. */}
            <filter id="cc-soft-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            {/* Legacy stripe patterns retained to avoid breaking any
                consumer that may still reference them via fill="url(...)";
                v7 paint paths now use solid soft fills instead. */}
            <pattern id="pk-pred" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(-45)">
              <rect width="8" height="8" fill={C.predFill1} />
              <rect width="4" height="8" fill={C.predFill2} />
            </pattern>
            <pattern id="pk-pred-lab" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(-45)">
              <rect width="8" height="8" fill="#fed7aa" />
              <rect width="4" height="8" fill="#ffedd5" />
            </pattern>
          </defs>

          {/* Gridlines — horizontal-only, very faint per v7. */}
          {ticksPos.map(v => {
            const y = yAt(v)
            return (
              <g key={`p${v}`}>
                <line x1={PAD_L} x2={VB_W - PAD_R} y1={y} y2={y} stroke={C.axisGrid} strokeWidth={0.5} />
                <text x={PAD_L - 6} y={y + 3} textAnchor="end" fontSize={10} fill={C.axisInk} fontWeight={500}>{formatAxis(v)}</text>
              </g>
            )
          })}
          {ticksNeg.map(v => {
            const y = yAt(v)
            return (
              <g key={`n${v}`}>
                <line x1={PAD_L} x2={VB_W - PAD_R} y1={y} y2={y} stroke={C.axisGrid} strokeWidth={0.5} />
                <text x={PAD_L - 6} y={y + 3} textAnchor="end" fontSize={10} fill={C.axisInk} fontWeight={500}>{formatAxis(v)}</text>
              </g>
            )
          })}
          {/* Zero line — slightly darker than the gridlines so it reads as
              the baseline. */}
          <line x1={PAD_L} x2={VB_W - PAD_R} y1={zeroY} y2={zeroY} stroke={C.axis} strokeWidth={1.2} />

          {/* Area gradient under AI forecast line — drawn BEFORE bars so
              the bars sit on top. Path closes back along the zero baseline. */}
          {(() => {
            const pts = days
              .map((d, i) => {
                const v = (d.pred?.est_revenue ?? 0) > 0
                  ? d.pred!.est_revenue
                  : (d.revenue > 0 ? d.revenue : null)
                if (v == null) return null
                return { x: xAt(i), y: yAt(v) }
              })
              .filter((p): p is { x: number; y: number } => p != null)
            if (pts.length < 2) return null
            const path = `M ${pts[0].x} ${zeroY} ` +
              pts.map(p => `L ${p.x} ${p.y}`).join(' ') +
              ` L ${pts[pts.length - 1].x} ${zeroY} Z`
            return <path d={path} fill="url(#cc-forecast-grad)" />
          })()}

          {/* Bars + whiskers — v7 modernization: rounded corners (rx=5),
              soft solid predicted fill (no diagonal stripes), per-day
              labour tier coloring driven by staff_pct vs targetLabourPct. */}
          {days.map((d, i) => {
            const inFilter = !hasFilter || selected.has(d.date)
            const op  = inFilter ? 1 : 0.18
            const opH = (hoverDate && hoverDate !== d.date) ? 0.5 : op
            const cx  = xAt(i)
            const rev = shownRev(d)
            const lab = shownLabour(d)
            const hasPred    = !d.revenue    && d.pred && d.pred.est_revenue  > 0
            const hasPredLab = !d.staff_cost && d.pred && (d.pred.planned_cost ?? 0) > 0

            const fcast = dayForecast(d, compareMode)

            // Per-day labour tier — drives bar colour (actual or predicted)
            // and the above-bar percentage annotation.
            const tierInfo = labourTier(d.staff_pct, targetLabourPct)
            const labFill  = hasPredLab ? tierInfo.predFill : tierInfo.ink

            const labBottomY = yAt(-lab)

            // v8 cleaner-chart: bar tier colour alone communicates the
            // labour ratio. The exact percentage is exposed via the
            // ChartTooltip on hover (see prominent labour_pct row), not
            // as always-visible above-bar text — that crowded the chart
            // and competed with the AI forecast line + gross margin line.

            // Modern rx — bigger rounded corners on the top edge of each
            // bar. Plain SVG can't apply rx only to top corners without a
            // path, but rx=5 gives the right visual effect at the top
            // while the bottom is anchored.
            const r = 5

            return (
              <g
                key={d.date}
                role="button"
                tabIndex={inFilter ? 0 : -1}
                aria-label={t('ariaBar', { day: d.dayName, date: d.date, revenue: fmtKr(rev), labour: fmtKr(lab) })}
                onMouseEnter={() => setHoverDate(d.date)}
                onFocus={() => setHoverDate(d.date)}
                onClick={() => onDayClick?.(d)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDayClick?.(d) }
                }}
                style={{ opacity: opH, transition: 'opacity .15s', cursor: onDayClick ? 'pointer' : 'default' }}
              >
                {/* Revenue bar — predicted variant uses a soft solid fill
                    with a subtle border so it reads as "tentative / forecast"
                    next to the solid dark actuals. */}
                {rev > 0 && (
                  <rect
                    x={cx - barW / 2}
                    y={yAt(rev)}
                    width={barW}
                    height={Math.max(1, zeroY - yAt(rev))}
                    rx={r} ry={r}
                    fill={hasPred ? C.predRev : C.rev}
                    stroke={hasPred ? C.predRevBorder : 'none'}
                    strokeWidth={hasPred ? 0.6 : 0}
                    opacity={hasPred ? 0.95 : 1}
                  />
                )}
                {/* Labour bar — tier-coloured (green/amber/red) based on
                    staff_pct vs targetLabourPct. Predicted-labour days use
                    the matching soft variant. */}
                {lab > 0 && (
                  <rect
                    x={cx - barW / 2}
                    y={zeroY}
                    width={barW}
                    height={Math.max(1, labBottomY - zeroY)}
                    rx={r} ry={r}
                    fill={labFill}
                    opacity={hasPredLab ? 0.92 : 1}
                  />
                )}

                {/* Forecast whiskers (compare mode prev/ai) */}
                {fcast.rev != null && (
                  <line
                    x1={cx - barW / 2 - (isWeek ? 4 : 1)}
                    x2={cx + barW / 2 + (isWeek ? 4 : 1)}
                    y1={yAt(fcast.rev)} y2={yAt(fcast.rev)}
                    stroke="#6b7280" strokeWidth={1.4} strokeDasharray="3 2"
                  />
                )}
                {fcast.lab != null && (
                  <line
                    x1={cx - barW / 2 - (isWeek ? 4 : 1)}
                    x2={cx + barW / 2 + (isWeek ? 4 : 1)}
                    y1={yAt(-fcast.lab)} y2={yAt(-fcast.lab)}
                    stroke="#6b7280" strokeWidth={1.4} strokeDasharray="3 2"
                  />
                )}
              </g>
            )
          })}

          {/* AI forecast line — connects the est_revenue / shownRev
              points across days. Drawn AFTER bars so it sits on top.
              Today's marker gets a soft halo + white-ringed circle for
              emphasis; future-day markers fade slightly so the actuals
              pop. */}
          {(() => {
            type Pt = { x: number; y: number; idx: number; date: string; isToday: boolean; isFuture: boolean }
            const pts: Pt[] = []
            days.forEach((d, i) => {
              const v = (d.pred?.est_revenue ?? 0) > 0
                ? d.pred!.est_revenue
                : (d.revenue > 0 ? d.revenue : null)
              if (v == null) return
              pts.push({ x: xAt(i), y: yAt(v), idx: i, date: d.date, isToday: d.isToday, isFuture: d.isFuture })
            })
            if (pts.length < 2) return null
            const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
            // AI forecast = projection. Dashed neutral line so the eye
            // never reads it as the truth. Today's marker stays a hollow
            // ringed circle for emphasis (it's the join point between
            // actuals and the forecast tail).
            return (
              <>
                <path
                  d={path}
                  stroke={C.marAi}
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray="4,3"
                  fill="none"
                  opacity={0.85}
                />
                {pts.map(p => {
                  if (p.isToday) {
                    return (
                      <g key={`fc${p.date}`}>
                        <circle cx={p.x} cy={p.y} r={8} fill={C.marAi} opacity={0.14} />
                        <circle cx={p.x} cy={p.y} r={4} fill="#fff" stroke={C.marAi} strokeWidth={1.6} />
                      </g>
                    )
                  }
                  return (
                    <circle
                      key={`fc${p.date}`}
                      cx={p.x}
                      cy={p.y}
                      r={2.5}
                      fill="#fff"
                      stroke={C.marAi}
                      strokeWidth={1.2}
                      opacity={p.isFuture ? 0.75 : 0.55}
                    />
                  )
                })}
              </>
            )
          })()}

          {/* TODAY marker — vertical dashed line spanning the chart with
              a small dark pill at the top. Shows only when "today" falls
              inside the visible range. */}
          {(() => {
            const todayDay = days.find(d => d.isToday)
            if (!todayDay) return null
            const i = days.indexOf(todayDay)
            const x = xAt(i)
            return (
              <g>
                <line x1={x} y1={PAD_T - 4} x2={x} y2={zeroY + 32} stroke={C.rev} strokeWidth={1} strokeDasharray="2 3" opacity={0.55} />
                <rect x={x - 26} y={PAD_T - 16} width={52} height={14} rx={3} fill={C.rev} />
                <text x={x} y={PAD_T - 6} textAnchor="middle" fontSize={9} fontWeight={700} fill="#fff" letterSpacing="0.05em">TODAY</text>
              </g>
            )
          })()}

          {/* Gross margin line — split into segments by kind so actual/closed
              segments are SOLID and predicted segments are DASHED.
              FIXES §0xx (2026-04-28). Markers also kind-coded:
                - real (actual or closed): solid filled circle
                - predicted: hollow circle (ring) so the eye reads "guess" */}
          {(() => {
            type Pt = { x: number; y: number; kind: MarginKind; isClosed: boolean; date: string }
            const segments: Array<{ kind: MarginKind; points: Pt[] }> = []
            let current: { kind: MarginKind; points: Pt[] } | null = null
            days.forEach((d, i) => {
              const inFilter = !hasFilter || selected.has(d.date)
              const m = dayMargin(d)
              const k = dayMarginKind(d)
              if (!inFilter || m == null || k == null) {
                if (current) { segments.push(current); current = null }
                return
              }
              const pt: Pt = { x: xAt(i), y: yAt(m), kind: k, isClosed: !!d.isClosed, date: d.date }
              if (current && current.kind !== k) {
                // Kind transition (real → pred or vice versa). Push the
                // current segment, then start a new one with the previous
                // point overlapped so the line stays visually connected.
                segments.push(current)
                const last = current.points[current.points.length - 1]
                current = { kind: k, points: last ? [{ ...last, kind: k }] : [] }
              }
              if (!current) current = { kind: k, points: [] }
              current.points.push(pt)
            })
            if (current) segments.push(current)
            const allPoints = segments.flatMap(s => s.points)
            return (
              <>
                {segments.map((seg, i) => {
                  if (seg.points.length < 2) return null
                  const path = seg.points.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
                  // Gross margin = actual data. Solid green — the truth.
                  // Predicted-margin segments (future days where we
                  // synthesise from AI est_revenue minus AI cost) stay
                  // dashed so the eye still reads them as projections,
                  // but they keep the green colour to belong to the same
                  // line family. v8 inversion: solid = actual, dashed =
                  // forecast — matches the AI-line treatment below.
                  return (
                    <path
                      key={`seg${i}`}
                      d={path}
                      stroke={C.mar}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      fill="none"
                      strokeDasharray={seg.kind === 'pred' ? '4,3' : undefined}
                      opacity={seg.kind === 'pred' ? 0.7 : 1}
                    />
                  )
                })}
              </>
            )
          })()}

          {/* X-axis labels — v7 two-line format: weekday on top
              (tier-coloured for today / red-day / labour-tier), date
              on the bottom row in muted ink. Weekends and holidays
              render the weekday red. */}
          {days.map((d, i) => {
            const dow       = toDate(d.date).getDay()
            const isWeekend = dow === 0 || dow === 6
            const isHoliday = !!holidayDates?.has(d.date)
            const isRedDay  = isWeekend || isHoliday
            // Per-day tier from labour ratio — lets the X-axis weekday
            // pick up the same green/amber/red signal as the bars
            // (without colliding with the today / red-day rules).
            const tierForLabel = labourTier(d.staff_pct, targetLabourPct)
            const dayFill      = d.isToday ? C.rev
                              : isRedDay  ? C.tierRed
                              : (d.staff_pct != null ? tierForLabel.ink : C.axisInk2)
            const dayFontWeight = d.isToday ? 700 : isRedDay ? 600 : 600
            const dayY    = VB_H - PAD_B + 18
            const dateY   = VB_H - PAD_B + 33
            const dateLabel = (() => {
              const dt = toDate(d.date)
              return `${MONTHS_SHORT[dt.getMonth()]} ${dt.getDate()}`
            })()
            const op = !hasFilter || selected.has(d.date) ? 1 : 0.3
            return (
              <g key={`lbl${d.date}`} style={{ opacity: op }}>
                <text
                  x={xAt(i)}
                  y={dayY}
                  textAnchor="middle"
                  fontSize={isWeek ? 11 : 9}
                  fontWeight={dayFontWeight}
                  fill={dayFill}
                >
                  {d.dayName}
                </text>
                {isWeek && (
                  <text
                    x={xAt(i)}
                    y={dateY}
                    textAnchor="middle"
                    fontSize={10}
                    fontWeight={d.isToday ? 600 : 400}
                    fill={d.isToday ? C.rev : C.axisInk2}
                  >
                    {dateLabel}
                  </text>
                )}
              </g>
            )
          })}

          {/* v8 cleaner-chart: NO inline anomaly callout. The page-header
              pill is the alert surface — inline callouts here compete
              with the data and create visual mess. The `anomalyCallout`
              prop stays in the type definition for back-compat with any
              caller that passes it, but is intentionally unused. */}

          {/* Y-axis title */}
          <text x={PAD_L - 44} y={PAD_T + PLOT_H / 2} transform={`rotate(-90 ${PAD_L - 44} ${PAD_T + PLOT_H / 2})`} fontSize={10} fill={C.axisInk}>kr</text>
        </svg>

        {/* Tooltip */}
        {hoverDay && (
          <ChartTooltip
            day={hoverDay}
            dayIndex={days.findIndex(d => d.date === hoverDay.date)}
            totalDays={days.length}
            compareMode={compareMode}
            compareLabel={compareLabelFor(compareMode, isWeek)}
            fmtKr={fmtKr}
            fmtPct={fmtPct}
            targetLabourPct={targetLabourPct}
            anchorXPct={((days.findIndex(d => d.date === hoverDay.date) + 0.5) / Math.max(days.length, 1)) * 100}
          />
        )}

        {/* "No historical forecast" note for past-only + AI compare */}
        {compareMode === 'ai' && visibleDays.length > 0 && visibleDays.every(d => !d.pred || d.revenue > 0) && (
          <div style={{ position: 'absolute' as const, top: 10, right: 14, fontSize: 10, color: '#9ca3af', background: 'rgba(255,255,255,0.85)', padding: '3px 8px', borderRadius: 6, border: '1px solid #e5e7eb' }}>
            No historical AI forecast available
          </div>
        )}
      </div>

      {/* Legend — v7 compact style: smaller swatches, lighter text,
          a tier-colour mini-cluster for labour-ratio. */}
      <div style={{
        display:    'flex',
        flexWrap:   'wrap' as const,
        gap:        18,
        fontSize:   11,
        color:      C.axisInk2,
        paddingTop: 14,
        marginTop:  2,
        borderTop:  `1px solid ${C.axisGrid}`,
      }}>
        <span><LegendDot color={C.rev} />Revenue</span>
        <span><LegendDot color={C.predRev} />Predicted</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span>Labour ratio:</span>
          <LegendDot color={C.tierGood} /><span>on target</span>
          <LegendDot color={C.tierAmber} style={{ marginLeft: 2 }} /><span>watch</span>
          <LegendDot color={C.tierRed}   style={{ marginLeft: 2 }} /><span>over</span>
        </span>
        <span><LegendBar color={C.mar} />Gross margin</span>
        <span><LegendBar color={C.marAi} dashed />AI forecast</span>
      </div>
    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function SegmentedToggle({ options, value, onChange }: any) {
  return (
    <div style={{ display: 'inline-flex', background: '#f3f4f6', borderRadius: 8, padding: 3, gap: 2 }}>
      {options.map((o: any) => {
        const active = o.key === value
        return (
          <button
            key={o.key}
            onClick={() => onChange(o.key)}
            style={{
              padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
              fontSize: 12, fontWeight: 600,
              background: active ? 'white' : 'transparent',
              color:      active ? '#111'   : '#9ca3af',
              boxShadow:  active ? '0 1px 3px rgba(0,0,0,.1)' : 'none',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function PeriodSection({ title, items, onPick, currentLabel }: any) {
  if (!items.length) return null
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', padding: '4px 8px' }}>{title}</div>
      {items.map((p: any) => {
        const active = p.label === currentLabel
        return (
          <button
            key={p.key}
            onClick={() => onPick(p.key)}
            style={{
              display: 'block', width: '100%', textAlign: 'left' as const,
              padding: '6px 10px', borderRadius: 6, border: 'none', cursor: 'pointer',
              background: active ? '#f3f4f6' : 'transparent',
              color: '#111', fontSize: 12, fontWeight: active ? 600 : 400,
            }}
          >
            {p.label}
          </button>
        )
      })}
    </div>
  )
}

// Plain component that takes the container ref as `innerRef`. Avoids the
// React-warning of using `ref` as a normal prop on a function component.
function DayFilterCalendar({ days, selected, onToggle, onQuickAll, onQuickWeekdays, onQuickWeekends, label, innerRef }: any) {
  const inRange = new Set(days.map((d: any) => d.date))
  // Build the month grid around the first day in `days`. For week view this
  // may cross months — render the month containing the first day.
  const first = toDate(days[0]?.date ?? new Date().toISOString().slice(0, 10))
  const year  = first.getFullYear()
  const month = first.getMonth()
  const firstOfMonth = new Date(year, month, 1)
  // Mon-first offset
  const startDow = (firstOfMonth.getDay() + 6) % 7
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const todayStr = new Date().toISOString().slice(0, 10)

  const cells: Array<{ date?: string; day?: number; inPeriod?: boolean } | null> = []
  for (let i = 0; i < startDow; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${pad2(month + 1)}-${pad2(d)}`
    cells.push({ date, day: d, inPeriod: inRange.has(date) })
  }

  return (
    <div
      ref={innerRef}
      role="dialog"
      style={{
        position: 'absolute' as const, top: 'calc(100% + 4px)', left: 0,
        background: 'white', border: '1px solid #e5e7eb', borderRadius: 10,
        boxShadow: '0 8px 24px rgba(0,0,0,.08)', padding: 8, width: 244, zIndex: 30,
      }}
    >
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        <CalQuick label="All"       onClick={onQuickAll} />
        <CalQuick label="Weekdays"  onClick={onQuickWeekdays} />
        <CalQuick label="Weekends"  onClick={onQuickWeekends} />
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textAlign: 'center' as const, margin: '4px 0 6px' }}>{label}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>
        {['Mo','Tu','We','Th','Fr','Sa','Su'].map(d => (
          <div key={d} style={{ fontSize: 9, color: '#9ca3af', textAlign: 'center' as const, padding: '2px 0', fontWeight: 700, letterSpacing: '.04em' }}>{d}</div>
        ))}
        {cells.map((c, i) => {
          if (!c) return <div key={i} />
          const isSel = c.date && selected.has(c.date)
          const isToday = c.date === todayStr
          const dow = (new Date(c.date + 'T12:00:00').getDay() + 6) % 7
          const isWeekend = dow >= 5
          return (
            <button
              key={i}
              aria-pressed={!!isSel}
              onClick={e => c.date && onToggle(c.date, e.shiftKey)}
              disabled={!c.inPeriod}
              style={{
                height: 28,
                border: isToday && !isSel ? `1px solid ${C.mar}` : '1px solid transparent',
                borderRadius: 6,
                background: isSel ? C.rev : 'transparent',
                color: isSel ? 'white' : isToday ? C.mar : isWeekend ? '#9ca3af' : '#374151',
                cursor: c.inPeriod ? 'pointer' : 'default',
                fontSize: 11, fontWeight: isSel ? 500 : 400,
                opacity: c.inPeriod ? 1 : 0.35,
              }}
            >
              {c.day}
            </button>
          )
        })}
      </div>
      <div style={{ fontSize: 10, color: '#9ca3af', textAlign: 'center' as const, marginTop: 6 }}>
        Click to toggle · Shift+click for range
      </div>
    </div>
  )
}

function CalQuick({ label, onClick }: any) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: '5px 4px', background: 'white',
        border: '1px solid #e5e7eb', borderRadius: 6,
        fontSize: 11, color: '#374151', cursor: 'pointer',
      }}
    >
      {label}
    </button>
  )
}

// KpiBlock / KpiDelta / computeKpis removed — the 4-up KPI strip they
// powered was deleted in the Phase 1 redesign. The hero's SupportingStats
// renders the same numbers above the chart.

function LegendItem({ kind, color, label }: any) {
  let swatch: any = null
  if (kind === 'swatch')  swatch = <div style={{ width: 12, height: 10, borderRadius: 2, background: color }} />
  if (kind === 'striped') swatch = <div style={{ width: 12, height: 10, borderRadius: 2, background: `repeating-linear-gradient(135deg, ${C.predFill1} 0 4px, ${C.predFill2} 4px 8px)`, border: `0.5px solid ${C.predBorder}` }} />
  if (kind === 'line')    swatch = <div style={{ width: 14, height: 0, borderTop: `2px solid ${color}`, borderRadius: 2 }} />
  if (kind === 'dashed')  swatch = <svg width={14} height={4}><line x1="0" y1="2" x2="14" y2="2" stroke={color} strokeWidth={1.4} strokeDasharray="3 2" /></svg>
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {swatch}
      <span style={{ fontSize: 12, color: '#6b7280' }}>{label}</span>
    </div>
  )
}

// v7-style compact legend swatches — small square block + tiny line bar.
// Used by the redesigned legend below the chart.
function LegendDot({ color, style }: { color: string; style?: React.CSSProperties }) {
  return (
    <span style={{
      display:      'inline-block',
      width:        10,
      height:       10,
      borderRadius: 2,
      background:   color,
      marginRight:  5,
      verticalAlign:'middle',
      ...style,
    }} />
  )
}

function LegendBar({ color, dashed, style }: { color: string; dashed?: boolean; style?: React.CSSProperties }) {
  const bg = dashed
    ? `repeating-linear-gradient(90deg, ${color} 0 2px, transparent 2px 6px)`
    : color
  return (
    <span style={{
      display:      'inline-block',
      width:        14,
      height:       2,
      background:   bg,
      marginRight:  5,
      verticalAlign:'middle',
      ...style,
    }} />
  )
}

function ChartTooltip({ day, dayIndex, totalDays, compareMode, compareLabel, fmtKr, fmtPct, targetLabourPct, anchorXPct }: any) {
  const t = useTranslations('dashboard.chart')
  const hasActual = day.revenue > 0
  const hasPred   = !hasActual && day.pred?.est_revenue > 0
  const dateLabel = toDate(day.date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })

  // Values
  const revActual = hasActual ? day.revenue : (day.pred?.est_revenue ?? 0)
  const labActual = hasActual ? day.staff_cost : (day.pred?.planned_cost ?? 0)
  const marActual = revActual - labActual

  const f = dayForecast(day, compareMode)
  const revF = f.rev, labF = f.lab
  const marF = revF != null && labF != null ? revF - labF : null

  // v8: prominent labour-% row at the top. Use the persisted staff_pct
  // on actual days; fall back to planned-ratio on predicted days. Tier
  // colour matches the bar so hover signal aligns with the visual.
  const target  = Number(targetLabourPct ?? 35)
  const dayPct = (() => {
    if (typeof day.staff_pct === 'number' && Number.isFinite(day.staff_pct)) return day.staff_pct
    if (revActual > 0 && labActual > 0) return (labActual / revActual) * 100
    return null
  })()
  const tierForTooltip = dayPct != null ? labourTier(dayPct, target) : null
  // Tier ink colours are designed for white backgrounds; the tooltip
  // is dark, so map to the light variants (greenGood / amberWarn /
  // redBad already exposed in C).
  const tierBgPalette = (tier: 'good' | 'amber' | 'red' | undefined): string => {
    if (tier === 'good')  return C.goodGreen
    if (tier === 'amber') return '#fcd34d'
    if (tier === 'red')   return C.badRed
    return C.ttMute as string
  }
  const tierColor = tierForTooltip ? tierBgPalette(tierForTooltip.tier) : (C.ttMute as string)
  const ppDelta   = dayPct != null && Number.isFinite(target) ? Math.round(dayPct - target) : null

  // Horizontal clamp — tooltip width ~240, chart card inner width ~ viewport.
  // CSS-only clamp: translateX(-50%) with computed left %.
  const clampLeft = Math.min(Math.max(anchorXPct, 18), 82)

  return (
    <div
      role="tooltip"
      style={{
        position: 'absolute' as const,
        top: 10, left: `${clampLeft}%`,
        transform: 'translateX(-50%)',
        background: C.ttBg, color: 'white',
        borderRadius: 10, padding: '12px 14px',
        minWidth: 220, maxWidth: 260,
        boxShadow: '0 6px 24px rgba(0,0,0,.2)',
        pointerEvents: 'none' as const,
        zIndex: 10,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' as const, color: C.ttMute }}>
          {dateLabel}
        </div>
        {/* FIXES §0xx: priority CLOSED > PREDICTED. Closed days are
            past-real, just at zero — they should NOT show the predicted
            badge. */}
        {day.isClosed && (
          <span style={{ fontSize: 9, background: '#6b7280', color: 'white', padding: '1px 6px', borderRadius: 3, fontWeight: 700, letterSpacing: '.05em' }}>{t('badgeClosed')}</span>
        )}
        {!day.isClosed && hasPred && (
          <span style={{ fontSize: 9, background: C.revAccent, color: 'white', padding: '1px 6px', borderRadius: 3, fontWeight: 700, letterSpacing: '.05em' }}>{t('badgePredicted')}</span>
        )}
      </div>

      {hasPred && day.pred?.weather && (
        <div style={{ fontSize: 11, color: C.ttMute, marginBottom: 8, display: 'flex', gap: 5, alignItems: 'center' }}>
          <span>{weatherIconLocal(day.pred.weather.weather_code)}</span>
          <span>{day.pred.weather.summary}</span>
          {day.pred.weather.temp_min != null && (
            <span>· {Math.round(day.pred.weather.temp_min)}–{Math.round(day.pred.weather.temp_max)}°</span>
          )}
          {Number(day.pred.weather.precip_mm) > 0.5 && <span>· {day.pred.weather.precip_mm}mm</span>}
        </div>
      )}

      {/* v8 prominent labour-% row — tier colour matches the bar; pp delta
          tells the operator whether they're at, near, or over target. */}
      {dayPct != null && (
        <div style={{
          background:    'rgba(255,255,255,0.08)',
          borderLeft:    `3px solid ${tierColor}`,
          borderRadius:  4,
          padding:       '6px 10px',
          marginBottom:  10,
          display:       'flex',
          alignItems:    'baseline',
          justifyContent:'space-between',
          gap:           8,
        }}>
          <span style={{ fontSize: 10, color: C.ttMute, letterSpacing: '.04em', textTransform: 'uppercase' as const, fontWeight: 600 }}>
            {t('tooltipLabourPct')}
          </span>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: tierColor, fontVariantNumeric: 'tabular-nums' as const }}>
              {Math.round(dayPct)}%
            </span>
            {ppDelta != null && (
              <span style={{ fontSize: 10, color: C.ttMute, fontWeight: 500 }}>
                {ppDelta === 0 ? t('tooltipOnTarget') : t('tooltipVsTarget', { sign: ppDelta > 0 ? '+' : '', pp: ppDelta, target: Math.round(target) })}
              </span>
            )}
          </span>
        </div>
      )}

      <TooltipSection
        color={C.revAccent}
        label="Revenue"
        actualText={fmtKr(revActual)}
        fcast={revF}
        fmt={fmtKr}
        compareMode={compareMode}
        compareLabel={compareLabel}
        higherBetter
      />
      <TooltipSection
        color={C.lab}
        label="Labour"
        actualText={fmtKr(labActual)}
        fcast={labF}
        fmt={fmtKr}
        compareMode={compareMode}
        compareLabel={compareLabel}
        higherBetter={false}
      />
      <TooltipSection
        color={C.mar}
        label="Gross margin"
        actualText={fmtKr(marActual)}
        fcast={marF}
        fmt={fmtKr}
        compareMode={compareMode}
        compareLabel={compareLabel}
        higherBetter
        last
      />
    </div>
  )
}

function TooltipSection({ color, label, actualText, fcast, fmt, compareMode, compareLabel, higherBetter, last }: any) {
  const show = compareMode !== 'none' && fcast != null && Number.isFinite(fcast)
  const actualNum = Number(String(actualText).replace(/[^\d.-]/g, ''))
  const diff = show ? actualNum - fcast : 0
  const better = higherBetter ? diff >= 0 : diff <= 0
  return (
    <div style={{ borderLeft: `2px solid ${color}`, paddingLeft: 8, marginBottom: last ? 0 : 8 }}>
      <div style={{ fontSize: 10, color: C.ttMute, letterSpacing: '.04em', textTransform: 'uppercase' as const, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, fontVariantNumeric: 'tabular-nums' as const }}>{actualText}</div>
      {show && (
        <>
          <div style={{ fontSize: 11, color: C.ttMute, fontStyle: 'italic' as const, marginTop: 1 }}>
            {compareLabel} {fmt(fcast)}
          </div>
          <div style={{ fontSize: 11, marginTop: 1, color: better ? C.goodGreen : C.badRed, fontWeight: 600 }}>
            {diff >= 0 ? '+' : '−'}{fmt(Math.abs(diff))}
          </div>
        </>
      )}
    </div>
  )
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

function buildScale(days: DayRow[]) {
  let maxRev = 0, maxLab = 0
  for (const d of days) {
    // Include both the SHOWN value (actual-or-predicted bar) AND the AI
    // prediction (which plots as a separate line on past days when in
    // AI-compare mode). If the AI prediction is higher than the actual on
    // a past day, the axis must reserve space for it — otherwise the
    // dashed forecast line clips above the chart.
    const predRev = Number(d.pred?.est_revenue ?? 0)
    const predLab = Number(d.pred?.planned_cost ?? 0)
    maxRev = Math.max(maxRev, shownRev(d), predRev)
    maxLab = Math.max(maxLab, shownLabour(d), predLab)
  }
  // Add 8% headroom so the AI line doesn't crowd the top edge — keeps the
  // peak readable instead of grazing the gridline.
  const yMax = Math.max(10000, Math.ceil(maxRev * 1.08 / 10000) * 10000)
  const yMin = -Math.max(5000, Math.ceil(maxLab * 1.08 / 5000) * 5000)
  const plotY = PAD_T
  const plotH = PLOT_H
  const zeroY = plotY + plotH * (yMax / (yMax - yMin))
  const yAt = (v: number) => plotY + plotH * (yMax - v) / (yMax - yMin)

  const step = yMax > 60000 ? 20000 : 10000
  const ticksPos: number[] = []
  for (let v = 0; v <= yMax; v += step) ticksPos.push(v)
  const ticksNeg: number[] = []
  for (let v = -step; v >= yMin; v -= step) ticksNeg.push(v)

  return { yMax, yMin, zeroY, yAt, ticksPos, ticksNeg }
}

function formatAxis(v: number): string {
  if (v === 0) return '0'
  const k = v / 1000
  return `${v < 0 ? '−' : ''}${Math.abs(k)}k`
}

function buildFilterLabel(selected: Set<string>, days: DayRow[]): string {
  if (selected.size === 0) return 'All days'
  const weekdays = days.filter(d => { const dow = toDate(d.date).getDay(); return dow >= 1 && dow <= 5 }).map(d => d.date)
  const weekends = days.filter(d => { const dow = toDate(d.date).getDay(); return dow === 0 || dow === 6 }).map(d => d.date)
  const sameSet = (a: Set<string>, b: string[]) => a.size === b.length && b.every(x => a.has(x))
  if (sameSet(selected, weekdays)) return 'Weekdays'
  if (sameSet(selected, weekends)) return 'Weekends'
  if (selected.size === 1) {
    const only = Array.from(selected)[0]
    return toDate(only).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }
  return `${selected.size} days`
}

function compareLabelFor(mode: 'none'|'prev'|'ai', isWeek: boolean): string {
  if (mode === 'none') return ''
  if (mode === 'ai')   return 'AI forecast'
  return isWeek ? 'Prev week' : 'Prev month'
}

// Outside-click closer — closes on document mousedown outside the given refs.
function useOutsideClose(open: boolean, setOpen: (b: boolean) => void, refs: Array<{ current: any }>) {
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      for (const r of refs) {
        if (r.current && r.current.contains(e.target)) return
      }
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown',   onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown',   onKey)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
}
