// app/api/cron/reviews-sync/route.ts
//
// Daily review-intelligence sync. For each business with a
// google_place_id, fetches the latest reviews from Google Places (≤ 5
// per call), upserts the verbatim text into review_raw (30-day TTL),
// classifies new reviews via Haiku 4.5, and stores structured themes.
//
// Per-business work lives in lib/reviews/sync.syncReviewsForBusiness so
// the manual "Sync now" button on /reviews can reuse the same code path.
//
// Schedule: 04:20 UTC daily (vercel.json). Cron secret required.
// Soft-fails when GOOGLE_PLACES_API_KEY or ANTHROPIC_API_KEY are missing.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient }           from '@/lib/supabase/server'
import { checkCronSecret }             from '@/lib/admin/check-secret'
import { withCronLog }                 from '@/lib/cron/log'
import { log }                         from '@/lib/log/structured'
import { syncReviewsForBusiness, pruneOldReviewRaw } from '@/lib/reviews/sync'

export const runtime         = 'nodejs'
export const preferredRegion = 'fra1'
export const dynamic         = 'force-dynamic'
export const maxDuration     = 300

export async function GET(req: NextRequest) {
  noStore()
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return withCronLog('reviews-sync', async () => {
    if (!process.env.GOOGLE_PLACES_API_KEY) {
      log.warn('reviews-sync skipped: GOOGLE_PLACES_API_KEY not set', {
        route: 'cron/reviews-sync',
      })
      return NextResponse.json({
        ok: true,
        skipped: 'GOOGLE_PLACES_API_KEY not configured',
      })
    }

    const db = createAdminClient()
    const t0 = Date.now()

    const { data: businesses } = await db
      .from('businesses')
      .select('id, org_id, name, google_place_id')
      .eq('is_active', true)
      .not('google_place_id', 'is', null)

    const targets = (businesses ?? []) as Array<{
      id: string; org_id: string; name: string; google_place_id: string
    }>

    log.info('reviews-sync starting', {
      route:        'cron/reviews-sync',
      target_count: targets.length,
    })

    let placesQueried   = 0
    let newRaw          = 0
    let classified      = 0
    let classifySkipped = 0
    const errors: string[] = []

    for (const biz of targets) {
      try {
        const s = await syncReviewsForBusiness(db, biz)
        placesQueried++
        newRaw          += s.new_raw_reviews
        classified      += s.classified
        classifySkipped += s.classify_skipped
        for (const e of s.errors) errors.push(`${s.business_name}: ${e}`)
      } catch (e: any) {
        errors.push(`${biz.name}: ${e?.message ?? String(e)}`)
      }
    }

    const pruned = await pruneOldReviewRaw(db)

    const summary = {
      ok:               true,
      duration_ms:      Date.now() - t0,
      places_queried:   placesQueried,
      new_raw_reviews:  newRaw,
      classified,
      classify_skipped: classifySkipped,
      pruned,
      errors:           errors.slice(0, 10),
    }
    log.info('reviews-sync done', { route: 'cron/reviews-sync', ...summary })
    return NextResponse.json(summary)
  })
}
