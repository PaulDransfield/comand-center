// app/api/inventory/items/ai-fill-bulk/route.ts
//
// POST — run AI-fill across many products in one go. Auto-applies
// suggestions where the model reports confidence >= the threshold (default
// 0.85); lower-confidence ones come back in a "needs review" list so the
// owner can fall back to the per-item modal.
//
// Body: { business_id, scope?: 'recipes_only' | 'all', max?: number,
//         confidence_threshold?: number }
//
// Default scope is 'recipes_only' — only products referenced by at least
// one recipe. This is the practical owner workflow: get the recipes
// list cost-complete before broadening to the long tail.
//
// Single-shot sync processing. Cap at 50 products / call so the function
// runs within Vercel's default 60s budget; UI can click again to drain.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { checkAndIncrementAiLimit } from '@/lib/ai/usage'
import { aiFillProduct, applyAiFillSuggestion } from '@/lib/inventory/ai-fill-product'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const MAX_PER_CALL = 50
const CONCURRENCY  = 3   // Haiku is fast; 3 concurrent keeps headroom for Anthropic rate limit

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let businessId: string, scope: 'recipes_only' | 'all', max: number, threshold: number
  try {
    const body = await req.json()
    businessId = String(body.business_id ?? '').trim()
    scope      = body.scope === 'all' ? 'all' : 'recipes_only'
    max        = Math.min(MAX_PER_CALL, Math.max(1, parseInt(String(body.max ?? 25), 10) || 25))
    threshold  = Math.min(1, Math.max(0, Number(body.confidence_threshold ?? 0.85)))
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // Pull candidate products: at least one missing fillable field.
  // We DON'T pre-filter on "has supplier_article link" — aiFillProduct
  // will return error: 'no linked supplier articles' for those, and
  // they'll get bucketed as 'no_source' without consuming Anthropic.
  let q = db.from('products')
    .select('id, name, pack_size, base_unit, weight_per_piece_g, density_g_per_ml, category')
    .eq('business_id', businessId)
    .is('archived_at', null)
    .or('pack_size.is.null,base_unit.is.null,weight_per_piece_g.is.null,density_g_per_ml.is.null,category.is.null')

  if (scope === 'recipes_only') {
    // Inner-join via recipe_ingredients — only products used in a recipe.
    // Two-step pattern (PostgREST embed picks one FK if multiple exist; we
    // explicitly filter via .in() to be safe).
    const { data: refs } = await db.from('recipe_ingredients')
      .select('product_id').not('product_id', 'is', null).range(0, 9999)
    const ids = Array.from(new Set((refs ?? []).map((r: any) => r.product_id).filter(Boolean)))
    if (ids.length === 0) {
      return NextResponse.json({ ok: true, scope, processed: 0, applied: 0, queued_for_review: [], no_source: [], remaining: 0 })
    }
    // Batch the .in() at 100 to avoid the silent-null cap (we may have many).
    const collected: any[] = []
    for (let i = 0; i < ids.length; i += 100) {
      const slice = ids.slice(i, i + 100)
      const { data: chunk } = await q.in('id', slice).range(0, 999)
      if (chunk) collected.push(...chunk)
      // Re-create query for next iteration since .in() consumed it
      q = db.from('products')
        .select('id, name, pack_size, base_unit, weight_per_piece_g, density_g_per_ml, category')
        .eq('business_id', businessId)
        .is('archived_at', null)
        .or('pack_size.is.null,base_unit.is.null,weight_per_piece_g.is.null,density_g_per_ml.is.null,category.is.null')
    }
    const products = collected.slice(0, max)
    const remaining = collected.length - products.length
    return await processBatch(db, auth.orgId, products, threshold, scope, remaining)
  }

  const { data: products } = await q.range(0, max - 1)
  const remaining = await db.from('products')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .is('archived_at', null)
    .or('pack_size.is.null,base_unit.is.null,weight_per_piece_g.is.null,density_g_per_ml.is.null,category.is.null')
    .then((r: any) => Math.max(0, (r.count ?? 0) - (products?.length ?? 0)))
  return await processBatch(db, auth.orgId, products ?? [], threshold, scope, remaining)
}

async function processBatch(
  db:        any,
  orgId:     string,
  products:  Array<{ id: string; name: string }>,
  threshold: number,
  scope:     'recipes_only' | 'all',
  remaining: number,
): Promise<NextResponse> {
  if (products.length === 0) {
    return NextResponse.json({ ok: true, scope, processed: 0, applied: 0, queued_for_review: [], no_source: [], remaining })
  }

  // Single quota gate up-front — N products × 1 LLM call each. If the
  // gate blocks we return the partial state cleanly.
  const usage = await checkAndIncrementAiLimit(db, orgId)
  if (!usage.ok) return NextResponse.json(usage.body, { status: usage.status })

  const applied:    Array<{ product_id: string; name: string; fields: string[]; confidence: number }> = []
  const review:     Array<{ product_id: string; name: string; reason: string; confidence?: number }> = []
  const noSource:   Array<{ product_id: string; name: string }> = []

  // Concurrency-limited iteration. Process in waves of CONCURRENCY so
  // we keep Anthropic happy and the wall time bounded.
  let i = 0
  async function worker() {
    while (i < products.length) {
      const idx = i++
      const p = products[idx]
      try {
        const r = await aiFillProduct(db, p.id)
        if (!r.ok) {
          if (r.error?.includes('No linked supplier') || r.error?.includes('No supplier article data')) {
            noSource.push({ product_id: p.id, name: p.name })
          } else {
            review.push({ product_id: p.id, name: p.name, reason: r.error ?? 'unknown' })
          }
          continue
        }
        const s = r.suggestion!
        const conf = typeof s.confidence === 'number' ? s.confidence : 0
        if (conf >= threshold) {
          const w = await applyAiFillSuggestion(db, p.id, s)
          if (w.ok && w.applied_fields.length > 0) {
            applied.push({ product_id: p.id, name: p.name, fields: w.applied_fields, confidence: conf })
          } else {
            review.push({ product_id: p.id, name: p.name, reason: w.error ?? 'no applicable fields', confidence: conf })
          }
        } else {
          review.push({ product_id: p.id, name: p.name, reason: `low confidence (${conf.toFixed(2)})`, confidence: conf })
        }
      } catch (e: any) {
        review.push({ product_id: p.id, name: p.name, reason: e?.message ?? 'exception' })
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

  return NextResponse.json({
    ok:                true,
    scope,
    processed:         products.length,
    applied:           applied.length,
    applied_details:   applied,
    queued_for_review: review,
    no_source:         noSource,
    remaining,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
