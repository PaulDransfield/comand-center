// lib/holidays/uk.ts
//
// UK bank holidays + restaurant-relevant observed days. Covers England
// & Wales — Scotland and Northern Ireland have a different set, deferred
// until we have a customer there. Same shape as sweden.ts / norway.ts.
//
// Substitute-Monday rule: when 1 Jan, 25 Dec, or 26 Dec falls on a
// weekend, the bank holiday moves to the next Monday (sometimes Tuesday
// for Boxing Day if Christmas was on Sunday). UK gov calls this a
// "substitute day".
//
// Categories:
//   'public'   — official UK bank holiday (banks closed)
//   'observed' — not official but de-facto restaurant-relevant
//                (Christmas Eve, New Year's Eve)

import { easterSunday, fmt, addDays, firstWeekdayInMonth, lastWeekdayInMonth } from './_easter'
import type { Holiday } from './sweden'

/** When `date` falls on a weekend, return the next Monday (or Tuesday
 *  if next Mon is already a substitute for an earlier holiday). */
function substituteMondayIfWeekend(year: number, month: number, day: number, alreadyTakenDates?: Set<string>): { year: number; month: number; day: number } {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  if (dow >= 1 && dow <= 5) return { year, month, day }     // weekday — no shift
  // Sat → +2 to Mon; Sun → +1 to Mon
  let shifted = addDays(year, month, day, dow === 6 ? 2 : 1)
  if (alreadyTakenDates && alreadyTakenDates.has(fmt(shifted.year, shifted.month, shifted.day))) {
    // Boxing Day fallthrough: if Christmas already took Monday, push Boxing Day to Tuesday
    shifted = addDays(shifted.year, shifted.month, shifted.day, 1)
  }
  return shifted
}

export function getBritishHolidays(year: number): Holiday[] {
  const easter = easterSunday(year)
  const goodFriday   = addDays(easter.year, easter.month, easter.day, -2)
  const easterMonday = addDays(easter.year, easter.month, easter.day, +1)

  const earlyMay  = firstWeekdayInMonth(year, 5, 1)   // first Monday of May
  const springBh  = lastWeekdayInMonth(year, 5, 1)    // last Monday of May
  const summerBh  = lastWeekdayInMonth(year, 8, 1)    // last Monday of August

  // Substitute-day handling for the New Year + Christmas trio.
  const nyOrigDow      = new Date(Date.UTC(year, 0, 1)).getUTCDay()
  const newYear        = nyOrigDow === 0 || nyOrigDow === 6
    ? substituteMondayIfWeekend(year, 1, 1)
    : { year, month: 1, day: 1 }

  // Christmas + Boxing — track which dates are already taken so Boxing
  // Day can fall to Tuesday when Christmas takes the Monday slot.
  const taken = new Set<string>()
  const xmasOrigDow = new Date(Date.UTC(year, 11, 25)).getUTCDay()
  const xmas        = xmasOrigDow === 0 || xmasOrigDow === 6
    ? substituteMondayIfWeekend(year, 12, 25)
    : { year, month: 12, day: 25 }
  taken.add(fmt(xmas.year, xmas.month, xmas.day))

  const boxOrigDow = new Date(Date.UTC(year, 11, 26)).getUTCDay()
  const boxing     = boxOrigDow === 0 || boxOrigDow === 6
    ? substituteMondayIfWeekend(year, 12, 26, taken)
    : { year, month: 12, day: 26 }

  const list: Holiday[] = [
    { date: fmt(newYear.year, newYear.month, newYear.day),
                                  name_sv: 'Nyårsdagen',          name_en: "New Year's Day",       kind: 'public',   impact: null,   country: 'GB' },
    { date: fmt(goodFriday.year, goodFriday.month, goodFriday.day),
                                  name_sv: 'Långfredagen',         name_en: 'Good Friday',           kind: 'public',   impact: 'low',  country: 'GB' },
    { date: fmt(easter.year, easter.month, easter.day),
                                  name_sv: 'Påskdagen',            name_en: 'Easter Sunday',         kind: 'observed', impact: 'low',  country: 'GB' },  // not official UK bank holiday but most restaurants close
    { date: fmt(easterMonday.year, easterMonday.month, easterMonday.day),
                                  name_sv: 'Annandag påsk',        name_en: 'Easter Monday',         kind: 'public',   impact: null,   country: 'GB' },
    { date: fmt(year, 5, earlyMay.day),
                                  name_sv: 'Tidiga maj-helgen',    name_en: 'Early May Bank Holiday', kind: 'public',  impact: null,   country: 'GB' },
    { date: fmt(year, 5, springBh.day),
                                  name_sv: 'Vårhelgdagen',         name_en: 'Spring Bank Holiday',   kind: 'public',   impact: null,   country: 'GB' },
    { date: fmt(year, 8, summerBh.day),
                                  name_sv: 'Sommarhelgdagen',      name_en: 'Summer Bank Holiday',   kind: 'public',   impact: null,   country: 'GB' },
    { date: fmt(year, 12, 24), name_sv: 'Julafton',                name_en: "Christmas Eve",         kind: 'observed', impact: 'high', country: 'GB' },
    { date: fmt(xmas.year, xmas.month, xmas.day),
                                  name_sv: 'Juldagen',             name_en: 'Christmas Day',         kind: 'public',   impact: 'low',  country: 'GB' },
    { date: fmt(boxing.year, boxing.month, boxing.day),
                                  name_sv: 'Annandag jul',         name_en: 'Boxing Day',            kind: 'public',   impact: null,   country: 'GB' },
    { date: fmt(year, 12, 31), name_sv: 'Nyårsafton',              name_en: "New Year's Eve",        kind: 'observed', impact: 'high', country: 'GB' },
  ]

  return list.sort((a, b) => a.date.localeCompare(b.date))
}

// Self-tests:
//   2026: New Year 1 Jan (Thu, no shift), Easter 5 Apr, Good Friday 3 Apr,
//         Easter Mon 6 Apr, Early May 4 May, Spring 25 May, Summer 31 Aug,
//         Christmas 25 Dec (Fri, no shift), Boxing 26 Dec (Sat — moves to Mon 28 Dec)
//   2027: 1 Jan (Fri); Christmas 25 Dec (Sat → Mon 27 Dec), Boxing → Tue 28 Dec
