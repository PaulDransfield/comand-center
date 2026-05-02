// lib/holidays/sweden.ts
//
// Swedish public holidays (helgdagar) + restaurant-relevant observed days
// for any given year. Pure computation — no DB, no external API.
//
// Why pure compute over a stored table:
//   - The full year fits in ~16 rows; computing on demand is microseconds.
//   - No sync problem when we add years (computed forever).
//   - One source of truth in code, easy to add nb/gb later via a sibling
//     module + the country router.
//
// Easter is computed via the Anonymous Gregorian algorithm (Meeus/Jones/
// Butcher 1967). Verified against 2025 (20 Apr) and 2026 (5 Apr).
//
// We include three categories:
//   - 'public': official red days in the Swedish calendar (banks closed)
//   - 'observed': not officially public but de-facto restaurant-relevant
//                 (Christmas Eve, New Year's Eve, Midsummer Eve)
//
// And a coarse `impact` hint for the AI: 'high' (peak revenue / packed
// service) or 'low' (most restaurants closed). null = no strong signal.

export type HolidayKind   = 'public' | 'observed'
export type HolidayImpact = 'high' | 'low' | null

export interface Holiday {
  /** YYYY-MM-DD in local Sweden time. */
  date:    string
  /** Swedish name as commonly written. */
  name_sv: string
  /** English name for non-sv UI. */
  name_en: string
  /** Calendar status. */
  kind:    HolidayKind
  /** Coarse demand hint for forecasting AI. */
  impact:  HolidayImpact
  /** ISO country code — always 'SE' from this module. */
  country: 'SE'
}

/**
 * Anonymous Gregorian algorithm — returns Easter Sunday for the given
 * year as { year, month (1-12), day (1-31) }.
 */
function easterSunday(year: number): { year: number; month: number; day: number } {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)        // 3 or 4
  const day   = ((h + l - 7 * m + 114) % 31) + 1
  return { year, month, day }
}

/** Format a Date as YYYY-MM-DD (UTC-safe — uses the date components
 *  directly, no timezone conversion). */
function fmt(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Add `days` to a YYYY-MM-DD date and return the new YYYY-MM-DD. Uses
 *  UTC arithmetic to avoid DST surprises. */
function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day))
  d.setUTCDate(d.getUTCDate() + days)
  return {
    year:  d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day:   d.getUTCDate(),
  }
}

/** Find the first occurrence of `weekday` (0=Sun..6=Sat) within an
 *  inclusive date range. Used for Midsummer + All Saints' which are
 *  defined as "the [weekday] between [date] and [date]". */
function firstWeekdayInRange(year: number, month: number, dayStart: number, dayEnd: number, weekday: number): { month: number; day: number } {
  for (let d = dayStart; d <= dayEnd; d++) {
    const wd = new Date(Date.UTC(year, month - 1, d)).getUTCDay()
    if (wd === weekday) return { month, day: d }
  }
  // Window guarantees at least one match — but fall back to the start
  // if something pathological happens.
  return { month, day: dayStart }
}

/**
 * Return all Swedish holidays for the given year, sorted ascending by
 * date.
 */
