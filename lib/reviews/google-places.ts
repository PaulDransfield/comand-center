// lib/reviews/google-places.ts
//
// Thin wrapper around Google Places API (New) for fetching the latest
// reviews for a business by Place ID.
//
// Notes:
//   - The "Places API (New)" returns up to 5 most recent reviews per
//     call. Older reviews are not paginated — Google deliberately limits
//     external access to a snapshot. That's fine for a daily cron: new
//     reviews bubble up over time.
//   - review.name is the stable external identifier we dedup on.
//   - Reviews include publishTime (RFC3339) + originalText.languageCode
//     + rating + text (in originalText.text, plus a machine-translated
//     `text.text` field).
//   - We store the ORIGINAL text — the classifier translates to English
//     internally, but we never mangle the source.
//
// TOS reminder: do NOT cache review text beyond 30 days. The daily cron
// prunes review_raw rows older than that. review_themes is derived data
// and can be retained indefinitely.

export interface GoogleReview {
  external_id:  string   // stable ID (review.name)
  author_name:  string | null
  rating:       number | null
  text:         string | null
  language:     string | null
  published_at: string   // ISO timestamp
}

export interface GooglePlaceFetch {
  place_id:        string
  display_name:    string | null
  overall_rating:  number | null
  rating_count:    number | null
  reviews:         GoogleReview[]
}

const PLACES_URL_BASE = 'https://places.googleapis.com/v1/places'

// Fields we ask for. Keeping the list tight reduces our SKU billing tier
// (Google charges per field group on the new API). reviews+rating+name
// together qualify for Enterprise tier (~$0.025/call) — acceptable.
const FIELD_MASK = [
  'displayName',
  'rating',
  'userRatingCount',
  'reviews',
].join(',')

export async function fetchPlaceReviews(placeId: string): Promise<GooglePlaceFetch | null> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY
  if (!apiKey) {
    console.warn('[reviews/google-places] GOOGLE_PLACES_API_KEY missing — skip')
    return null
  }
  if (!placeId) return null

  let r: Response
  try {
    r = await fetch(`${PLACES_URL_BASE}/${encodeURIComponent(placeId)}`, {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key':    apiKey,
        'X-Goog-FieldMask':  FIELD_MASK,
      },
    })
  } catch (e: any) {
    console.warn(`[reviews/google-places] fetch error for ${placeId}:`, e?.message ?? e)
    return null
  }

  if (!r.ok) {
    const body = await r.text().catch(() => '')
    console.warn(`[reviews/google-places] ${r.status} for ${placeId}: ${body.slice(0, 200)}`)
    return null
  }

  const json = await r.json().catch(() => null) as any
  if (!json) return null

  const rawReviews = Array.isArray(json.reviews) ? json.reviews : []
  const reviews: GoogleReview[] = rawReviews.map((rv: any) => ({
    external_id:  String(rv.name ?? ''),
    author_name:  rv.authorAttribution?.displayName ?? null,
    rating:       Number.isFinite(rv.rating) ? rv.rating : null,
    // Prefer the ORIGINAL text — we keep source language; classifier translates.
    text:         rv.originalText?.text ?? rv.text?.text ?? null,
    language:     rv.originalText?.languageCode ?? rv.text?.languageCode ?? null,
    published_at: rv.publishTime ?? new Date().toISOString(),
  })).filter((rv: GoogleReview) => rv.external_id.length > 0)

  return {
    place_id:        placeId,
    display_name:    json.displayName?.text ?? null,
    overall_rating:  Number.isFinite(json.rating) ? json.rating : null,
    rating_count:    Number.isFinite(json.userRatingCount) ? json.userRatingCount : null,
    reviews,
  }
}

// Find a Place ID from a free-text query. Used by the connect flow when
// the owner types their restaurant name + city instead of pasting a Place
// ID. Returns the top match's Place ID + display name + formatted address
// for confirmation in the UI.
export async function searchPlaceByText(query: string): Promise<{
  place_id: string
  display_name: string
  formatted_address: string | null
} | null> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY
  if (!apiKey || !query.trim()) return null

  let r: Response
  try {
    r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'content-type':      'application/json',
        'X-Goog-Api-Key':    apiKey,
        'X-Goog-FieldMask':  'places.id,places.displayName,places.formattedAddress',
      },
      body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
    })
  } catch (e: any) {
    console.warn('[reviews/google-places] searchText error:', e?.message ?? e)
    return null
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    console.warn(`[reviews/google-places] searchText ${r.status}: ${body.slice(0, 200)}`)
    return null
  }

  const json = await r.json().catch(() => null) as any
  const place = json?.places?.[0]
  if (!place?.id) return null

  return {
    place_id:          String(place.id),
    display_name:      place.displayName?.text ?? '',
    formatted_address: place.formattedAddress ?? null,
  }
}
