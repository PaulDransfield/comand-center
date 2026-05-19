// lib/events/impact.ts
//
// Per-business event impact computation. Given a business location and
// a forecast date, returns the events nearby with computed lift factors.
//
// Methodology (PredictHQ × Lineup.ai pattern):
//   - GEOGRAPHIC decay: events within 5 km of the business contribute;
//     linear falloff to 20% impact at the 5 km perimeter.
//   - TEMPORAL CURVE: leading + lagging — peak day-of, smaller before
//     and after. Restaurants near venues see lifts BEFORE concerts
//     (arrivals) AND day-of, and a small AFTER tail.
//   - CATEGORY BASE: concerts and festivals lift more than theatre /
//     conference. Calibrated against published research (concerts at
//     major venues drive +20-50% restaurant lifts day-of; theatre adds
//     5-10%).
//   - CAPACITY WEIGHT: large venues (10k+ capacity) carry full lift;
//     small venues (<1k) only 30%.
//
// These are educated v1 defaults — no calibration data yet. Once we
// have 2-3 weeks of post-deploy data we can compare actuals on
// high-event days vs the predictions and refine the constants per
// category. Plan §C of the Nordic Plan.

export interface EventRecord {
  id:                  string
  source:              string
  source_id:           string
  name:                string | null
  category:            string
  start_at:            string                    // ISO UTC
  end_at:              string | null
  venue_name:          string | null
  venue_city:          string | null
  venue_lat:           number | null
  venue_lng:           number | null
  venue_capacity:      number | null
  expected_attendance: number | null
  url:                 string | null
}

export interface EventImpact {
  event:           EventRecord
  distance_km:     number
  days_until:      number                        // negative if past
  temporal_factor: number                        // 0..1, peak 1.0 day-of
  distance_factor: number                        // 0.2..1.0
  capacity_factor: number                        // 0.3..1.0
  base_lift_pct:   number                        // category base, e.g. 20 for concert
  lift_pct:        number                        // FINAL combined lift % (multiplied factors)
}

// Maximum lift cap when summing multiple same-day events. Stops a Friday
// with a Tele2 concert + Avicii Arena show + festival from going +90%
// hyperbolic. Capped at +50% per day; if real outcomes exceed that
// we'll learn from the audit data and raise.
export const MAX_DAY_LIFT_PCT = 50

// Max distance considered (km). Beyond this the venue is unlikely to
// drive customer flow to a single restaurant.
const MAX_DISTANCE_KM = 5

// Days before / after event that the curve covers
const LEADING_DAYS  = 2    // up to 2 days before
const LAGGING_DAYS  = 1    // up to 1 day after

// Category base lift % (day-of, at venue itself, at major capacity)
const CATEGORY_BASE_LIFT_PCT: Record<string, number> = {
  concert:    20,
  sports:     15,
  festival:   18,
  theatre:     8,
  conference: 10,
  other:       5,
}

// Temporal curve — fraction of full base lift by days_until
//   day_until = +2  → 0.20  (arrivals starting)
//   day_until = +1  → 0.50  (night-before dinners)
//   day_until =  0  → 1.00  (day of event)
//   day_until = -1  → 0.30  (next-day tail)
function temporalFactor(daysUntil: number): number {
  if (daysUntil > LEADING_DAYS)  return 0
  if (daysUntil < -LAGGING_DAYS) return 0
  if (daysUntil === 2)  return 0.20
  if (daysUntil === 1)  return 0.50
  if (daysUntil === 0)  return 1.00
  if (daysUntil === -1) return 0.30
  return 0
}

// Distance decay — linear from 1.0 at 0 km to 0.2 at MAX_DISTANCE_KM
function distanceFactor(km: number): number {
  if (km <= 0) return 1.0
  if (km >= MAX_DISTANCE_KM) return 0
  return Math.max(0.2, 1 - (km / MAX_DISTANCE_KM))
}

// Capacity weighting — proxy for crowd size
function capacityFactor(capacity: number | null): number {
  if (capacity == null) return 0.6     // unknown → assume moderate
  if (capacity >= 10_000) return 1.0
  if (capacity >=  5_000) return 0.8
  if (capacity >=  1_000) return 0.5
  return 0.3
}

// Haversine distance between two WGS84 points, in kilometres.
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const R = 6371   // Earth radius km
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

/**
 * Compute the impact list for a single (business, forecastDate) cell.
 *
 * Walks the provided events array (already loaded by the caller from
 * the `events` table — typically restricted to the next 60 days of the
 * business's city). Returns events that have non-zero lift, sorted by
 * lift descending.
 *
 * Returns [] when business has no lat/lng (signal silently disabled).
 */
export function computeEventImpacts(args: {
  businessLat:  number | null
  businessLng:  number | null
  forecastDate: Date
  events:       EventRecord[]
}): EventImpact[] {
  const { businessLat, businessLng, forecastDate, events } = args
  if (businessLat == null || businessLng == null || !Number.isFinite(businessLat) || !Number.isFinite(businessLng)) {
    return []
  }

  const forecastMs = forecastDate.getTime()
  const out: EventImpact[] = []

  for (const e of events) {
    if (e.venue_lat == null || e.venue_lng == null) continue
    const km = haversineKm(businessLat, businessLng, e.venue_lat, e.venue_lng)
    if (km > MAX_DISTANCE_KM) continue

    const eventMs = new Date(e.start_at).getTime()
    if (!Number.isFinite(eventMs)) continue
    const daysUntil = Math.round((eventMs - forecastMs) / 86_400_000)
    const temporal = temporalFactor(daysUntil)
    if (temporal === 0) continue

    const distance = distanceFactor(km)
    const capacity = capacityFactor(e.venue_capacity)
    const base     = CATEGORY_BASE_LIFT_PCT[e.category] ?? CATEGORY_BASE_LIFT_PCT.other
    const lift     = base * temporal * distance * capacity

    if (lift < 0.5) continue   // round off noise

    out.push({
      event:           e,
      distance_km:     Math.round(km * 10) / 10,
      days_until:      daysUntil,
      temporal_factor: temporal,
      distance_factor: Math.round(distance * 100) / 100,
      capacity_factor: capacity,
      base_lift_pct:   base,
      lift_pct:        Math.round(lift * 10) / 10,
    })
  }

  out.sort((a, b) => b.lift_pct - a.lift_pct)
  return out
}

/**
 * Aggregate the per-event lifts into a single day-level lift percentage.
 * Sums all events' contributions and caps at MAX_DAY_LIFT_PCT to prevent
 * a runaway "concert + sports + festival" Friday from blowing up the
 * prediction by 90%.
 */
export function aggregateDayLiftPct(impacts: EventImpact[]): number {
  const sum = impacts.reduce((s, i) => s + i.lift_pct, 0)
  return Math.min(sum, MAX_DAY_LIFT_PCT)
}
