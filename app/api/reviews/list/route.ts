// app/api/reviews/list/route.ts
//
// Per-business recent reviews list with classified themes attached.
// Joins review_themes (LLM analysis) with review_raw (verbatim text,
// available only for the 30-day TTL window) and returns the merged view.
//
// Query: ?business_id=<uuid>&limit=20 (max 100)

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
  const limit      = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '20', 10) || 20))

  if (!businessId)                            return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!canAccessBusiness(subject, businessId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = createAdminClient()

  // Themes — primary source (persistent). Newest first.
  const { data: themes, error: themesErr } = await db
    .from('review_themes')
    .select('external_id, rating, published_at, themes, sentiment, key_phrase, language, llm_model')
    .eq('business_id', businessId)
    .eq('source', 'google_places')
    .order('published_at', { ascending: false })
    .limit(limit)
  if (themesErr) {
    return NextResponse.json({ error: themesErr.message }, { status: 500 })
  }

  const list = (themes ?? []) as any[]
  if (list.length === 0) {
    return NextResponse.json({ reviews: [] }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
  }

  // Pull whatever raw text we still have (last 30 days). Older themes
  // get no .text field — UI shows just the LLM-derived summary.
  const externalIds = list.map(r => r.external_id)
  const { data: raws } = await db
    .from('review_raw')
    .select('external_id, author_name, text')
    .eq('business_id', businessId)
    .eq('source', 'google_places')
    .in('external_id', externalIds)
  const rawByExt: Record<string, { author_name: string | null; text: string | null }> = {}
  for (const r of (raws ?? []) as any[]) {
    rawByExt[r.external_id] = { author_name: r.author_name, text: r.text }
  }

  return NextResponse.json({
    reviews: list.map(r => ({
      external_id:  r.external_id,
      rating:       r.rating,
      published_at: r.published_at,
      themes:       r.themes,
      sentiment:    r.sentiment,
      key_phrase:   r.key_phrase,
      language:     r.language,
      llm_model:    r.llm_model,
      author_name:  rawByExt[r.external_id]?.author_name ?? null,
      // Raw text only present within the 30-day TTL window
      text:         rawByExt[r.external_id]?.text ?? null,
    })),
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}
