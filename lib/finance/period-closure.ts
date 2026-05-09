// lib/finance/period-closure.ts
//
// Single source of truth for "is this period likely closed in the
// customer's accounting?" Used by writers (Fortnox backfill worker, PDF
// apply, manual entry) to set tracker_data.is_provisional at write time.
//
// Heuristic (Swedish restaurant accounting, calendar fiscal year):
//   - Current calendar month: ALWAYS provisional. Z-reports + supplier
//     invoices booked daily-to-weekly, but salary doesn't book until the
//     25th of next month, so revenue is partial and staff_cost is 0
//     until the books are closed.
//   - Prior calendar month, today < 15th: provisional. Most accountants
//     close the prior month between the 5th and 15th of the current month.
//     We pick 15th as the cutover so we err toward "still in progress"
//     for one extra week.
//   - Anything older OR prior month with today >= 15th: closed.
//
// Timezone: we use the Stockholm calendar day for the "today" reference,
// matching how owners think about month-end. (UTC could be a day off
// around midnight which is operationally weird.)

/** YYYY-MM-DD in Stockholm time. */
function todayStockholm(now: Date = new Date()): { year: number; month: number; day: number } {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm' }).format(now)
  // en-CA is YYYY-MM-DD
  const [y, m, d] = ymd.split('-').map(Number)
  return { year: y, month: m, day: d }
}

/**
 * Should the given (year, month) be flagged as provisional given today's date?
 *
 * @param periodYear  e.g. 2026
 * @param periodMonth 1-12
 * @param now         optional reference time (testability). Defaults to now().
 */
export function isProvisional(
  periodYear:  number,
  periodMonth: number,
  now: Date = new Date(),
): boolean {
  const today = todayStockholm(now)

  // Current month: always provisional
  if (periodYear === today.year && periodMonth === today.month) return true

  // Prior month: provisional only until the 15th (closure window)
  let priorYear  = today.year
  let priorMonth = today.month - 1
  if (priorMonth === 0) {
    priorMonth = 12
    priorYear--
  }
  if (periodYear === priorYear && periodMonth === priorMonth && today.day < 15) {
    return true
  }

  return false
}

/**
 * "Today" in Stockholm time, as { year, month, day } — exposed so other
 * modules don't need to recompute the timezone shift.
 */
export function stockholmToday(now: Date = new Date()) {
  return todayStockholm(now)
}