export function getSwedishHolidays(year: number): Holiday[] {
  const easter = easterSunday(year)

  const goodFriday   = addDays(easter.year, easter.month, easter.day, -2)
  const easterMonday = addDays(easter.year, easter.month, easter.day, +1)
  const ascension    = addDays(easter.year, easter.month, easter.day, +39)  // Thu 39d after
  const pentecost    = addDays(easter.year, easter.month, easter.day, +49)  // Sun 49d after

  // Midsummer Eve = Friday between 19–25 June; Midsummer's Day = Sat 20–26 June.
  const midsummerEve = firstWeekdayInRange(year, 6, 19, 25, 5)  // Fri
  const midsummerDay = firstWeekdayInRange(year, 6, 20, 26, 6)  // Sat

  // All Saints' Day = Saturday between 31 Oct and 6 Nov.
  let allSaints: { month: number; day: number }
  // The window straddles months — try Oct 31 first, then Nov 1-6.
  if (new Date(Date.UTC(year, 9, 31)).getUTCDay() === 6) {
    allSaints = { month: 10, day: 31 }
  } else {
    allSaints = firstWeekdayInRange(year, 11, 1, 6, 6)
  }

  const list: Holiday[] = [
    { date: fmt(year, 1, 1),   name_sv: 'Nyårsdagen',           name_en: "New Year's Day",     kind: 'public',   impact: null,  country: 'SE' },
    { date: fmt(year, 1, 6),   name_sv: 'Trettondedag jul',     name_en: 'Epiphany',            kind: 'public',   impact: null,  country: 'SE' },
    { date: fmt(goodFriday.year, goodFriday.month, goodFriday.day),
                                  name_sv: 'Långfredagen',     name_en: 'Good Friday',          kind: 'public',   impact: 'low', country: 'SE' },
    { date: fmt(easter.year, easter.month, easter.day),
                                  name_sv: 'Påskdagen',         name_en: 'Easter Sunday',        kind: 'public',   impact: 'low', country: 'SE' },
    { date: fmt(easterMonday.year, easterMonday.month, easterMonday.day),
                                  name_sv: 'Annandag påsk',     name_en: 'Easter Monday',        kind: 'public',   impact: null,  country: 'SE' },
    { date: fmt(year, 4, 30),  name_sv: 'Valborgsmässoafton',   name_en: "Walpurgis Eve",        kind: 'observed', impact: 'high', country: 'SE' },
    { date: fmt(year, 5, 1),   name_sv: 'Första maj',           name_en: 'Labour Day',           kind: 'public',   impact: null,  country: 'SE' },
    { date: fmt(ascension.year, ascension.month, ascension.day),
                                  name_sv: 'Kristi himmelsfärds dag', name_en: 'Ascension Day',  kind: 'public',   impact: null,  country: 'SE' },
    { date: fmt(pentecost.year, pentecost.month, pentecost.day),
                                  name_sv: 'Pingstdagen',       name_en: 'Whit Sunday',          kind: 'public',   impact: null,  country: 'SE' },
    { date: fmt(year, 6, 6),   name_sv: 'Sveriges nationaldag', name_en: "Sweden's National Day", kind: 'public',   impact: 'high', country: 'SE' },
    { date: fmt(year, 6, midsummerEve.day),
                                  name_sv: 'Midsommarafton',    name_en: "Midsummer's Eve",      kind: 'observed', impact: 'high', country: 'SE' },
    { date: fmt(year, 6, midsummerDay.day),
                                  name_sv: 'Midsommardagen',    name_en: "Midsummer's Day",      kind: 'public',   impact: 'low', country: 'SE' },
    { date: fmt(year, allSaints.month, allSaints.day),
                                  name_sv: 'Alla helgons dag',  name_en: "All Saints' Day",      kind: 'public',   impact: null,  country: 'SE' },
    { date: fmt(year, 12, 24),  name_sv: 'Julafton',            name_en: "Christmas Eve",        kind: 'observed', impact: 'high', country: 'SE' },
    { date: fmt(year, 12, 25),  name_sv: 'Juldagen',            name_en: 'Christmas Day',        kind: 'public',   impact: 'low', country: 'SE' },
    { date: fmt(year, 12, 26),  name_sv: 'Annandag jul',        name_en: 'Boxing Day',           kind: 'public',   impact: null,  country: 'SE' },
    { date: fmt(year, 12, 31),  name_sv: 'Nyårsafton',          name_en: "New Year's Eve",       kind: 'observed', impact: 'high', country: 'SE' },
  ]

  return list.sort((a, b) => a.date.localeCompare(b.date))
}

// Self-tests for the curious — wire into a unit test file later:
//   easterSunday(2025) → { year: 2025, month: 4, day: 20 }
//   easterSunday(2026) → { year: 2026, month: 4, day: 5 }
//   Midsummer Eve 2026 → 19 June (Fri), Day → 20 June (Sat)
//   All Saints' 2026 → 31 Oct (Sat)
