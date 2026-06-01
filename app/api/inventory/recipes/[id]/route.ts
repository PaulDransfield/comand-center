// app/api/inventory/recipes/[id]/route.ts
//
// GET    — recipe detail with ingredients + per-line cost
// PATCH  — update header (name / type / menu_price / portions / notes)
// DELETE — soft-delete (archived_at = now); ingredients stay so undo is possible

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { computeRecipeCost, getProductLatestPrices, loadRecipeIndex } from '@/lib/inventory/recipe-cost'
import { loadFxIndex } from '@/lib/inventory/fx'
import { resolveRecipePriceFields } from '@/lib/inventory/recipe-price'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: r, error: rErr } = await db
    .from('recipes')
    .select('id, business_id, name, type, menu_price, selling_price_ex_vat, vat_rate, channel, portions, yield_amount, yield_unit, notes, updated_at')
    .eq('id', params.id)
    .maybeSingle()
  if (rErr)  return NextResponse.json({ error: rErr.message }, { status: 500 })
  if (!r)    return NextResponse.json({ error: 'recipe not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, r.business_id)
  if (forbidden) return forbidden

  // Load full business recipe index so cost can recurse through sub-recipes.
  const recipeIndex = await loadRecipeIndex(db, r.business_id)
  const entry = recipeIndex.get(r.id)
  const ings = entry?.ingredients ?? []

  // Latest prices for every product anywhere in the dependency tree.
  const allProductIds = new Set<string>()
  for (const e of recipeIndex.values()) {
    for (const ing of e.ingredients) if (ing.product_id) allProductIds.add(ing.product_id)
  }
  const fxIndex  = await loadFxIndex(db, ['EUR', 'USD', 'NOK', 'DKK', 'GBP'])
  const priceMap = await getProductLatestPrices(db, r.business_id, Array.from(allProductIds), fxIndex)
  // Margin denominator: ex-VAT canonical truth; fall back to legacy menu_price
  // for rows that predate M109 (until owner re-edits via the authoring tool).
  const marginBase =
    r.selling_price_ex_vat != null ? Number(r.selling_price_ex_vat)
    : r.menu_price != null         ? Number(r.menu_price)
    : null
  const summary  = computeRecipeCost(
    ings, priceMap,
    marginBase,
    { recipeIndex, recipeId: r.id },
  )

  // Has this recipe been promoted to a catalogue item? If yes, return the
  // product id so the drawer can show "Promoted ✓" instead of the button.
  const { data: promoted } = await db
    .from('products')
    .select('id')
    .eq('business_id', r.business_id)
    .eq('source_recipe_id', r.id)
    .maybeSingle()

  return NextResponse.json({
    recipe: {
      ...r,
      menu_price: r.menu_price != null ? Number(r.menu_price) : null,
      source_product_id: promoted?.id ?? null,
    },
    summary,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }

  const patch: Record<string, any> = {}
  if (typeof body.name === 'string') {
    const v = body.name.trim()
    if (!v) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    if (v.length > 200) return NextResponse.json({ error: 'name too long (max 200)' }, { status: 400 })
    patch.name = v
  }
  if (body.type !== undefined)       patch.type       = body.type ? String(body.type).trim() : null
  if (body.notes !== undefined)      patch.notes      = body.notes ? String(body.notes).trim() : null
  if (body.portions !== undefined) {
    const pt = Math.max(1, Math.floor(Number(body.portions)))
    if (!Number.isFinite(pt)) return NextResponse.json({ error: 'portions must be a positive integer' }, { status: 400 })
    patch.portions = pt
  }

  // M111 — sub-recipe yield. Accept either as a paired update or as
  // explicit nulls (clearing both). The DB CHECK enforces that the pair
  // is either fully set or fully null; mirror that here so we never
  // submit a partial pair.
  if (body.yield_amount !== undefined || body.yield_unit !== undefined) {
    const amtRaw = body.yield_amount
    const unitRaw = body.yield_unit
    const clearing = (amtRaw === null || amtRaw === '' || amtRaw === undefined)
                  && (unitRaw === null || unitRaw === '' || unitRaw === undefined)
    if (clearing) {
      patch.yield_amount = null
      patch.yield_unit   = null
    } else {
      const amt  = Number(amtRaw)
      const unit = typeof unitRaw === 'string' ? unitRaw.trim() : null
      if (!Number.isFinite(amt) || amt <= 0) {
        return NextResponse.json({ error: 'yield_amount must be a positive number' }, { status: 400 })
      }
      if (!unit) {
        return NextResponse.json({ error: 'yield_unit required when yield_amount is set' }, { status: 400 })
      }
      patch.yield_amount = amt
      patch.yield_unit   = unit
    }
  }

  // Price fields go through the single-source resolver so menu_price and
  // selling_price_ex_vat can never diverge. Only run the resolver if at
  // least one price-related field was supplied — otherwise a name-only
  // edit would wipe an existing ex_vat.
  if (body.selling_price_ex_vat !== undefined
      || body.menu_price_inc_vat !== undefined
      || body.menu_price !== undefined
      || body.vat_rate !== undefined
      || body.channel !== undefined) {
    const resolved = resolveRecipePriceFields(body)
    if (resolved.error) return NextResponse.json({ error: resolved.error }, { status: 400 })
    if (body.selling_price_ex_vat !== undefined || body.menu_price_inc_vat !== undefined || body.menu_price !== undefined) {
      patch.selling_price_ex_vat = resolved.selling_price_ex_vat
      patch.menu_price           = resolved.menu_price
    }
    if (resolved.vat_rate != null && body.vat_rate !== undefined) patch.vat_rate = resolved.vat_rate
    if (resolved.channel  != null && body.channel  !== undefined) patch.channel  = resolved.channel
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no editable fields supplied' }, { status: 400 })
  }

  const db = createAdminClient()
  const { data: existing } = await db
    .from('recipes')
    .select('id, business_id')
    .eq('id', params.id)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'recipe not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, existing.business_id)
  if (forbidden) return forbidden

  const { data, error } = await db
    .from('recipes')
    .update(patch)
    .eq('id', params.id)
    .select('id, name, type, menu_price, selling_price_ex_vat, vat_rate, channel, portions, yield_amount, yield_unit, notes, updated_at')
    .single()
  if (error) {
    if ((error as any).code === '23505') {
      return NextResponse.json({ error: `A recipe called "${patch.name}" already exists.` }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, recipe: data }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: r } = await db
    .from('recipes')
    .select('id, business_id')
    .eq('id', params.id)
    .maybeSingle()
  if (!r) return NextResponse.json({ error: 'recipe not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, r.business_id)
  if (forbidden) return forbidden

  const { error } = await db
    .from('recipes')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', params.id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}
