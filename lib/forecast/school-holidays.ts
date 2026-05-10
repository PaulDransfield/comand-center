// lib/forecast/school-holidays.ts
//
// Lookup helper for the school_holidays table (M056 + M067 seed). Used by
// dailyForecast() to populate the `school_holiday` field of inputs_snapshot
// with real data instead of the Piece 2 stub.
//
// The factor map (per-holiday-name multipliers) reflects restaurant
// industry patterns in Sweden. These are conservative defaults until we
// have enough resolved-row history to compute per-business factors:
//
//   - Sportlov / Höstlov / Påsklov:  -10% (slight downturn — families away)
//   - Jullov:                         depends on day-of-period (covered separately
//                                     by the holiday signal proper)
//   - Sommarlov:                     -5% (slight downturn — workers on vacation,
//                                     but tourist/lunch crowd partially compensates;
//                                     coastal/tourist restaurants would actually
//                                     LIFT here, but that's a per-business signal
//                                     for a future pass)
//
// Per-business override path: future Piece 4 LLM adjustment can read the
// snapshot and override based on what the operator has historically
// experienced during a specific holiday name.

const DEFAULT_FACTOR_BY_NAME: Record<string, number> = {
  'Sportlov':  0.90,
  'Höstlov':   0.92,
  'Påsklov':   0.93,
  'Jullov':    1.00,   // covered by the holiday signal — neutral here to avoid double-applying
  'Sommarlov': 0.95,
}

export interface ActiveSchoolHoliday {
  name:           string
  kommun:         string
  lan:            string
  start_date:     string
  end_date:       string
  applied_factor: number
}

/**
 * Returns the active school holiday for the given business + date, or
 * null if no school holiday is in effect on that date for that kommun.
 *
 * Falls back to län-level matching only if the business has a `lan`
 * value AND no kommun-specific row matches. (For now we exclusively
 * lookup by kommun since the seed is comprehensive for Sweden's largest
 * kommuns; län fallback is a future-proofing hook for when we expand.)
 */
export async function getActiveSchoolHoliday(
  db:        any,
  kommun:    string | null | undefined,
  forecastDate: Date,
): Promise<ActiveSchoolHoliday | null> {
  if (!kommun) return null
  const dateIso = ymd(forecastDate)

  const { data, error } = await db
    .from('school_holidays')
    .select('kommun, lan, start_date, end_date, name')
    .eq('kommun', kommun)
    .lte('start_date', dateIso)
    .gte('end_date',   dateIso)
    .limit(1)
    .maybeSingle()

  if (error || !data) return null

  const factor = DEFAULT_FACTOR_BY_NAME[data.name] ?? 1.0
  return {
    name:           data.name,
    kommun:         data.kommun,
    lan:            data.lan,
    start_date:     data.start_date,
    end_date:       data.end_date,
    applied_factor: factor,
  }
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}
