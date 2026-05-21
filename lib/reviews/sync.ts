// lib/reviews/sync.ts
//
// Per-business review sync. Shared by:
//   - /api/cron/reviews-sync (daily for all businesses with google_place_id)
//   - /api/reviews/sync       (owner-triggered, single business)
//
// Returns a structured summary so the caller can surface either an admin
// log (cron) or a toast/inline result (UI button).

import { fetchPlaceReviews } from './google-places'
import { classifyReview }    from './classifier'
import { logAiRequest }      from '@/lib/ai/usage'

export interface BizSyncTarget {
  id:              string
  org_id:          string
  name:            string
  google_place_id: string
}

export interface BizSyncSummary {
  business_id:       string
  business_name:     string
  fetched_reviews:   number   // total returned by Google (≤5)
  new_raw_reviews:   number   // newly upserted (or already existed but not classified)
  classified:        number   // successfully analysed and inserted into review_themes
  classify_skipped:  number   // Anthropic call failed
  errors:            string[]
}

export async function syncReviewsForBusiness(db: any, biz: BizSyncTarget): Promise<BizSyncSummary> {
  const summary: BizSyncSummary = {
    business_id:      biz.id,
    business_name:    biz.name,
    fetched_reviews:  0,
    new_raw_reviews:  0,
    classified:       0,
    classify_skipped: 0,
    errors:           [],
  }

  const fetched = await fetchPlaceReviews(biz.google_place_id)
  if (!fetched) {
    summary.errors.push('Google Places fetch failed — check API key + Place ID')
    return summary
  }
  summary.fetched_reviews = fetched.reviews.length

  // M077: persist the summary fields BEFORE we early-return on the
  // "0 new reviews this sync" path. Owner-facing surface relies on
  // google_review_count + google_overall_rating to render the real
  // total (e.g. "278 reviews") even when no new review content lands.
  await db.from('businesses').update({
    google_review_count:   fetched.rating_count   ?? null,
    google_overall_rating: fetched.overall_rating ?? null,
    google_last_sync_at:   new Date().toISOString(),
  }).eq('id', biz.id).then(() => {}, () => {})

  if (fetched.reviews.length === 0) return summary

  // Upsert into review_raw
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
  const { error: upsertErr } = await db
    .from('review_raw')
    .upsert(rawRows, { onConflict: 'business_id,source,external_id' })
  if (upsertErr) {
    summary.errors.push(`upsert: ${upsertErr.message}`)
    return summary
  }

  // Find reviews that don't yet have a themes row — those need LLM classification
  const externalIds = fetched.reviews.map(rv => rv.external_id)
  const { data: existingThemes } = await db
    .from('review_themes')
    .select('external_id')
    .eq('business_id', biz.id)
    .eq('source', 'google_places')
    .in('external_id', externalIds)
  const classifiedSet = new Set((existingThemes ?? []).map((r: any) => r.external_id))
  const needClassify = fetched.reviews.filter(rv => !classifiedSet.has(rv.external_id))
  summary.new_raw_reviews = needClassify.length

  for (const rv of needClassify) {
    const cls = await classifyReview({
      text:          rv.text,
      rating:        rv.rating,
      language:      rv.language,
      business_name: biz.name,
    })
    if (!cls) {
      summary.classify_skipped++
      continue
    }

    const { error: themeErr } = await db
      .from('review_themes')
      .insert({
        org_id:       biz.org_id,
        business_id:  biz.id,
        source:       'google_places',
        external_id:  rv.external_id,
        rating:       rv.rating,
        published_at: rv.published_at,
        themes:       cls.themes,
        sentiment:    cls.sentiment,
        key_phrase:   cls.key_phrase,
        language:     cls.language,
        llm_model:    cls.model,
      })
    if (themeErr) {
      summary.errors.push(`themes insert ${rv.external_id.slice(-8)}: ${themeErr.message}`)
      continue
    }
    summary.classified++

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

  return summary
}

// Prune review_raw rows older than 30 days — Google Places TOS compliance.
// Returns the count deleted. Safe to call any time; runs as part of the
// daily cron but the manual button skips it (single-business sync doesn't
// need to do TOS housekeeping every click).
export async function pruneOldReviewRaw(db: any): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { error, count } = await db
    .from('review_raw')
    .delete({ count: 'exact' })
    .lt('fetched_at', cutoff)
  if (error) {
    console.warn('[reviews/sync] prune failed:', error.message)
    return 0
  }
  return count ?? 0
}
