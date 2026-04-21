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
}

// ─── Tokens ──────────────────────────────────────────────────────────────────
const C = {
  rev:       '#1a1f2e',
  revBg:     'rgba(26,31,46,0.28)',
  revAccent: '#6366f1',
  lab:       '#c2410c',
  labBg:     'rgba(194,65,12,0.28)',
  mar:       '#16a34a',
  axis:      '#e5e7eb',
  axisInk:   '#9ca3af',
  ttBg:      '#0a0e1a',
  ttMute:    'rgba(255,255,255,0.55)',
  goodGreen: '#86efac',
  badRed:    '#fca5a5',
  // Predicted-revenue bar fill: distinctly lighter / cooler than the solid
  // navy actuals so forecasts fade into the background visually. Sky-blue
  // tones at low opacity — can't be mistaken for a dark actual bar at a
  // glance.
  predFill1: '#c7d2fe',   // light indigo
  predFill2: '#e0e7ff',   // even lighter stripe
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
function dayMargin(d: DayRow): number | null {
  if (d.revenue > 0) return d.revenue - d.staff_cost
  if (d.pred?.est_revenue > 0) return d.pred.est_revenue - effectiveAiCost(d)
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
}: OverviewChartProps) {
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
                    title="Weeks"
                    items={availablePeriods.filter(p => p.view === 'week')}
                    onPick={k => { onPeriodChange?.(k); setPeriodOpen(false) }}
                    currentLabel={periodLabel}
                  />
                  <PeriodSection
                    title="Months"
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
              { key: 'week',  label: 'Week'  },
              { key: 'month', label: 'Month' },
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
                  aria-label="Clear filter"
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
          <span style={{ fontSize: 11, color: '#9ca3af', letterSpacing: '.04em', textTransform: 'uppercase' as const, fontWeight: 600 }}>Compare</span>
          <SegmentedToggle
            options={[
              { key: 'none', label: 'None' },
              { key: 'prev', label: isWeek ? 'Prev week' : 'Prev month' },
              { key: 'ai',   label: 'AI' },
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
          aria-label={`Daily revenue, labour cost and gross margin for ${periodLabel}`}
          style={{ display: 'block' as const }}
          onMouseLeave={() => setHoverDate(null)}
        >
          {/* Pattern for predicted revenue bars */}
          <defs>
            {/* Predicted-revenue fill — two light tones, no dark colour in
                the pattern, so it reads as "soft / forecast" against the
                solid-dark actuals. */}
            <pattern id="pk-pred" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(-45)">
              <rect width="8" height="8" fill={C.predFill1} />
              <rect width="4" height="8" fill={C.predFill2} />
            </pattern>
            {/* Predicted-labour fill — same stripe style in burnt-orange
                tones so predicted labour reads as "planned cost" rather than
                a solid actual. */}
            <pattern id="pk-pred-lab" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(-45)">
              <rect width="8" height="8" fill="#fed7aa" />
              <rect width="4" height="8" fill="#ffedd5" />
            </pattern>
          </defs>

          {/* Gridlines + y-axis labels */}
          {ticksPos.map(v => {
            const y = yAt(v)
            return (
              <g key={`p${v}`}>
                <line x1={PAD_L} x2={VB_W - PAD_R} y1={y} y2={y} stroke={C.axis} strokeWidth={0.5} strokeDasharray={v === 0 ? undefined : '2 2'} />
                <text x={PAD_L - 6} y={y + 3} textAnchor="end" fontSize={10} fill={C.axisInk}>{formatAxis(v)}</text>
              </g>
            )
          })}
          {ticksNeg.map(v => {
            const y = yAt(v)
            return (
              <g key={`n${v}`}>
                <line x1={PAD_L} x2={VB_W - PAD_R} y1={y} y2={y} stroke={C.axis} strokeWidth={0.5} strokeDasharray="2 2" />
                <text x={PAD_L - 6} y={y + 3} textAnchor="end" fontSize={10} fill={C.axisInk}>{formatAxis(v)}</text>
              </g>
            )
          })}
          {/* Zero line (solid) */}
          <line x1={PAD_L} x2={VB_W - PAD_R} y1={zeroY} y2={zeroY} stroke={C.axis} strokeWidth={0.8} />

          {/* Bars + whiskers */}
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

            return (
              <g
                key={d.date}
                role="button"
                tabIndex={inFilter ? 0 : -1}
                aria-label={`${d.dayName} ${d.date}: revenue ${fmtKr(rev)}, labour ${fmtKr(lab)}`}
                onMouseEnter={() => setHoverDate(d.date)}
                onFocus={() => setHoverDate(d.date)}
                onClick={() => onDayClick?.(d)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDayClick?.(d) }
                }}
                style={{ opacity: opH, transition: 'opacity .15s', cursor: onDayClick ? 'pointer' : 'default' }}
              >
                {/* Revenue bar — predicted bars use the light stripe pattern
                    + a thin border + reduced opacity so they read as "forecast
                    / tentative" next to the solid navy actuals. */}
                {rev > 0 && (
                  <rect
                    x={cx - barW / 2}
                    y={yAt(rev)}
                    width={barW}
                    height={Math.max(1, zeroY - yAt(rev))}
                    rx={barR} ry={barR}
                    fill={hasPred ? 'url(#pk-pred)' : C.rev}
                    stroke={hasPred ? C.predBorder : 'none'}
                    strokeWidth={hasPred ? 0.6 : 0}
                    opacity={hasPred ? 0.85 : 1}
                  />
                )}
                {/* Labour bar (below zero line, extending down) */}
                {lab > 0 && (
                  <rect
                    x={cx - barW / 2}
                    y={zeroY}
                    width={barW}
                    height={Math.max(1, yAt(-lab) - zeroY)}
                    rx={barR} ry={barR}
                    fill={hasPredLab ? 'url(#pk-pred-lab)' : C.lab}
                    stroke={hasPredLab ? '#fdba74' : 'none'}
                    strokeWidth={hasPredLab ? 0.6 : 0}
                    opacity={hasPredLab ? 0.85 : 1}
                  />
                )}

                {/* Forecast whiskers */}
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

          {/* Gross margin line — broken at filtered-out / null-margin days */}
          {(() => {
            const segments: Array<Array<{ x: number; y: number }>> = []
            let current: Array<{ x: number; y: number }> = []
            days.forEach((d, i) => {
              const inFilter = !hasFilter || selected.has(d.date)
              const m = dayMargin(d)
              if (!inFilter || m == null) {
                if (current.length) { segments.push(current); current = [] }
                return
              }
              current.push({ x: xAt(i), y: yAt(m) })
            })
            if (current.length) segments.push(current)
            return (
              <>
                {segments.map((seg, i) => {
                  if (seg.length < 2) return null
                  const path = seg.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
                  return <path key={`seg${i}`} d={path} stroke={C.mar} strokeWidth={2} strokeLinejoin="round" fill="none" />
                })}
                {segments.flat().map((p, i) => {
                  const isHovered = hoverDate && days.find(d => d.date === hoverDate) && Math.abs(xAt(days.findIndex(d => d.date === hoverDate)) - p.x) < 0.01
                  return (
                    <circle key={`c${i}`} cx={p.x} cy={p.y} r={isHovered ? 4 : markerR} fill={C.mar} />
                  )
                })}
              </>
            )
          })()}

          {/* X-axis day labels */}
          {days.map((d, i) => (
            <text
              key={`lbl${d.date}`}
              x={xAt(i)}
              y={VB_H - PAD_B + 18}
              textAnchor="middle"
              fontSize={isWeek ? 11 : 9}
              fontWeight={d.isToday ? 700 : 400}
              fill={d.isToday ? C.mar : C.axisInk}
              style={{ opacity: !hasFilter || selected.has(d.date) ? 1 : 0.3 }}
            >
              {d.dayName}
            </text>
          ))}

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

      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap' as const, justifyContent: 'center', gap: 18, paddingBottom: 6 }}>
        <LegendItem kind="swatch"   color={C.rev}  label="Revenue (actual)" />
        <LegendItem kind="striped"  label="Revenue (predicted)" />
        <LegendItem kind="swatch"   color={C.lab}  label="Labour cost" />
        <LegendItem kind="dashed"   color="#6b7280" label="AI forecast" />
        <LegendItem kind="line"     color={C.mar}  label="Gross margin" />
      </div>

      {/* Tip text */}
      <div style={{ textAlign: 'center' as const, fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
        Hover a bar for detail · click to drill in · use the calendar to focus on specific days
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

function ChartTooltip({ day, dayIndex, totalDays, compareMode, compareLabel, fmtKr, fmtPct, anchorXPct }: any) {
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
        {hasPred && (
          <span style={{ fontSize: 9, background: C.revAccent, color: 'white', padding: '1px 6px', borderRadius: 3, fontWeight: 700, letterSpacing: '.05em' }}>PREDICTED</span>
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
    maxRev = Math.max(maxRev, shownRev(d))
    maxLab = Math.max(maxLab, shownLabour(d))
  }
  const yMax = Math.max(10000, Math.ceil(maxRev / 10000) * 10000)
  const yMin = -Math.max(5000, Math.ceil(maxLab / 5000) * 5000)
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
