// app/api/reviews/insights/route.ts
//
// "What to improve / what customers love" — the LLM reads across all the
// review themes for a business and returns two 5-point lists: recurring
// complaints to fix (framed to improve performance + revenue) and recurring
// praise to protect/amplify.
//
// Derived from review_themes (LLM-derived per-review themes + evidence
// phrases), NOT raw Google text — so it survives the 30-day raw-text prune.
// Cached 24h in review_insights (M104) so a page load doesn't re-bill the AI;
// defensive — if that table isn't there yet it just computes fresh.
//
// GET /api/reviews/insights?business_id=X&window=90&force=1

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { canAccessBusiness } from '@/lib/auth/permissions'
import { CATEGORIES } from '@/lib/reviews/classifier'
import { AI_MODELS } from '@/lib/ai/models'
import { anthropicFetch } from '@/lib/ai/anthropic-fetch'
import { checkAndIncrementAiLimit, logAiRequest } from '@/lib/ai/usage'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const CACHE_TTL_MS = 24 * 3600 * 1000
const MIN_REVIEWS  = 3

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const subject = { role: auth.role as any, business_ids: (auth as any).businessIds ?? null, can_view_finances: true }
  const url        = new URL(req.url)
  const businessId = url.searchParams.get('business_id') ?? ''
  const windowDays = Math.min(365, Math.max(1, parseInt(url.searchParams.get('window') ?? '90', 10) || 90))
  const force      = url.searchParams.get('force') === '1'
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!canAccessBusiness(subject, businessId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = createAdminClient()
  const noStoreHeaders = { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } }

  // ── Cache read (defensive — table may not exist until M104 is applied) ──
  if (!force) {
    try {
      const { data: cached } = await db.from('review_insights')
        .select('improvements, satisfactions, sample_size, generated_at')
        .eq('business_id', businessId).eq('window_days', windowDays).maybeSingle()
      if (cached && Date.now() - new Date(cached.generated_at).getTime() < CACHE_TTL_MS) {
        return NextResponse.json({ ...cached, cached: true }, noStoreHeaders)
      }
    } catch { /* table missing — compute fresh */ }
  }

  // ── Load review themes for the window ──
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  const { data: rows, error } = await db.from('review_themes')
    .select('rating, themes, sentiment, key_phrase')
    .eq('business_id', businessId).gte('published_at', since)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const reviews = (rows ?? []) as Array<{ rating: number | null; themes: Record<string, { polarity: '+' | '-' | '~'; confidence: number; phrase: string }>; sentiment: number | null; key_phrase: string | null }>

  if (reviews.length < MIN_REVIEWS) {
    return NextResponse.json({ improvements: [], satisfactions: [], sample_size: reviews.length, cached: false,
      message: `Only ${reviews.length} review(s) in the last ${windowDays} days — need at least ${MIN_REVIEWS} to spot patterns. Widen the window or sync more reviews.` }, noStoreHeaders)
  }

  // ── Aggregate negative / positive signals per category ──
  const neg: Record<string, { count: number; phrases: string[] }> = {}
  const pos: Record<string, { count: number; phrases: string[] }> = {}
  for (const c of CATEGORIES) { neg[c] = { count: 0, phrases: [] }; pos[c] = { count: 0, phrases: [] } }
  const ratingDist: Record<number, number> = {}
  for (const r of reviews) {
    if (r.rating != null) ratingDist[r.rating] = (ratingDist[r.rating] ?? 0) + 1
    if (!r.themes || typeof r.themes !== 'object') continue
    for (const c of CATEGORIES) {
      const t = r.themes[c]
      if (!t) continue
      const bucket = t.polarity === '-' ? neg[c] : t.polarity === '+' ? pos[c] : null
      if (!bucket) continue
      bucket.count++
      if (t.phrase && bucket.phrases.length < 4) bucket.phrases.push(t.phrase)
    }
  }
  const fmt = (m: Record<string, { count: number; phrases: string[] }>) =>
    Object.entries(m).filter(([, v]) => v.count > 0).sort((a, b) => b[1].count - a[1].count)
      .map(([c, v]) => `- ${c} (in ${v.count} review${v.count > 1 ? 's' : ''}): ${v.phrases.map(p => `"${p}"`).join('; ') || '(no quote)'}`).join('\n')
  const ratingLine = Object.entries(ratingDist).sort((a, b) => Number(b[0]) - Number(a[0])).map(([s, n]) => `${s}★×${n}`).join(', ')

  const dataBlock = `Reviews analysed: ${reviews.length} (last ${windowDays} days). Ratings: ${ratingLine || 'n/a'}.

NEGATIVE SIGNALS (complaints / criticism):
${fmt(neg) || '(none)'}

POSITIVE SIGNALS (praise):
${fmt(pos) || '(none)'}`

  // ── Quota gate (we're about to make the AI call) ──
  const usage = await checkAndIncrementAiLimit(db, auth.orgId)
  if (!usage.ok) return NextResponse.json(usage.body, { status: usage.status })

  const SYSTEM = `You are a restaurant operations advisor reading aggregated customer-review signals. Produce two lists, each EXACTLY 5 items, grounded ONLY in the signals provided:
1. "improvements" — the most impactful recurring complaints to fix, framed as concrete actions that would improve the guest experience, ratings, and ultimately revenue. Lead with the most-mentioned / most damaging.
2. "satisfactions" — what customers consistently praise, so the owner protects and leans into these strengths.
Each item: { "title": "short imperative (improvements) or short positive (satisfactions)", "detail": "1-2 sentences referencing the pattern and roughly how often it comes up" }.
Do not invent issues not in the signals. If there are fewer than 5 genuine patterns in a list, return what's real (don't pad).
Return JSON only: { "improvements": [...], "satisfactions": [...] }`

  const result = await anthropicFetch({
    body: { model: AI_MODELS.ANALYSIS, max_tokens: 1800, system: SYSTEM, messages: [{ role: 'user', content: dataBlock }] },
  })
  if (!result.ok) {
    return NextResponse.json({ error: `AI unavailable (${result.status})`, improvements: [], satisfactions: [], sample_size: reviews.length }, { status: 502 })
  }
  await logAiRequest(db, { org_id: auth.orgId, request_type: 'review_insights', model: AI_MODELS.ANALYSIS, input_tokens: result.tokensIn, output_tokens: result.tokensOut, duration_ms: result.durationMs }).catch(() => {})

  let improvements: Array<{ title: string; detail: string }> = []
  let satisfactions: Array<{ title: string; detail: string }> = []
  try {
    const text = result.json?.content?.[0]?.text ?? ''
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    const clean = (arr: any) => Array.isArray(arr) ? arr.filter((x: any) => x?.title).slice(0, 5).map((x: any) => ({ title: String(x.title).slice(0, 120), detail: String(x.detail ?? '').slice(0, 400) })) : []
    improvements  = clean(parsed.improvements)
    satisfactions = clean(parsed.satisfactions)
  } catch {
    return NextResponse.json({ error: 'Failed to parse AI response', improvements: [], satisfactions: [], sample_size: reviews.length }, { status: 502 })
  }

  const generated_at = new Date().toISOString()
  try {
    await db.from('review_insights').upsert({ business_id: businessId, window_days: windowDays, improvements, satisfactions, sample_size: reviews.length, generated_at }, { onConflict: 'business_id,window_days' })
  } catch { /* table missing — skip cache */ }

  return NextResponse.json({ improvements, satisfactions, sample_size: reviews.length, generated_at, cached: false }, noStoreHeaders)
}
