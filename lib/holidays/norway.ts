// lib/holidays/norway.ts
//
// Norwegian public holidays (offentlige fridager) + restaurant-relevant
// observed days. Same shape + categories as sweden.ts so the country
// router and every consumer (dashboard card, OverviewChart red labels,
// AI prompts) treats them identically.
//
// Categories:
//   'public'   — official red day in the Norwegian calendar (banks closed)
//   'observed' — not officially public but de-facto restaurant-relevant
//                (Christmas Eve, New Year's Eve)
//
// Impact hint:
//   'high' — peak revenue / packed service
//   'low'  — most restaurants close or run reduced service
//   null   — minor effect

import { easterSunday, fmt, addDays } from './_easter'
import type { Holiday } from './sweden'

export function getNorwegianHolidays(year: number): Holiday[] {
  const easter = easterSunday(year)

  const maundyThursday = addDays(easter.year, easter.month, easter.day, -3)  // Skjærtorsdag
  const goodFriday     = addDays(easter.year, easter.month, easter.day, -2)  // Langfredag
  const easterMonday   = addDays(easter.year, easter.month, easter.day, +1)  // 2. påskedag
  const ascension      = addDays(easter.year, easter.month, easter.day, +39) // Kristi himmelfartsdag (Thu)
  const pentecost      = addDays(easter.year, easter.month, easter.day, +49) // Pinsedag (Sun)
  const whitMonday     = addDays(easter.year, easter.month, easter.day, +50) // 2. pinsedag

  // Norwegian holidays use the SE 'NO' country code in our data shape.
  // Note: Norway's storage convention is 'NO' uppercase ISO-3166-1 alpha-2,
  // matching businesses.country values. The Holiday type signature has
  // country: 'SE' from sweden.ts — we widen it to string at the country
  // index level. For this module we cast to satisfy the type.
  const list: Holiday[] = [
    { date: fmt(year, 1, 1),   name_sv: 'Nyårsdagen',          name_en: "New Year's Day",       kind: 'public',   impact: null,   country: 'NO' },
    { date: fmt(maundyThursday.year, maundyThursday.month, maundyThursday.day),
                                  name_sv: 'Skärtorsdag',     name_en: 'Maundy Thursday',       kind: 'public',   impact: null,   country: 'NO' },
    { date: fmt(goodFriday.year, goodFriday.month, goodFriday.day),
                                  name_sv: 'Långfredagen',     name_en: 'Good Friday',           kind: 'public',   impact: 'low',  country: 'NO' },
    { date: fmt(easter.year, easter.month, easter.day),
                                  name_sv: 'Påskdagen',        name_en: 'Easter Sunday',         kind: 'public',   impact: 'low',  country: 'NO' },
    { date: fmt(easterMonday.year, easterMonday.month, easterMonday.day),
                                  name_sv: 'Annandag påsk',    name_en: 'Easter Monday',         kind: 'public',   impact: null,   country: 'NO' },
    { date: fmt(year, 5, 1),   name_sv: 'Första maj',          name_en: 'Labour Day',            kind: 'public',   impact: null,   country: 'NO' },
    { date: fmt(year, 5, 17),  name_sv: 'Norges nationaldag',  name_en: "Norway's Constitution Day", kind: 'public', impact: 'high', country: 'NO' },
    { date: fmt(ascension.year, ascension.month, ascension.day),
                                  name_sv: 'Kristi himmelsfärds dag', name_en: 'Ascension Day',  kind: 'public',   impact: null,   country: 'NO' },
    { date: fmt(pentecost.year, pentecost.month, pentecost.day),
                                  name_sv: 'Pingstdagen',       name_en: 'Whit Sunday',          kind: 'public',   impact: null,   country: 'NO' },
    { date: fmt(whitMonday.year, whitMonday.month, whitMonday.day),
                                  name_sv: 'Annandag pingst',  name_en: 'Whit Monday',           kind: 'public',   impact: null,   country: 'NO' },
    { date: fmt(year, 12, 24), name_sv: 'Julafton',            name_en: "Christmas Eve",         kind: 'observed', impact: 'high', country: 'NO' },
    { date: fmt(year, 12, 25), name_sv: 'Juldagen',            name_en: 'Christmas Day',         kind: 'public',   impact: 'low',  country: 'NO' },
    { date: fmt(year, 12, 26), name_sv: 'Annandag jul',        name_en: 'Boxing Day',            kind: 'public',   impact: null,   country: 'NO' },
    { date: fmt(year, 12, 31), name_sv: 'Nyårsafton',          name_en: "New Year's Eve",        kind: 'observed', impact: 'high', country: 'NO' },
  ]

  return list.sort((a, b) => a.date.localeCompare(b.date))
}

// Self-tests for the curious — wire into a unit test file later:
//   easterSunday(2026)            → { year: 2026, month: 4, day: 5 }
//   Easter Mon 2026 = 6 Apr
//   Constitution Day 2026 = 17 May (Sun)
//   Ascension 2026 = 14 May (Thu)
