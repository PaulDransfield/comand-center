// app/api/reviews/summary/route.ts
//
// One-shot summary endpoint for the /reviews page header. Returns the
// numbers the four KpiCards display:
//
//   - overall_rating (from businesses.google_overall_rating)
//   - total_reviews_on_google (from businesses.google_review_count)
//   - reviews_in_db (count we've actually ingested — capped at ~5 by
//     Google's per-call limit, but Places returns 5 most recent)
//   - replied_count / needs_reply_count (from review_themes.replied_at)
//   - avg_response_hours (avg of replied_at - published_at)
//   - last_sync_at + place_id_set (status indicators)
//
// Query: ?business_id=<uuid>
// Auth:  any role that can see this business.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { canAccessBusiness }                 from '@/lib/auth/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const subject = {
    role:              auth.role as any,
    business_ids:      (auth as any).businessIds ?? null,
    can_view_finances: true,
  }

  const url        = new URL(req.url)
  const businessId = url.searchParams.get('business_id') ?? ''
  if (!businessId)                            return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!canAccessBusiness(subject, businessId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = createAdminClient()

  // Summary fields off the businesses row.
  const { data: biz } = await db
    .from('businesses')
    .select('id, name, google_place_id, google_review_count, google_overall_rating, google_last_sync_at')
    .eq('id', businessId)
    .maybeSingle()

  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 })

  // Reply-state counts off review_themes. One row = one review we've
  // classified; replied_at is the manual "marked as replied" timestamp.
  const { data: themes } = await db
    .from('review_themes')
    .select('rating, published_at, replied_at')
    .eq('business_id', businessId)
    .eq('source', 'google_places')

  const themesList = (themes ?? []) as any[]
  const reviewsInDb     = themesList.length
  const repliedRows     = themesList.filter(t => t.replied_at)
  const needsReplyRows  = themesList.filter(t => !t.replied_at)
  const repliedCount    = repliedRows.length
  const needsReplyCount = needsReplyRows.length

  // Avg response time (hours) — across replied reviews only.
  let avgResponseHours: number | null = null
  if (repliedRows.length > 0) {
    const totalMs = repliedRows.reduce((acc, r) => {
      const a = r.published_at ? new Date(r.published_at).getTime() : null
      const b = r.replied_at   ? new Date(r.replied_at).getTime()   : null
      if (!a || !b || b <= a) return acc
      return acc + (b - a)
    }, 0)
    if (totalMs > 0) {
      avgResponseHours = Math.round(totalMs / repliedRows.length / 3_600_000)
    }
  }

  // Rating distribution from the rows we DO have. Note this is from the
  // ≤5 ingested, not the 278 total — clearly labelled in the UI.
  const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  for (const t of themesList) {
    const r = Number(t.rating)
    if (r >= 1 && r <= 5) distribution[r as 1 | 2 | 3 | 4 | 5] += 1
  }

  return NextResponse.json({
    business_id:              biz.id,
    business_name:            biz.name,
    place_id_set:             !!biz.google_place_id,
    last_sync_at:             biz.google_last_sync_at,

    overall_rating:           biz.google_overall_rating != null ? Number(biz.google_overall_rating) : null,
    total_reviews_on_google:  biz.google_review_count   != null ? Number(biz.google_review_count)   : null,

    reviews_in_db:            reviewsInDb,
    replied_count:            repliedCount,
    needs_reply_count:        needsReplyCount,
    avg_response_hours:       avgResponseHours,

    star_distribution_in_db:  distribution,
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}
