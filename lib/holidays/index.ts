// lib/holidays/index.ts
//
// Country router for holiday data. SE is wired today; nb (Norway) and gb
// (UK) plug in here as separate sibling modules later — same Holiday
// shape, same getHolidaysForCountry signature, no overlap.
//
// Adding a new country:
//   1. Drop a `lib/holidays/<country>.ts` exporting a `get<Country>Holidays(year): Holiday[]`
//   2. Wire it into the switch below
//   3. Done. Every consumer (API endpoint, dashboard card, AI prompt
//      builder) calls through this router so they pick it up for free.

import type { Holiday } from './sweden'
import { getSwedishHolidays } from './sweden'

export type CountryCode = 'SE' | 'NB' | 'GB'

export type { Holiday }

/**
 * Holidays for a specific country and year. Unknown country → empty
 * array (graceful degradation: callers don't crash, they just get no
 * holiday signal). Country code is uppercased on entry.
 */
export function getHolidaysForCountry(country: string | null | undefined, year: number): Holiday[] {
  const c = String(country ?? 'SE').toUpperCase()
  switch (c) {
    case 'SE': return getSwedishHolidays(year)
    // case 'NB': return getNorwegianHolidays(year)
    // case 'GB': return getBritishHolidays(year)
    default:   return []
  }
}

/**
 * Holidays in the next `daysAhead` days starting from `fromDate`
 * (YYYY-MM-DD inclusive). Spans year boundaries automatically (so a
 * 60-day window in late November returns both the current year's and
 * next year's matches).
 *
 * Used by:
 *   - /api/holidays/upcoming (UI surfacing)
 *   - AI context builders (forecast/budget) to inject holiday awareness
 */
export function getUpcomingHolidays(
  country: string | null | undefined,
  fromDate: string,
  daysAhead: number = 30,
): Holiday[] {
  const from = parseYmd(fromDate)
  if (!from) return []
  const toMs = Date.UTC(from.y, from.m - 1, from.d) + daysAhead * 86_400_000
  const to   = new Date(toMs)
  const toYmd = `${to.getUTCFullYear()}-${pad(to.getUTCMonth() + 1)}-${pad(to.getUTCDate())}`

  // Pull the relevant year(s). Most of the time fromDate's year is
  // enough; when the window crosses 31 Dec we also need year+1.
  const years = new Set<number>([from.y])
  if (to.getUTCFullYear() !== from.y) years.add(to.getUTCFullYear())

  const all: Holiday[] = []
  for (const y of years) all.push(...getHolidaysForCountry(country, y))

  return all
    .filter(h => h.date >= fromDate && h.date <= toYmd)
    .sort((a, b) => a.date.localeCompare(b.date))
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function parseYmd(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
}
