// app/api/reviews/themes/route.ts
//
// Per-business rolling theme aggregation. Returns:
//   - top_themes: by combined "weight" = count × |sentiment-mean|
//   - rating_trend: avg rating per week over the window
//   - sentiment_trend: avg overall sentiment per week
//   - sample_size: total reviews in window
//   - latest: most recent review with classified themes
//
// Query: ?business_id=<uuid>&window=30 (days; default 30, max 365)
// Auth: any role that can see this business (owner/manager/viewer/revisor).

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { canAccessBusiness }                 from '@/lib/auth/permissions'
import { CATEGORIES }                        from '@/lib/reviews/classifier'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface ThemeAgg {
  category:        string
  positive_count:  number
  negative_count:  number
  mixed_count:     number
  total_count:     number
  net_sentiment:   number     // positives − negatives, normalised by total
  example_phrases: string[]   // top 3 representative quotes
  weight:          number     // count × |net_sentiment| — used for ranking
}

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
  const windowDays = Math.min(365, Math.max(1, parseInt(url.searchParams.get('window') ?? '30', 10) || 30))

  if (!businessId)                            return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!canAccessBusiness(subject, businessId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = createAdminClient()
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()

  const { data: rows, error } = await db
    .from('review_themes')
    .select('rating, published_at, themes, sentiment, key_phrase, language')
    .eq('business_id', businessId)
    .gte('published_at', since)
    .order('published_at', { ascending: false })
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const reviews = (rows ?? []) as Array<{
    rating:       number | null
    published_at: string
    themes:       Record<string, { polarity: '+' | '-' | '~'; confidence: number; phrase: string }>
    sentiment:    number | null
    key_phrase:   string | null
    language:     string | null
  }>

  // ── Aggregate per category ──────────────────────────────────────────
  const byCat: Record<string, ThemeAgg> = {}
  for (const cat of CATEGORIES) {
    byCat[cat] = {
      category:        cat,
      positive_count:  0,
      negative_count:  0,
      mixed_count:     0,
      total_count:     0,
      net_sentiment:   0,
      example_phrases: [],
      weight:          0,
    }
  }

  // For each category, accumulate phrases by polarity so we can pick the
  // most representative examples (top by confidence within the dominant
  // polarity).
  const phrasePool: Record<string, Array<{ phrase: string; confidence: number; polarity: '+' | '-' | '~' }>> = {}
  for (const cat of CATEGORIES) phrasePool[cat] = []

  for (const r of reviews) {
    if (!r.themes || typeof r.themes !== 'object') continue
    for (const cat of CATEGORIES) {
      const t = r.themes[cat]
      if (!t) continue
      const agg = byCat[cat]
      agg.total_count++
      if      (t.polarity === '+') agg.positive_count++
      else if (t.polarity === '-') agg.negative_count++
      else                          agg.mixed_count++
      const conf = Number(t.confidence)
      if (Number.isFinite(conf) && t.phrase) {
        phrasePool[cat].push({ phrase: t.phrase, confidence: conf, polarity: t.polarity })
      }
    }
  }

  // Compute weights + example phrases
  for (const cat of CATEGORIES) {
    const agg = byCat[cat]
    if (agg.total_count === 0) continue
    agg.net_sentiment = (agg.positive_count - agg.negative_count) / agg.total_count
    // Weight = total mentions × magnitude of net sentiment. Categories
    // with high mentions AND a clear lean (positive or negative) rank
    // highest. A category with 20 mixed mentions ranks lower than 5
    // strongly-negative mentions.
    agg.weight = agg.total_count * (Math.abs(agg.net_sentiment) + 0.15)
    // Examples: prefer the dominant polarity's top-confidence phrases.
    const dominant = agg.positive_count >= agg.negative_count ? '+' : '-'
    const pool = phrasePool[cat]
      .filter(p => p.polarity === dominant || (agg.positive_count === agg.negative_count))
      .sort((a, b) => b.confidence - a.confidence)
    const seen = new Set<string>()
    for (const p of pool) {
      const k = p.phrase.toLowerCase().slice(0, 40)
      if (seen.has(k)) continue
      seen.add(k)
      agg.example_phrases.push(p.phrase)
      if (agg.example_phrases.length >= 3) break
    }
  }

  const topThemes = Object.values(byCat)
    .filter(a => a.total_count > 0)
    .sort((a, b) => b.weight - a.weight)

  // ── Weekly trends (rating + sentiment) ──────────────────────────────
  const weeklyBuckets: Record<string, { ratings: number[]; sentiments: number[] }> = {}
  for (const r of reviews) {
    const wk = weekKey(r.published_at)
    if (!weeklyBuckets[wk]) weeklyBuckets[wk] = { ratings: [], sentiments: [] }
    if (r.rating != null)        weeklyBuckets[wk].ratings.push(r.rating)
    if (r.sentiment != null)     weeklyBuckets[wk].sentiments.push(Number(r.sentiment))
  }
  const trend = Object.entries(weeklyBuckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, data]) => ({
      week,
      avg_rating:    data.ratings.length    ? mean(data.ratings)    : null,
      avg_sentiment: data.sentiments.length ? mean(data.sentiments) : null,
      sample_n:      data.ratings.length,
    }))

  const overallAvgRating = reviews.length && reviews.some(r => r.rating != null)
    ? mean(reviews.filter(r => r.rating != null).map(r => r.rating as number))
    : null

  return NextResponse.json({
    business_id:    businessId,
    window_days:    windowDays,
    sample_size:    reviews.length,
    avg_rating:     overallAvgRating,
    top_themes:     topThemes,
    weekly_trend:   trend,
    latest_review:  reviews[0] ?? null,
    generated_at:   new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

// ISO week key — e.g. "2026-W19". Stable for sorting.
function weekKey(iso: string): string {
  const d = new Date(iso)
  // Copy date so we don't mutate; align to Thursday (ISO standard)
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNr = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNr + 3)
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const diff = (target.getTime() - firstThursday.getTime()) / 86_400_000
  const week = 1 + Math.floor(diff / 7)
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}
