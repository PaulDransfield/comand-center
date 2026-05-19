// lib/events/ticketmaster.ts
//
// Stockholm events fetcher via Ticketmaster Discovery API.
//
// Free tier: 5,000 calls/day, 5 req/s. More than enough — a daily sync
// pulling 60 days of Stockholm events typically lands in 3-8 paginated
// calls (200 events per page).
//
// Coverage: Tele2 Arena, Avicii Arena, Friends Arena, Cirkus, Annexet,
// Globen, plus smaller theatre and music venues. Misses food festivals
// and community events on Stockholm Stad's open data portal — those
// land in a sibling fetcher (v2).
//
// Docs: https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/
// Get key: https://developer.ticketmaster.com → free account
// Set TICKETMASTER_API_KEY in env (see /docs/env.md).

const TM_API_BASE = 'https://app.ticketmaster.com/discovery/v2'

export interface NormalizedEvent {
  source:              'ticketmaster'
  source_id:           string
  name:                string | null
  description:         string | null
  category:            string                    // concert / sports / theatre / conference / festival / other
  start_at:            string                    // ISO UTC
  end_at:              string | null
  venue_name:          string | null
  venue_city:          string | null
  venue_country:       string | null
  venue_lat:           number | null
  venue_lng:           number | null
  expected_attendance: number | null
  venue_capacity:      number | null
  url:                 string | null
  raw:                 unknown
}

// Map Ticketmaster segment names → our internal category enum.
const SEGMENT_TO_CATEGORY: Record<string, string> = {
  'music':           'concert',
  'sports':          'sports',
  'arts & theatre':  'theatre',
  'film':            'other',
  'miscellaneous':   'other',
  'family':          'other',
}

function mapSegmentToCategory(segment: string | null | undefined): string {
  if (!segment) return 'other'
  const key = segment.toLowerCase().trim()
  return SEGMENT_TO_CATEGORY[key] ?? 'other'
}

/**
 * Fetch Stockholm events from Ticketmaster for a date range.
 *
 * Defaults: 0 days from now → 60 days ahead. Paginates internally; caller
 * receives a flat array of raw event objects (not normalized — that's
 * `normalizeTicketmasterEvent` below so failed normalizations can be
 * logged separately).
 *
 * Throws on missing API key or any HTTP non-2xx.
 */
export async function fetchStockholmEvents(opts: {
  fromDays?: number       // days from now to start window (default 0)
  toDays?:   number       // days from now to end window (default 60)
  pageSize?: number       // events per page (default 200, max 200)
  maxPages?: number       // safety cap (default 20)
  apiKey?:   string       // override for tests
} = {}): Promise<any[]> {
  const apiKey = opts.apiKey ?? process.env.TICKETMASTER_API_KEY
  if (!apiKey) throw new Error('TICKETMASTER_API_KEY not set in environment')

  const fromDays  = opts.fromDays ?? 0
  const toDays    = opts.toDays   ?? 60
  const pageSize  = Math.min(opts.pageSize ?? 200, 200)
  const maxPages  = opts.maxPages ?? 20

  const startDate = new Date()
  startDate.setUTCDate(startDate.getUTCDate() + fromDays)
  const endDate = new Date()
  endDate.setUTCDate(endDate.getUTCDate() + toDays)

  const events: any[] = []
  let page = 0
  let hasMore = true

  while (hasMore && page < maxPages) {
    const url = new URL(`${TM_API_BASE}/events.json`)
    url.searchParams.set('apikey',         apiKey)
    url.searchParams.set('city',           'Stockholm')
    url.searchParams.set('countryCode',    'SE')
    url.searchParams.set('startDateTime',  tmDateTime(startDate))
    url.searchParams.set('endDateTime',    tmDateTime(endDate))
    url.searchParams.set('size',           String(pageSize))
    url.searchParams.set('page',           String(page))

    const res = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json' },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Ticketmaster ${res.status}: ${body.slice(0, 200)}`)
    }
    const j = await res.json()
    const pageEvents = j?._embedded?.events ?? []
    events.push(...pageEvents)

    const totalPages = j?.page?.totalPages ?? 1
    page++
    hasMore = page < totalPages

    // Polite delay between paginated calls (5 req/s limit on free tier)
    if (hasMore) await new Promise(r => setTimeout(r, 250))
  }

  return events
}

/**
 * Convert a raw Ticketmaster event payload into our normalized shape.
 * Returns null when the event is missing essentials (id, start time).
 */
export function normalizeTicketmasterEvent(raw: any): NormalizedEvent | null {
  if (!raw?.id) return null

  const dates = raw.dates?.start ?? {}
  // dateTime is the precise ISO timestamp; dateTime may be missing on
  // TBA events where only a date is known. localDate alone we anchor
  // to noon local Stockholm to keep the day correct.
  const startAt = dates.dateTime
    ? String(dates.dateTime)
    : (dates.localDate ? `${dates.localDate}T12:00:00+01:00` : null)
  if (!startAt) return null

  // Some events have end times in dates.endDateTime (multi-day festivals)
  const endAt = raw.dates?.end?.dateTime ?? null

  const venue = raw._embedded?.venues?.[0] ?? null
  const venueLat = venue?.location?.latitude  ? parseFloat(venue.location.latitude)  : null
  const venueLng = venue?.location?.longitude ? parseFloat(venue.location.longitude) : null

  const classification = raw.classifications?.[0] ?? {}
  const segmentName = classification?.segment?.name ?? null
  const category = mapSegmentToCategory(segmentName)

  // Capacity sometimes appears as raw._embedded.venues[0].capacityNumeric
  const capacityRaw = venue?.capacityNumeric
  const venueCapacity = Number.isFinite(Number(capacityRaw)) ? Number(capacityRaw) : null

  return {
    source:              'ticketmaster',
    source_id:           String(raw.id),
    name:                raw.name ? String(raw.name) : null,
    description:         raw.info ? String(raw.info) : null,
    category,
    start_at:            new Date(startAt).toISOString(),
    end_at:              endAt ? new Date(endAt).toISOString() : null,
    venue_name:          venue?.name           ? String(venue.name)           : null,
    venue_city:          venue?.city?.name     ? String(venue.city.name)      : null,
    venue_country:       venue?.country?.name  ? String(venue.country.name)   : null,
    venue_lat:           Number.isFinite(venueLat) ? venueLat : null,
    venue_lng:           Number.isFinite(venueLng) ? venueLng : null,
    expected_attendance: null,                    // TM doesn't expose
    venue_capacity:      venueCapacity,
    url:                 raw.url ? String(raw.url) : null,
    raw,
  }
}

// Ticketmaster expects ISO-8601 without milliseconds and with 'Z' literal.
function tmDateTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}
