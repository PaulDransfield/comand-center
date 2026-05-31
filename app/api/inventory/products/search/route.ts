// app/api/inventory/products/search/route.ts
//
// GET — type-ahead search for the ingredient picker on /inventory/recipes.
// Returns up to 20 catalogue items matching the query, with their
// latest price + invoice_unit so the picker can pre-fill the qty unit.
//
// ?q=<query>&business_id=<uuid>

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { getProductLatestPrices, inferPackFromInvoiceUnit } from '@/lib/inventory/recipe-cost'
import { loadFxIndex } from '@/lib/inventory/fx'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const businessId = String(url.searchParams.get('business_id') ?? '').trim()
  const query      = String(url.searchParams.get('q')           ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  let qB = db
    .from('products')
    .select('id, name, category, invoice_unit, default_supplier_name, pack_size, base_unit')
    .eq('business_id', businessId)
    .is('archived_at', null)
    .order('name')
    .limit(20)
  if (query) qB = qB.ilike('name', `%${query}%`)

  const { data: products, error } = await qB
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const ids = (products ?? []).map((p: any) => p.id)
  const fxIndex = await loadFxIndex(db, ['EUR', 'USD', 'NOK', 'DKK', 'GBP'])
  const prices = await getProductLatestPrices(db, businessId, ids, fxIndex)

  const out = (products ?? []).map((p: any) => {
    const pr = prices.get(p.id)
    const invoiceUnit = p.invoice_unit ?? pr?.invoice_unit ?? null
    // Same resolution priority as the cost engine — saved → SI inferred.
    // Without this the picker's unit dropdown and "Enter in g — pack is
    // 1000g per KG" hint don't fire for products whose pack is implied by
    // the invoice unit (KG, L, ML, etc), so the UI would lie that they
    // need owner setup when the engine actually handles them.
    let packSize = p.pack_size ?? pr?.pack_size ?? null
    let baseUnit = p.base_unit ?? pr?.base_unit ?? null
    if ((packSize == null || baseUnit == null) && invoiceUnit) {
      const inferred = inferPackFromInvoiceUnit(invoiceUnit)
      if (inferred) { packSize = inferred.pack_size; baseUnit = inferred.base_unit }
    }
    return {
      product_id:   p.id,
      name:         p.name,
      category:     p.category,
      invoice_unit: invoiceUnit,
      pack_size:    packSize,
      base_unit:    baseUnit,
      latest_price: pr?.latest_price ?? null,
      supplier:     p.default_supplier_name,
    }
  })

  return NextResponse.json({ products: out }, { headers: { 'Cache-Control': 'no-store' } })
}
