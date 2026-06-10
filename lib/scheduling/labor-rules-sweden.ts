// lib/scheduling/labor-rules-sweden.ts
//
// Canonical, CITED Swedish labour ruleset for restaurant/hotel scheduling.
// Single source of truth consumed by both the compliance engine
// (lib/scheduling/compliance.ts) and the scheduling AI prompt
// (lib/ai/rules.ts → /api/scheduling/ai-recommend). Encoding the rules once
// means the AI's suggestions and the pre-publish check can never drift.
//
// THREE LAYERS:
//   1. STATUTE   — Arbetstidslagen (1982:673). Applies to EVERY employer.
//   2. AGREEMENT — Visita–HRF "Gröna Riksavtalet" (the hotel/restaurant
//                  kollektivavtal). Applies when the business is bound by it
//                  (Visita member or hängavtal with HRF). Adds rules on top
//                  of statute (e.g. the hard 10h/24h cap) and defines OB.
//   3. MINOR     — Minderårigas arbetsmiljö (AFS 2012:3) + ATL minderårs-
//                  regler. Protects under-18s. A collective agreement can
//                  NEVER weaken these (av.se: "Kollektivavtal kan inte
//                  ersätta reglerna om arbetstider för minderåriga").
//
// SOURCES (verified 2026-06; see docs/SWEDISH-LABOUR-COMPLIANCE.md):
//   · Arbetstidslag (1982:673) — riksdagen.se
//       §5  ordinarie arbetstid 40 h/vecka
//       §13 dygnsvila ≥11 h sammanhängande/24 h, bör innehålla 00–05
//       §14 veckovila ≥36 h sammanhängande/7 dygn, helst på helgen
//       §15 rast — ingen får arbeta >6 h utan rast
//       §10b sammanlagd arbetstid ≤48 h/vecka i snitt över 4 mån
//   · Visita–HRF Gröna Riksavtalet 2025-04-01–2027-03-31 — hrf.net
//       ordinarie 40 h/vecka; arbetstid får ej överstiga 10 h per 24 h;
//       11 h dygnsvila + 36 h veckovila bekräftas
//   · OB-tillägg band — hrf.net/din-lon/ob-tillagg (Apr 2025):
//       vardag (mån–fre) 20:00→06:00; lördag (+ midsommar-/jul-/nyårsafton)
//       16:00→06:00; söndag + helgdag 06:00→06:00; nattillägg 01:00–06:00
//   · Minderårigas arbetsmiljö (AFS 2012:3) + av.se:
//       ungdom (fyllt 16, gått ut nian): nattvila 22:00–06:00 (el. 23–07)
//       arbetsfri; ≥12 h dygnsvila (får kortas till 11 h om passet slutar
//       22–24 el. börjar 05–07); ≤8 h/dag, ≤40 h/vecka; ≥2 dygn veckovila.
//
// OB is encoded as TIME BANDS only (when premiums apply), not kr amounts —
// per owner decision the AI uses "relative awareness" (prefer trimming the
// expensive bands first) so there are no tariff figures to maintain.

export type RuleBasis = 'statute' | 'agreement' | 'minor'
export type AgreementType = 'visita_hrf' | 'hangavtal_hrf' | 'none'

// ── Per-business configuration ────────────────────────────────────────
export interface LaborConfig {
  /** Which collective agreement binds the business. 'none' = statute only. */
  agreement: AgreementType
  /** Apply the minderår (under-18) protections. Default off; flip on per
   *  business when a minor is on the roster (and tag the staff as minors). */
  enforce_minor_rules: boolean
  // Overridable numeric knobs — defaults below come straight from the law /
  // agreement. Only override when a local agreement genuinely differs.
  min_daily_rest_h?:    number   // statute 11
  min_weekly_rest_h?:   number   // statute 36
  max_hours_per_24h?:   number   // agreement 10 (statute: no fixed cap)
  max_weekly_hours?:    number   // statute 48 (avg/4mo; we check the week)
  ordinary_weekly_hours?: number // statute 40 (basis for contract-floor math)
  max_consecutive_days?: number  // proxy for veckovila; 6
}

export const DEFAULT_LABOR_CONFIG: LaborConfig = {
  agreement: 'visita_hrf',         // Chicce is bound by the Visita–HRF avtal
  enforce_minor_rules: false,
}

export const STATUTE = {
  MIN_DAILY_REST_H:  11,   // ATL §13
  MIN_WEEKLY_REST_H: 36,   // ATL §14
  ORDINARY_WEEKLY_H: 40,   // ATL §5
  MAX_WEEKLY_H:      48,   // ATL §10b (snitt över 4 mån)
  RAST_AFTER_H:      6,    // ATL §15 — rast senast efter 6 h
} as const

export const AGREEMENT_VISITA_HRF = {
  MAX_HOURS_PER_24H: 10,   // Gröna Riksavtalet — får ej överstiga 10 h/24 h
  MIN_DAILY_REST_H:  11,
  MIN_WEEKLY_REST_H: 36,
  ORDINARY_WEEKLY_H: 40,
} as const

