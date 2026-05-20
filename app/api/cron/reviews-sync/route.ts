// app/api/cron/reviews-sync/route.ts
//
// Daily review-intelligence sync. For each business with a
// google_place_id, fetches the latest reviews from Google Places (≤ 5
// per call) and:
//
//   1. Upserts each into review_raw (verbatim text, 30-day TTL)
//   2. For each NEW review (not already in review_themes), classifies
//      via Haiku 4.5 and inserts into review_themes
//   3. Prunes review_raw rows older than 30 days (Google TOS compliance)
//
// Schedule: 04:30 UTC daily (vercel.json). Cron secret required.
// Soft-fails when GOOGLE_PLACES_API_KEY or ANTHROPIC_API_KEY are missing.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient }           from '@/lib/supabase/server'
import { checkCronSecret }             from '@/lib/admin/check-secret'
import { withCronLog }                 from '@/lib/cron/log'
import { log }                         from '@/lib/log/structured'
import { logAiRequest }                from '@/lib/ai/usage'
import { fetchPlaceReviews }           from '@/lib/reviews/google-places'
import { classifyReview }              from '@/lib/reviews/classifier'

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
    const placesKey = process.env.GOOGLE_PLACES_API_KEY
    if (!placesKey) {
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

    let placesQueried = 0
    let newRaw        = 0
    let classified    = 0
    let classifySkipped = 0
    let pruned        = 0
    const errors: string[] = []

    // ── Targets ────────────────────────────────────────────────────
    const { data: businesses } = await db
      .from('businesses')
      .select('id, org_id, name, google_place_id')
      .eq('is_active', true)
      .not('google_place_id', 'is', null)

    const targets = (businesses ?? []) as Array<{
      id: string; org_id: string; name: string; google_place_id: string
    }>

    log.info('reviews-sync starting', {
      route:       'cron/reviews-sync',
      target_count: targets.length,
    })

    // ── Per-business loop ──────────────────────────────────────────
    for (const biz of targets) {
      try {
        const fetched = await fetchPlaceReviews(biz.google_place_id)
        placesQueried++

        if (!fetched || fetched.reviews.length === 0) continue

        // Upsert reviews into review_raw
        const rawRows = fetched.reviews.map(rv => ({
          org_id:       biz.org_id,
          business_id:  biz.id,
          source:       'google_places',
          external_id:  rv.external_id,
          author_name:  rv.author_name,
          rating:       rv.rating,
          text:         rv.text,
          language:     rv.language,
          published_at: rv.published_at,
          fetched_at:   new Date().toISOString(),
        }))
        const { error: upsertErr, data: upserted } = await db
          .from('review_raw')
          .upsert(rawRows, { onConflict: 'business_id,source,external_id' })
          .select('id, external_id')
        if (upsertErr) {
          errors.push(`upsert ${biz.name}: ${upsertErr.message}`)
          continue
        }

        // Find reviews that don't yet have a themes row — those are NEW
        // and need classification.
        const externalIds = fetched.reviews.map(rv => rv.external_id)
        const { data: existingThemes } = await db
          .from('review_themes')
          .select('external_id')
          .eq('business_id', biz.id)
          .eq('source', 'google_places')
          .in('external_id', externalIds)
        const classifiedSet = new Set((existingThemes ?? []).map((r: any) => r.external_id))
        const needClassify = fetched.reviews.filter(rv => !classifiedSet.has(rv.external_id))

        newRaw += needClassify.length

        // Classify each new review and insert themes
        for (const rv of needClassify) {
          const cls = await classifyReview({
            text:          rv.text,
            rating:        rv.rating,
            language:      rv.language,
            business_name: biz.name,
          })
          if (!cls) {
            classifySkipped++
            continue
          }

          const { error: themeErr } = await db
            .from('review_themes')
            .insert({
              org_id:           biz.org_id,
              business_id:      biz.id,
              source:           'google_places',
              external_id:      rv.external_id,
              rating:           rv.rating,
              published_at:     rv.published_at,
              themes:           cls.themes,
              sentiment:        cls.sentiment,
              key_phrase:       cls.key_phrase,
              language:         cls.language,
              llm_model:        cls.model,
            })
          if (themeErr) {
            errors.push(`themes insert ${biz.name} ${rv.external_id.slice(-8)}: ${themeErr.message}`)
            continue
          }
          classified++

          // Telemetry — only if the call actually hit the API (not the
          // rating-only short-circuit which has model='rating-only')
          if (cls.model !== 'rating-only' && (cls.input_tokens > 0 || cls.output_tokens > 0)) {
            await logAiRequest(db, {
              org_id:        biz.org_id,
              request_type:  'review_classify',
              model:         cls.model,
              input_tokens:  cls.input_tokens,
              output_tokens: cls.output_tokens,
              duration_ms:   cls.ms,
            }).catch(() => {})
          }
        }
      } catch (e: any) {
        errors.push(`${biz.name}: ${e?.message ?? String(e)}`)
      }
    }

    // ── Prune raw rows older than 30 days (Google TOS) ─────────────
    try {
      const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
      const { error: pruneErr, count } = await db
        .from('review_raw')
        .delete({ count: 'exact' })
        .lt('fetched_at', cutoff)
      if (pruneErr) {
        errors.push(`prune: ${pruneErr.message}`)
      } else {
        pruned = count ?? 0
      }
    } catch (e: any) {
      errors.push(`prune-throw: ${e?.message ?? e}`)
    }

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
