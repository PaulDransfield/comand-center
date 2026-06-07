// app/api/inventory/waste/route.ts
//
// GET  ?business_id=&from=&to= → list waste entries
// POST { business_id, [product_id | recipe_id], quantity, unit, reason,
//        waste_date?, notes?, prep_session_id? }
//   → create new entry. Snapshots unit_price_at_entry + value_at_entry
//     for product rows; cost_estimate_sek for recipe rows. Exactly ONE
//     of product_id or recipe_id is required per row (XOR enforced both
//     here and in M139 schema CHECK).
//
// Batch shape: POST { business_id, events: [{ ... }, ...] } — each
// event has its own product_id/recipe_id/qty etc. Used by the prep-
// complete flow to log every wasted row in one round-trip.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { getProductLatestPrices, computeRecipeCost, loadRecipeIndex } from '@/lib/inventory/recipe-cost'
import { loadFxIndex } from '@/lib/inventory/fx'
import { convertQuantity } from '@/lib/inventory/unit-conversion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Includes M139 synonyms so the prep-complete form can use clearer
// language while the legacy /inventory/waste UI keeps its current vocab.
const REASONS = [
  'spoilage', 'spill', 'over_portion', 'staff_meal', 'comp', 'other',
  'overproduction', 'customer_complaint', 'training', 'theft', 'spillage',
] as const

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const url = new URL(req.url)
  const businessId = String(url.searchParams.get('business_id') ?? '').trim()
  const from = url.searchParams.get('from')
  const to   = url.searchParams.get('to')
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  let q = db
    .from('waste_log')
    .select('id, product_id, recipe_id, prep_session_id, waste_date, quantity, unit, unit_price_at_entry, value_at_entry, cost_estimate_sek, reason, notes, created_at, product:products(name, category, invoice_unit), recipe:recipes(name, type)')
    .eq('business_id', businessId)
    .order('waste_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500)
  if (from) q = q.gte('waste_date', from)
  if (to)   q = q.lte('waste_date', to)
  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const entries = (data ?? []).map((e: any) => {
    // Cost surface for both paths — recipe rows store cost_estimate_sek,
    // product rows store value_at_entry. Expose ONE field
    // `value_sek` to consumers so the UI can compute totals without
    // branching on row kind.
    const valueSek = e.recipe_id
      ? (e.cost_estimate_sek != null ? Number(e.cost_estimate_sek) : null)
      : (e.value_at_entry    != null ? Number(e.value_at_entry)    : null)
    return {
      id:             e.id,
      kind:           e.recipe_id ? 'recipe' as const : 'product' as const,
      product_id:     e.product_id,
      product_name:   (e.product as any)?.name ?? null,
      category:       (e.product as any)?.category ?? null,
      recipe_id:      e.recipe_id,
      recipe_name:    (e.recipe as any)?.name ?? null,
      recipe_type:    (e.recipe as any)?.type ?? null,
      prep_session_id: e.prep_session_id ?? null,
      waste_date:     e.waste_date,
      quantity:       Number(e.quantity),
      unit:           e.unit,
      unit_price_at_entry: e.unit_price_at_entry != null ? Number(e.unit_price_at_entry) : null,
      value_at_entry:      e.value_at_entry      != null ? Number(e.value_at_entry)      : null,
      cost_estimate_sek:   e.cost_estimate_sek   != null ? Number(e.cost_estimate_sek)   : null,
      value_sek:           valueSek,
      reason:         e.reason,
      notes:          e.notes,
      created_at:     e.created_at,
    }
  })

  // Summary: total value by reason
  const totalValue = entries.reduce((s, e) => s + (e.value_sek ?? 0), 0)
  const byReason: Record<string, number> = {}
  for (const e of entries) byReason[e.reason] = (byReason[e.reason] ?? 0) + (e.value_sek ?? 0)

  return NextResponse.json({
    entries,
    summary: {
      total_value: Math.round(totalValue * 100) / 100,
      by_reason:   byReason,
      count:       entries.length,
    },
  }, { headers: { 'Cache-Control': 'no-store' } })
}

interface InboundEvent {
  product_id?:       string | null
  recipe_id?:        string | null
  quantity:          number
  unit:              string
  reason:            string
  waste_date?:       string | null
  notes?:            string | null
  prep_session_id?:  string | null
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  let body: any
  try { body = await req.json() } catch { body = {} }

  const businessId = String(body.business_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  // Batch shape if `events` is present; otherwise single-event body.
  const inbound: InboundEvent[] = Array.isArray(body.events) ? body.events : [body]

  // Validate every event before touching the DB.
  const errors: string[] = []
  const validated: InboundEvent[] = []
  for (let i = 0; i < inbound.length; i++) {
    const e: any = inbound[i] ?? {}
    const productId = e.product_id ? String(e.product_id).trim() : null
    const recipeId  = e.recipe_id  ? String(e.recipe_id ).trim() : null
    if ((!productId && !recipeId) || (productId && recipeId)) {
      errors.push(`event[${i}]: exactly one of product_id or recipe_id is required`)
      continue
    }
    const quantity = Number(e.quantity)
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.push(`event[${i}]: quantity must be > 0`)
      continue
    }
    const unit = String(e.unit ?? '').trim()
    if (!unit) { errors.push(`event[${i}]: unit required`); continue }
    const reason = String(e.reason ?? '').trim()
    if (!REASONS.includes(reason as any)) {
      errors.push(`event[${i}]: reason must be one of: ${REASONS.join(', ')}`)
      continue
    }
    const notes = e.notes ? String(e.notes).trim().slice(0, 1000) : null
    validated.push({
      product_id:       productId,
      recipe_id:        recipeId,
      quantity, unit, reason, notes,
      waste_date:       e.waste_date ?? null,
      prep_session_id:  e.prep_session_id ?? null,
    })
  }
  if (errors.length > 0) {
    return NextResponse.json({ error: 'validation_failed', details: errors }, { status: 400 })
  }

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('org_id').eq('id', businessId).maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  // Costing — load FX index once + recipe index once, then per-event cost.
  const fxIndex = await loadFxIndex(db, ['EUR', 'USD', 'NOK', 'DKK', 'GBP'])
  const productIds = validated.filter(e => e.product_id).map(e => e.product_id!) as string[]
  const recipeIds  = validated.filter(e => e.recipe_id ).map(e => e.recipe_id !) as string[]

