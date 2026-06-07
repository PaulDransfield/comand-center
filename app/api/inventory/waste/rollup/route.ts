// app/api/inventory/waste/rollup/route.ts
//
// A2.1 — per-recipe + per-product waste aggregates over a window.
// GET ?business_id=&days=30
//
// Used by /inventory/recipes to surface a waste badge per dish and
// by /inventory/waste for the summary card. Pure read; small response;
// safe to call on every recipe list render.

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

  const u = new URL(req.url)
  const businessId = u.searchParams.get('business_id')
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const days = Math.max(1, Math.min(365, Number(u.searchParams.get('days') ?? 30)))
  const from = new Date(); from.setUTCDate(from.getUTCDate() - days)
  const fromIso = from.toISOString().slice(0, 10)

  const db = createAdminClient()
  const { data, error } = await db
    .from('waste_log')
    .select('recipe_id, product_id, quantity, value_at_entry, cost_estimate_sek, reason, waste_date')
    .eq('business_id', businessId)
    .is('archived_at', null)
    .gte('waste_date', fromIso)
    .limit(10000)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const byRecipe = new Map<string, { count: number; qty: number; value_sek: number }>()
  const byProduct = new Map<string, { count: number; qty: number; value_sek: number }>()
  const byReason  = new Map<string, { count: number; value_sek: number }>()
  let totalValueSek = 0
  let totalCount = 0

  for (const r of data ?? []) {
    const valueSek = r.recipe_id
      ? Number((r as any).cost_estimate_sek ?? 0)
      : Number((r as any).value_at_entry    ?? 0)
    const qty = Number((r as any).quantity ?? 0)
    totalCount++
    totalValueSek += valueSek
    const reason = String((r as any).reason ?? 'other')
    const rb = byReason.get(reason) ?? { count: 0, value_sek: 0 }
    rb.count++; rb.value_sek += valueSek
    byReason.set(reason, rb)

    if (r.recipe_id) {
      const e = byRecipe.get(r.recipe_id) ?? { count: 0, qty: 0, value_sek: 0 }
      e.count++; e.qty += qty; e.value_sek += valueSek
      byRecipe.set(r.recipe_id, e)
    } else if (r.product_id) {
      const e = byProduct.get(r.product_id) ?? { count: 0, qty: 0, value_sek: 0 }
      e.count++; e.qty += qty; e.value_sek += valueSek
      byProduct.set(r.product_id, e)
    }
  }

  return NextResponse.json({
    business_id: businessId,
    days,
    from:        fromIso,
    summary: {
      total_events:    totalCount,
      total_value_sek: Math.round(totalValueSek * 100) / 100,
    },
    by_recipe:  Object.fromEntries(byRecipe),
    by_product: Object.fromEntries(byProduct),
    by_reason:  Object.fromEntries(byReason),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
