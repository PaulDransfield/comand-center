// app/api/inventory/items/[id]/route.ts
//
// GET — full detail for one product:
//   - product metadata (name / category / default supplier)
//   - aliases (every alternate description we've seen)
//   - price history (every matched supplier_invoice_lines row, newest first)
//   - aggregates (min/max/avg price across the whole history, observation count)
//
// Used by /inventory/items/[id] detail page.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const id = params.id
  const db = createAdminClient()

  // 1. Product row
  const { data: product, error: pErr } = await db
    .from('products')
    .select('id, org_id, business_id, name, category, default_supplier_fortnox_number, default_supplier_name, invoice_unit, count_unit, unit_conversion, created_at, updated_at')
    .eq('id', id)
    .maybeSingle()
  if (pErr)      return NextResponse.json({ error: pErr.message }, { status: 500 })
  if (!product)  return NextResponse.json({ error: 'product not found' }, { status: 404 })

  const forbidden = requireBusinessAccess(auth, product.business_id)
  if (forbidden) return forbidden

  // 2. Aliases for this product
  const { data: aliases } = await db
    .from('product_aliases')
    .select('id, alias_text, supplier_fortnox_number, supplier_name, observation_count, first_seen_at, last_seen_at')
    .eq('product_id', id)
    .order('last_seen_at', { ascending: false, nullsFirst: false })

  const aliasIds = (aliases ?? []).map(a => a.id)

  // 3. Price history — every matched supplier_invoice_lines row,
  //    paginated past the 1000-row cap.
  const history: any[] = []
  if (aliasIds.length > 0) {
    for (let i = 0; i < aliasIds.length; i += 200) {
      const slice = aliasIds.slice(i, i + 200)
      let from = 0
      while (true) {
        const { data, error } = await db
          .from('supplier_invoice_lines')
          .select('id, invoice_date, fortnox_invoice_number, supplier_name_snapshot, supplier_fortnox_number, raw_description, article_number, quantity, unit, price_per_unit, total_excl_vat, vat_rate')
          .eq('business_id', product.business_id)
          .in('product_alias_id', slice)
          .order('invoice_date', { ascending: false })
          .range(from, from + 999)
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        if (!data || data.length === 0) break
        history.push(...data)
        if (data.length < 1000) break
        from += 1000
        if (from > 50_000) break
      }
    }
  }
  history.sort((a, b) => (b.invoice_date ?? '').localeCompare(a.invoice_date ?? ''))

  // 4. Aggregates
  const prices = history.map(h => h.price_per_unit).filter(p => p != null).map(Number)
  const aggregates = prices.length > 0
    ? {
        observation_count: prices.length,
        min_price:         Math.min(...prices),
        max_price:         Math.max(...prices),
        avg_price:         prices.reduce((s, p) => s + p, 0) / prices.length,
        latest_price:      history[0]?.price_per_unit != null ? Number(history[0].price_per_unit) : null,
        first_seen_date:   history[history.length - 1]?.invoice_date ?? null,
        last_seen_date:    history[0]?.invoice_date ?? null,
        suppliers_seen:    Array.from(new Set(history.map(h => h.supplier_name_snapshot).filter(Boolean))),
      }
    : {
        observation_count: 0,
        min_price:         null,
        max_price:         null,
        avg_price:         null,
        latest_price:      null,
        first_seen_date:   null,
        last_seen_date:    null,
        suppliers_seen:    [],
      }

  return NextResponse.json({
    product,
    aliases:    aliases ?? [],
    history:    history.map(h => ({
      id:              h.id,
      invoice_date:    h.invoice_date,
      invoice_number:  h.fortnox_invoice_number,
      supplier:        h.supplier_name_snapshot,
      raw_description: h.raw_description,
      article_number:  h.article_number,
      quantity:        h.quantity,
      unit:            h.unit,
      price_per_unit:  h.price_per_unit,
      total_excl_vat:  h.total_excl_vat,
      vat_rate:        h.vat_rate,
      fortnox_url:     `https://apps.fortnox.se/supplierinvoice/${encodeURIComponent(h.fortnox_invoice_number)}`,
    })),
    aggregates,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
