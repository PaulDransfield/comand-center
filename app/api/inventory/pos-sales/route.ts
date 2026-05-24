// app/api/inventory/pos-sales/route.ts
//
// Manual weekly sales entry (Phase 1 of POS-RECIPE-MAPPING-PLAN.md).
// Future POS connectors will write per-ticket rows; this endpoint is
// for restaurants without a connectable POS who key in weekly totals.
//
// GET  ?business_id=&from=YYYY-MM-DD&to=YYYY-MM-DD
//   → list pos_sales rows in range, joined to menu item + recipe.
//
// POST { business_id, pos_item_id, week_start (YYYY-MM-DD Monday),
//        quantity, net_revenue? }
//   → upsert one row per (item, week_start). Manual-only — the partial
//     index pos_sales_manual_weekly_uniq guarantees one row per week.

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

  const url        = new URL(req.url)
  const businessId = String(url.searchParams.get('business_id') ?? '').trim()
  const from       = String(url.searchParams.get('from') ?? '').trim() || isoDaysAgo(90)
  const to         = String(url.searchParams.get('to')   ?? '').trim() || isoToday()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  const { data, error } = await db
    .from('pos_sales')
    .select(`
      id, pos_item_id, sold_at, sold_date, quantity, net_revenue, source, source_ref, notes, created_at,
      item:pos_menu_items ( id, name, recipe_id, price_inc_vat,
                             recipe:recipes ( id, name, food_cost, portions ) )
    `)
    .eq('business_id', businessId)
    .gte('sold_date', from)
    .lte('sold_date', to)
    .order('sold_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(2000)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ sales: data ?? [], from, to }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  const posItemId  = String(body.pos_item_id ?? '').trim()
  const weekStart  = String(body.week_start ?? '').trim()      // Monday YYYY-MM-DD
  const quantity   = Number(body.quantity ?? NaN)
  const netRevenue = body.net_revenue != null ? Number(body.net_revenue) : null
  const notes      = body.notes ? String(body.notes).trim().slice(0, 500) : null

  if (!businessId)               return NextResponse.json({ error: 'business_id required' },   { status: 400 })
  if (!posItemId)                return NextResponse.json({ error: 'pos_item_id required' },   { status: 400 })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) return NextResponse.json({ error: 'week_start must be YYYY-MM-DD' }, { status: 400 })
  if (!Number.isFinite(quantity) || quantity < 0) return NextResponse.json({ error: 'quantity must be a non-negative number' }, { status: 400 })

  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  const { data: biz }  = await db.from('businesses').select('org_id').eq('id', businessId).maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  // Verify the menu item belongs to this business (multi-tenant guard).
  const { data: item } = await db
    .from('pos_menu_items')
    .select('id, business_id')
    .eq('id', posItemId)
    .eq('business_id', businessId)
    .maybeSingle()
  if (!item) return NextResponse.json({ error: 'pos_item_id not found in this business' }, { status: 404 })

  // Sold_at = Monday-of-week 00:00 UTC. We store both the timestamp
  // (provenance) and the generated sold_date (lookup speed).
  const soldAtIso = `${weekStart}T00:00:00.000Z`

  // Manual-weekly partial unique index = (business_id, pos_item_id, sold_date)
  // WHERE source='manual'. Partial indexes can't be used by
  // .upsert({ onConflict }) — SELECT-then-INSERT-or-UPDATE pattern per
  // [[postgrest-upsert-partial-indexes]].
  const { data: existing } = await db
    .from('pos_sales')
    .select('id')
    .eq('business_id', businessId)
    .eq('pos_item_id', posItemId)
    .eq('sold_date', weekStart)
    .eq('source', 'manual')
    .maybeSingle()

  if (existing) {
    const { data, error } = await db
      .from('pos_sales')
      .update({ quantity, net_revenue: netRevenue, notes })
      .eq('id', existing.id)
      .select('id, pos_item_id, sold_date, quantity, net_revenue')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, sale: data, upsert: 'updated' })
  }

  const { data, error } = await db
    .from('pos_sales')
    .insert({
      business_id: businessId,
      org_id:      biz.org_id,
      pos_item_id: posItemId,
      sold_at:     soldAtIso,
      quantity,
      net_revenue: netRevenue,
      notes,
      source:      'manual',
    })
    .select('id, pos_item_id, sold_date, quantity, net_revenue')
    .single()
  if (error) {
    // Race with another concurrent insert → retry as update
    if ((error as any).code === '23505') {
      const { data: row } = await db
        .from('pos_sales')
        .select('id')
        .eq('business_id', businessId)
        .eq('pos_item_id', posItemId)
        .eq('sold_date', weekStart)
        .eq('source', 'manual')
        .single()
      const { data: upd } = await db
        .from('pos_sales')
        .update({ quantity, net_revenue: netRevenue, notes })
        .eq('id', row!.id)
        .select('id, pos_item_id, sold_date, quantity, net_revenue')
        .single()
      return NextResponse.json({ ok: true, sale: upd, upsert: 'updated_after_race' })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, sale: data, upsert: 'inserted' })
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}
function isoDaysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}
