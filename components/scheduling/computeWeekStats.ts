// components/scheduling/computeWeekStats.ts
//
// Pure helper: takes the /api/scheduling/ai-suggestion payload + acceptances
// map and returns the derived values the new week-grid view needs. Isolated
// from the components so the math is testable and the components stay
// presentational.
//
// All math here uses the SAME conventions as components/scheduling/
// AiHoursReductionMap.tsx (which computes equivalent values for its own
// hero) — green = clear cut (delta_hours <= -2 and not flagged
// under_staffed), amber = under_staffed_note (model wanted to add, asymmetric
// rule blocked), gray = closed OR no-change. Definitions are kept aligned so
// the page-level headline never disagrees with the existing day-by-day view's
// internal hero when the user toggles between them.
//
// "If applied" projections only count GREEN rows that haven't already been
// accepted. The labour-% denominator is the sum of est_revenue across ALL
// days (a forecasted day with no green action still contributes its revenue
// to the week's total — only its cost stays at the current level).

export type DayStatus = 'green' | 'amber' | 'gray-closed' | 'gray-nochange'

export interface WeekStatsInput {
  current:     Array<{
    date:           string
    weekday:        string
    hours:          number
    est_cost:       number
    dept_breakdown: Record<string, { hours: number; cost: number }>
  }>
  suggested:   Array<{
    date:               string
    hours:              number
    est_cost:           number
    est_revenue:        number
    delta_hours:        number
    delta_cost:         number
    under_staffed_note: boolean
    weather:            { summary: string; temp_min: number; temp_max: number; precip_mm: number; bucket: string } | null
    reasoning:          string
  }>
  summary:     {
    saving_kr:        number
    current_hours:    number
    suggested_hours:  number
  }
  acceptances: Record<string, any>
}

export interface DayRow {
  index:        number          // 0..6 in the original payload order
  date:         string
  weekday:      string
  status:       DayStatus
  isAccepted:   boolean
  curHours:     number
  curCost:      number
  aiHours:      number
  aiCost:       number
  deltaHours:   number          // current - suggested (positive = cut)
  savingKr:     number          // current_cost - ai_cost (positive = saving)
  estRevenue:   number
  curDayPct:    number | null
  aiDayPct:     number | null
  reasoning:    string
  weather:      WeekStatsInput['suggested'][number]['weather']
}

export interface WeekStats {
  rows:                    DayRow[]
  daysReadyCount:          number      // green AND not accepted
  daysAmberCount:          number
  daysUnchangedCount:      number      // gray-closed + gray-nochange
  daysAcceptedCount:       number      // green AND already accepted
  weekLabourPctCurrent:    number | null      // % — null if no revenue forecast
  weekLabourPctProjected:  number | null      // current cost - sum(green-not-accepted savings)
  weekDeltaPctPts:         number | null      // current - projected, percentage points
  weekSavingsKr:           number             // sum of green-not-accepted savings
  weekHoursCut:            number             // current_hours - projected_hours
  weekCurCost:             number
  weekAiCost:              number
  weekRevenue:             number
}

/**
 * Compute the full week stats. Pure function — no side effects, no I/O.
 */
export function computeWeekStats(input: WeekStatsInput): WeekStats {
  const rows: DayRow[] = (input.current ?? []).map((c, i) => {
    const s = input.suggested?.[i] ?? null
    const curHours = Number(c.hours ?? 0)
    const curCost  = Number(c.est_cost ?? 0)
    const aiHours  = Number(s?.hours ?? curHours)
    const aiCost   = Number(s?.est_cost ?? curCost)
    const deltaH   = curHours - aiHours      // positive = cut
    const saving   = curCost  - aiCost       // positive = saving
    const estRev   = Number(s?.est_revenue ?? 0)
    const isAccepted = !!input.acceptances?.[c.date]
    const isJudgment = !!s?.under_staffed_note

    let status: DayStatus
    if (curHours < 0.05)            status = 'gray-closed'
    else if (isJudgment)            status = 'amber'
    else if (deltaH < 2)            status = 'gray-nochange'
    else                            status = 'green'

    return {
      index:      i,
      date:       c.date,
      weekday:    c.weekday,
      status,
      isAccepted,
      curHours,
      curCost,
      aiHours,
      aiCost,
      deltaHours:   deltaH,
      savingKr:     saving,
      estRevenue:   estRev,
      curDayPct:    estRev > 0 ? (curCost / estRev) * 100 : null,
      aiDayPct:     estRev > 0 ? (aiCost  / estRev) * 100 : null,
      reasoning:    String(s?.reasoning ?? ''),
      weather:      s?.weather ?? null,
    }
  })

  const greenReady   = rows.filter(r => r.status === 'green' && !r.isAccepted)
  const greenAccepted = rows.filter(r => r.status === 'green' &&  r.isAccepted)
  const amberRows    = rows.filter(r => r.status === 'amber')
  const grayRows     = rows.filter(r => r.status === 'gray-closed' || r.status === 'gray-nochange')

  const weekRevenue   = rows.reduce((s, r) => s + r.estRevenue, 0)
  const weekCurCost   = rows.reduce((s, r) => s + r.curCost, 0)
  // Projected = current cost minus the savings from green rows that haven't
  // been accepted yet. Already-accepted rows count as "already paid the
  // saving" — their AI cost is the customer's current operational state.
  const projectedSavings = greenReady.reduce((s, r) => s + r.savingKr, 0)
  const weekAiCost    = weekCurCost - projectedSavings

  const weekLabourPctCurrent   = weekRevenue > 0 ? (weekCurCost / weekRevenue) * 100 : null
  const weekLabourPctProjected = weekRevenue > 0 ? (weekAiCost  / weekRevenue) * 100 : null
  const weekDeltaPctPts =
    weekLabourPctCurrent != null && weekLabourPctProjected != null
      ? weekLabourPctCurrent - weekLabourPctProjected
      : null

  const weekHoursCut = greenReady.reduce((s, r) => s + r.deltaHours, 0)

  return {
    rows,
    daysReadyCount:          greenReady.length,
    daysAmberCount:          amberRows.length,
    daysUnchangedCount:      grayRows.length,
    daysAcceptedCount:       greenAccepted.length,
    weekLabourPctCurrent,
    weekLabourPctProjected,
    weekDeltaPctPts,
    weekSavingsKr:           projectedSavings,
    weekHoursCut,
    weekCurCost,
    weekAiCost,
    weekRevenue,
  }
}

/**
 * What the week labour % would be if the user applied just the named day's
 * green cut (and nothing else). Used by the reasoning panel's "compounding"
 * card — current → if-this-day → if-this-and-other-greens.
 */
export function pctIfDayApplied(stats: WeekStats, dayIndex: number): number | null {
  if (stats.weekRevenue <= 0) return null
  const day = stats.rows[dayIndex]
  if (!day) return stats.weekLabourPctCurrent
  // Apply only this day's saving (regardless of status — the panel only opens
  // for green days anyway, but this keeps the function general).
  const newCost = stats.weekCurCost - Math.max(day.savingKr, 0)
  return (newCost / stats.weekRevenue) * 100
}

/**
 * What the week labour % would be if every green-not-accepted day were
 * applied. Equivalent to the "after applying all ready days" projection;
 * exposed separately so callers can render it without re-computing.
 */
export function pctIfAllReadyApplied(stats: WeekStats): number | null {
  return stats.weekLabourPctProjected
}