export const MINOR = {
  // Ungdom som fyllt 16 och gått ut nian (the realistic restaurant case).
  NIGHT_FREE_START: 22,    // 22:00 — arbetsfri natt börjar
  NIGHT_FREE_END:   6,     // 06:00 — arbetsfri natt slutar
  MIN_DAILY_REST_H: 12,    // dygnsvila (får kortas till 11 i vissa fall)
  MAX_HOURS_PER_DAY: 8,
  MAX_WEEKLY_H:     40,
  MIN_WEEKLY_REST_DAYS: 2, // veckovila ≥2 dygn/7-dygnsperiod
} as const

// Resolve the effective numeric limits for a business given its config.
export function resolveLimits(config: LaborConfig) {
  const agreementBound = config.agreement !== 'none'
  return {
    agreementBound,
    minDailyRestH:   config.min_daily_rest_h   ?? STATUTE.MIN_DAILY_REST_H,
    minWeeklyRestH:  config.min_weekly_rest_h  ?? STATUTE.MIN_WEEKLY_REST_H,
    maxWeeklyH:      config.max_weekly_hours   ?? STATUTE.MAX_WEEKLY_H,
    ordinaryWeeklyH: config.ordinary_weekly_hours ?? STATUTE.ORDINARY_WEEKLY_H,
    maxConsecDays:   config.max_consecutive_days ?? 6,
    // The 10h/24h cap only exists in the agreement. Statute-only businesses
    // have no fixed per-24h cap (just the 11h rest, which implies ≤13h).
    maxHoursPer24h:  config.max_hours_per_24h
                       ?? (agreementBound ? AGREEMENT_VISITA_HRF.MAX_HOURS_PER_24H : null),
  }
}

// ── OB (obekväm arbetstid) band classification ────────────────────────
// Returns, for a single shift, how many of its hours fall in an OB band and
// how many fall in the night band (01:00–06:00). Used for "relative
// awareness": the AI prefers trimming OB-heavy hours because they cost more,
// without needing the exact kr tariff.
//
// Day classification for the 06:00→24:00 part of a day:
//   · Sunday OR public holiday → OB from 06:00 (whole day)
//   · Saturday                 → OB from 16:00
//   · Mon–Fri                  → OB from 20:00
// The 00:00→06:00 part of EVERY day is OB (it is the tail of the previous
// day's band, which always runs to 06:00). Night band 01:00–06:00 always.
export interface ObBreakdown {
  total_hours: number
  ob_hours:    number   // hours in any OB band
  night_hours: number   // subset: hours in 01:00–06:00
  ob_fraction: number   // ob_hours / total_hours (0..1)
}

function obStateAt(weekday: number, isHoliday: boolean, minutesSinceMidnight: number): { ob: boolean; night: boolean } {
  const m = minutesSinceMidnight
  const night = m >= 60 && m < 360            // 01:00–06:00
  if (m < 360) return { ob: true, night }     // 00:00–06:00 is always OB
  // 06:00–24:00 depends on the day
  if (isHoliday || weekday === 0) return { ob: true, night }          // Sunday / helgdag
  if (weekday === 6) return { ob: m >= 16 * 60, night }               // Saturday → 16:00
  return { ob: m >= 20 * 60, night }                                   // Mon–Fri → 20:00
}

/**
 * Compute the OB / night breakdown for a shift.
 * @param shiftDate   'YYYY-MM-DD' (the local calendar date the shift starts)
 * @param startLocal  'HH:MM' local
 * @param endLocal    'HH:MM' local (may be ≤ start meaning it crosses midnight)
 * @param isHolidayDate optional predicate: does 'YYYY-MM-DD' fall on a Swedish
 *                      public holiday? Defaults to "never" — pass the holidays
 *                      module (lib/holidays) for full accuracy.
 */
export function obBreakdownForShift(
  shiftDate: string,
  startLocal: string,
  endLocal: string,
  isHolidayDate: (dateISO: string) => boolean = () => false,
): ObBreakdown {
  const [sh, sm] = startLocal.split(':').map(Number)
  const [eh, em] = endLocal.split(':').map(Number)
  let startMin = sh * 60 + (sm || 0)
  let endMin   = eh * 60 + (em || 0)
  if (endMin <= startMin) endMin += 24 * 60   // crosses midnight

  const base = new Date(shiftDate + 'T00:00:00Z')
  const STEP = 15
  let total = 0, ob = 0, night = 0
  for (let t = startMin; t < endMin; t += STEP) {
    const dayOffset = Math.floor(t / (24 * 60))
    const minOfDay  = t % (24 * 60)
    const d = new Date(base); d.setUTCDate(d.getUTCDate() + dayOffset)
    const iso = d.toISOString().slice(0, 10)
    const weekday = d.getUTCDay()   // 0=Sun..6=Sat
    const st = obStateAt(weekday, isHolidayDate(iso), minOfDay)
    const frac = STEP / 60
    total += frac
    if (st.ob)    ob    += frac
    if (st.night) night += frac
  }
  return {
    total_hours: Math.round(total * 100) / 100,
    ob_hours:    Math.round(ob * 100) / 100,
    night_hours: Math.round(night * 100) / 100,
    ob_fraction: total > 0 ? Math.round((ob / total) * 100) / 100 : 0,
  }
}

// Human-readable OB band summary for the AI prompt + UI tooltips.
export const OB_BANDS_DESCRIPTION =
  'OB (obekväm arbetstid) applies: Mon–Fri 20:00–06:00, Saturday 16:00–06:00, ' +
  'Sunday & public holidays all day, with an extra night premium 01:00–06:00. ' +
  'These hours cost more, so trimming them saves the most.'
