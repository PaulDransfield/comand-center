// app/api/inventory/pos-menu-items/route.ts
//
// CRUD for POS menu items (what the restaurant sells). Each item maps
// (optionally) to a recipe so the variance calc can convert "20 Margheritas
// sold" → "4.8 kg flour + 2.2 kg mozzarella" theoretical draw.
//
// GET  ?business_id=…                       → list non-archived items
// POST { business_id, name, recipe_id?,     → create
//        price_inc_vat?, pos_provider? }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const businessId = String(new URL(req.url).searchParams.get('business_id') ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  const { data, error } = await db
    .from('pos_menu_items')
    .select(`
      id, name, pos_provider, pos_item_id, recipe_id, price_inc_vat, created_at,
      recipe:recipes ( id, name, food_cost, portions, menu_price )
    `)
    .eq('business_id', businessId)
    .is('archived_at', null)
    .order('name')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ items: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId   = String(body.business_id ?? '').trim()
  const name         = String(body.name ?? '').trim()
  const posProvider  = String(body.pos_provider ?? 'manual').trim()
  const recipeId     = body.recipe_id ? String(body.recipe_id).trim() : null
  const priceIncVat  = body.price_inc_vat != null ? Number(body.price_inc_vat) : null

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!name)       return NextResponse.json({ error: 'name required' }, { status: 400 })
  if (name.length > 200) return NextResponse.json({ error: 'name too long (max 200)' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('org_id').eq('id', businessId).maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  const { data, error } = await db
    .from('pos_menu_items')
    .insert({
      business_id:   businessId,
      org_id:        biz.org_id,
      name,
      pos_provider:  posProvider,
      recipe_id:     recipeId,
      price_inc_vat: priceIncVat,
    })
    .select('id, name, pos_provider, recipe_id, price_inc_vat')
    .single()
  if (error) {
    if ((error as any).code === '23505') {
      return NextResponse.json({ error: `A menu item called "${name}" already exists.` }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, item: data })
}
