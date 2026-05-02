// app/api/holidays/upcoming/route.ts
//
// Returns the next holidays for the active business's country (defaults
// to SE per the businesses.country column). Used by the dashboard's
// upcoming-holidays card and any AI context builder that wants holiday
// awareness when generating forecasts.
//
// Locale-aware: returns the holiday name in the caller's locale (sv|nb
// fall back to en). Auth-gated — same getRequestAuth pattern as the
// other /api/me/* endpoints, since holiday data per se isn't sensitive
// but country resolution depends on the user's businesses.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { getUpcomingHolidays, type Holiday } from '@/lib/holidays'

export const runtime         = 'nodejs'
export const dynamic         = 'force-dynamic'
export const preferredRegion = 'fra1'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') ?? 30)))
  const businessId = url.searchParams.get('business_id')

  const db = createAdminClient()

  // Resolve country from the requested business (when given) or the
  // org's first business (when omitted). Defaults to 'SE' if nothing
  // is set — matches the businesses.country column default.
  let country: string = 'SE'
  if (businessId) {
    const { data: biz } = await db
      .from('businesses')
      .select('country')
      .eq('id', businessId)
      .eq('org_id', auth.orgId)
      .maybeSingle()
    if (biz?.country) country = String(biz.country).toUpperCase()
  } else {
    const { data: biz } = await db
      .from('businesses')
      .select('country')
      .eq('org_id', auth.orgId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (biz?.country) country = String(biz.country).toUpperCase()
  }

  // Locale: the cc_locale cookie is the source of truth post-first-visit.
  // Falls back to en for `name` when the cookie value isn't 'sv'.
  const localeCookie = req.cookies.get('cc_locale')?.value ?? 'en-GB'
  const localePref   = localeCookie === 'sv' ? 'sv' : 'en'

  const today = new Date()
  const fromYmd = `${today.getUTCFullYear()}-${pad(today.getUTCMonth() + 1)}-${pad(today.getUTCDate())}`

  const holidays: Holiday[] = getUpcomingHolidays(country, fromYmd, days)

  // Project to the locale-specific name (caller doesn't need both).
  const projected = holidays.map(h => ({
    date:    h.date,
    name:    localePref === 'sv' ? h.name_sv : h.name_en,
    name_sv: h.name_sv,
    name_en: h.name_en,
    kind:    h.kind,
    impact:  h.impact,
    country: h.country,
    /** Days until the holiday (0 = today, 1 = tomorrow). Useful for the
     *  "in N days" badge in the dashboard card. */
    days_until: daysBetween(fromYmd, h.date),
  }))

  return NextResponse.json({
    country,
    from:     fromYmd,
    days_ahead: days,
    holidays: projected,
  }, {
    // Stable for the rest of the day at minimum — holidays don't move.
    // Keep cache short enough that "days_until" stays accurate to the day.
    headers: { 'Cache-Control': 'private, max-age=900, stale-while-revalidate=3600' },
  })
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split('-').map(Number)
  const [ty, tm, td] = toYmd.split('-').map(Number)
  const fromMs = Date.UTC(fy, fm - 1, fd)
  const toMs   = Date.UTC(ty, tm - 1, td)
  return Math.round((toMs - fromMs) / 86_400_000)
}
