// lib/holidays/_easter.ts
//
// Shared Easter Sunday calculator + small date helpers used by every
// country-specific holiday module. Underscore prefix marks this as
// internal to lib/holidays — consumers go through index.ts.
//
// Easter via the Anonymous Gregorian algorithm (Meeus/Jones/Butcher
// 1967). Western Easter — also valid for Norway and UK; Eastern
// Orthodox Easter (Russia, Greece) uses a different rule we don't
// need yet.

/**
 * Returns Western Easter Sunday for the given year as
 * { year, month (1-12), day (1-31) }.
 */
export function easterSunday(year: number): { year: number; month: number; day: number } {
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

/** Format YMD components as YYYY-MM-DD. */
export function fmt(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Add `days` to a date, return new YMD. UTC arithmetic — DST-safe. */
export function addDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day))
  d.setUTCDate(d.getUTCDate() + days)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** First occurrence of weekday (0=Sun..6=Sat) in inclusive range. */
export function firstWeekdayInRange(year: number, month: number, dayStart: number, dayEnd: number, weekday: number): { month: number; day: number } {
  for (let d = dayStart; d <= dayEnd; d++) {
    const wd = new Date(Date.UTC(year, month - 1, d)).getUTCDay()
    if (wd === weekday) return { month, day: d }
  }
  return { month, day: dayStart }
}

/** Last occurrence of weekday in a given month. */
export function lastWeekdayInMonth(year: number, month: number, weekday: number): { month: number; day: number } {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  for (let d = lastDay; d >= 1; d--) {
    if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === weekday) return { month, day: d }
  }
  return { month, day: lastDay }
}

/** First occurrence of weekday in a given month. */
export function firstWeekdayInMonth(year: number, month: number, weekday: number): { month: number; day: number } {
  for (let d = 1; d <= 7; d++) {
    if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === weekday) return { month, day: d }
  }
  return { month, day: 1 }
}
