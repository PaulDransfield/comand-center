// app/api/inventory/waste/route.ts
//
// GET  ?business_id=&from=&to= → list waste entries
// POST { business_id, product_id, quantity, unit, reason, waste_date?, notes? }
//   → create new entry. Snapshots unit_price_at_entry + value_at_entry
//     using the same cost-helper path the count line does.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { getProductLatestPrices } from '@/lib/inventory/recipe-cost'
import { loadFxIndex } from '@/lib/inventory/fx'
import { convertQuantity } from '@/lib/inventory/unit-conversion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const REASONS = ['spoilage', 'spill', 'over_portion', 'staff_meal', 'comp', 'other'] as const

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
    .select('id, product_id, waste_date, quantity, unit, unit_price_at_entry, value_at_entry, reason, notes, created_at, product:products(name, category, invoice_unit)')
    .eq('business_id', businessId)
    .order('waste_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500)
  if (from) q = q.gte('waste_date', from)
  if (to)   q = q.lte('waste_date', to)
  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const entries = (data ?? []).map((e: any) => ({
    id:             e.id,
    product_id:     e.product_id,
    product_name:   (e.product as any)?.name ?? '?',
    category:       (e.product as any)?.category ?? null,
    waste_date:     e.waste_date,
    quantity:       Number(e.quantity),
    unit:           e.unit,
    unit_price_at_entry: e.unit_price_at_entry != null ? Number(e.unit_price_at_entry) : null,
    value_at_entry:      e.value_at_entry      != null ? Number(e.value_at_entry)      : null,
    reason:         e.reason,
    notes:          e.notes,
    created_at:     e.created_at,
  }))

  // Summary: total value by reason, by week
  const totalValue = entries.reduce((s, e) => s + (e.value_at_entry ?? 0), 0)
  const byReason: Record<string, number> = {}
  for (const e of entries) byReason[e.reason] = (byReason[e.reason] ?? 0) + (e.value_at_entry ?? 0)

  return NextResponse.json({
    entries,
    summary: {
      total_value: Math.round(totalValue * 100) / 100,
      by_reason:   byReason,
      count:       entries.length,
    },
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  const productId  = String(body.product_id ?? '').trim()
  const quantity   = Number(body.quantity)
  const unit       = String(body.unit ?? '').trim()
  const reason     = String(body.reason ?? '').trim()
  const wasteDate  = body.waste_date ? String(body.waste_date) : undefined
  const notes      = body.notes ? String(body.notes).trim() : null

  if (!businessId)                       return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!productId)                        return NextResponse.json({ error: 'product_id required' }, { status: 400 })
  if (!Number.isFinite(quantity) || quantity <= 0) return NextResponse.json({ error: 'quantity must be > 0' }, { status: 400 })
  if (!unit)                             return NextResponse.json({ error: 'unit required' }, { status: 400 })
  if (!REASONS.includes(reason as any))  return NextResponse.json({ error: `reason must be one of: ${REASONS.join(', ')}` }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('org_id').eq('id', businessId).maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  const { data: prod } = await db
    .from('products')
    .select('id, business_id, invoice_unit, base_unit, pack_size')
    .eq('id', productId)
    .maybeSingle()
  if (!prod) return NextResponse.json({ error: 'product not found' }, { status: 404 })
  if (prod.business_id !== businessId) return NextResponse.json({ error: 'product from different business' }, { status: 403 })

  const fxIndex = await loadFxIndex(db, ['EUR', 'USD', 'NOK', 'DKK', 'GBP'])
  const prices  = await getProductLatestPrices(db, businessId, [productId], fxIndex)
  const pricing = prices.get(productId)
  const unitPriceSek = pricing?.latest_price_sek ?? null

  let value: number | null = null
  if (unitPriceSek != null) {
    const packSize = prod.pack_size != null ? Number(prod.pack_size) : null
    if (packSize && prod.base_unit) {
      const qtyInBase = convertQuantity(quantity, unit, prod.base_unit)
      if (qtyInBase != null) value = Math.round(qtyInBase * (unitPriceSek / packSize) * 100) / 100
    } else {
      value = Math.round(quantity * unitPriceSek * 100) / 100
    }
  }

  const insertRow: any = {
    business_id: businessId,
    org_id:      biz.org_id,
    product_id:  productId,
    waste_date:  wasteDate,
    quantity, unit, reason, notes,
    unit_price_at_entry: unitPriceSek,
    value_at_entry:      value,
    created_by:  (auth as any).user?.id ?? null,
  }
  const { data, error } = await db.from('waste_log').insert(insertRow).select('id').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, id: data.id, value_at_entry: value, unit_price_at_entry: unitPriceSek })
}