  // Pull product metadata for cost math (pack_size + base_unit needed)
  const productMeta = new Map<string, any>()
  if (productIds.length > 0) {
    const { data: prodRows } = await db
      .from('products')
      .select('id, business_id, invoice_unit, base_unit, pack_size')
      .eq('business_id', businessId)
      .in('id', productIds)
    for (const p of prodRows ?? []) productMeta.set((p as any).id, p)
  }
  const productPrices = productIds.length > 0
    ? await getProductLatestPrices(db, businessId, productIds, fxIndex)
    : new Map()

  // Recipe index lazy-loaded if any recipe events
  let recipeIndex: any = null
  if (recipeIds.length > 0) {
    try {
      recipeIndex = await loadRecipeIndex(db, businessId)
    } catch (e: any) {
      // Failure here is non-fatal; we'll just snapshot null cost for recipe rows.
      recipeIndex = null
    }
  }

  // If recipe events also reference products inside their ingredient
  // trees we need those product prices too. Load them all in one shot
  // when the recipe index exists.
  let recipeProductPrices: Map<string, any> | null = null
  if (recipeIndex && recipeIds.length > 0) {
    const allProdIds = new Set<string>()
    for (const rid of recipeIds) {
      const ctx = recipeIndex.get(rid)
      if (!ctx) continue
      for (const ing of ctx.ingredients) {
        if (ing.product_id) allProdIds.add(ing.product_id)
      }
    }
    if (allProdIds.size > 0) {
      recipeProductPrices = await getProductLatestPrices(db, businessId, Array.from(allProdIds), fxIndex)
    }
  }

  // Build insert rows
  const rows: any[] = []
  const skip: Array<{ event: InboundEvent; reason: string }> = []
  for (const e of validated) {
    if (e.product_id) {
      const prod = productMeta.get(e.product_id)
      if (!prod) { skip.push({ event: e, reason: 'product_not_found' }); continue }
      if (prod.business_id !== businessId) { skip.push({ event: e, reason: 'product_business_mismatch' }); continue }
      const pricing = productPrices.get(e.product_id)
      const unitPriceSek = pricing?.latest_price_sek ?? null
      let value: number | null = null
      if (unitPriceSek != null) {
        const packSize = prod.pack_size != null ? Number(prod.pack_size) : null
        if (packSize && prod.base_unit) {
          const qtyInBase = convertQuantity(e.quantity, e.unit, prod.base_unit)
          if (qtyInBase != null) value = Math.round(qtyInBase * (unitPriceSek / packSize) * 100) / 100
        } else {
          value = Math.round(e.quantity * unitPriceSek * 100) / 100
        }
      }
      rows.push({
        business_id: businessId,
        org_id:      biz.org_id,
        product_id:  e.product_id,
        recipe_id:   null,
        waste_date:  e.waste_date,
        quantity:    e.quantity,
        unit:        e.unit,
        reason:      e.reason,
        notes:       e.notes,
        prep_session_id:     e.prep_session_id,
        unit_price_at_entry: unitPriceSek,
        value_at_entry:      value,
        cost_estimate_sek:   null,
        created_by:  (auth as any).user?.id ?? null,
      })
    } else if (e.recipe_id) {
      // Recipe path — cost = (per-portion cost) × portions wasted.
      // Heuristic for "portions": when unit is 'portions' / 'st' /
      // empty, qty IS the portion count. Otherwise we treat qty as
      // portions equivalent. Owner can edit notes for nuance.
      let costSek: number | null = null
      if (recipeIndex && recipeProductPrices) {
        try {
          const ctx = recipeIndex.get(e.recipe_id)
          if (ctx) {
            const summary = computeRecipeCost(ctx.ingredients, recipeProductPrices, null, {
              recipeIndex,
              recipeId: e.recipe_id!,
            })
            const totalCost = Number(summary?.food_cost ?? 0)
            const portions  = Number(ctx.portions ?? 1) || 1
            const perPortion = totalCost / portions
            if (perPortion > 0) {
              costSek = Math.round(perPortion * Number(e.quantity) * 100) / 100
            }
          }
        } catch { /* honest-incomplete */ }
      }
      rows.push({
        business_id: businessId,
        org_id:      biz.org_id,
        product_id:  null,
        recipe_id:   e.recipe_id,
        waste_date:  e.waste_date,
        quantity:    e.quantity,
        unit:        e.unit,
        reason:      e.reason,
        notes:       e.notes,
        prep_session_id:     e.prep_session_id,
        unit_price_at_entry: null,
        value_at_entry:      null,
        cost_estimate_sek:   costSek,
        created_by:  (auth as any).user?.id ?? null,
      })
    }
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: 'no_valid_events', skipped: skip }, { status: 400 })
  }

  const { data, error } = await db
    .from('waste_log')
    .insert(rows)
    .select('id, product_id, recipe_id, quantity, value_at_entry, cost_estimate_sek')

  if (error) return NextResponse.json({ error: error.message, skipped: skip }, { status: 500 })

  return NextResponse.json({
    ok:       true,
    inserted: data?.length ?? 0,
    skipped:  skip,
    events:   data ?? [],
  })
}
