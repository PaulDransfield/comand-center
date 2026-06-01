// app/api/inventory/items/[id]/link-search/route.ts
//
// Search supplier_invoice_lines that the owner could link to this product
// as a supplier article. Returns lines that are NOT already pointed at
// another product (so the picker only shows safe candidates).
//
// Sorted by recency + grouped client-side by raw_description + supplier
// in the modal.
//
// GET ?q=ruccola → { lines: [{ id, raw_description, supplier_name,
//                              total_excl_vat, quantity, unit, invoice_date,
//                              match_status }] }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_RESULTS = 50

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const q = (url.searchParams.get('q') ?? '').trim()

  const db = createAdminClient()
  const { data: product } = await db
    .from('products')
    .select('id, business_id, name')
    .eq('id', params.id)
    .maybeSingle()
  if (!product) return NextResponse.json({ error: 'product not found' }, { status: 404 })

  const forbidden = requireBusinessAccess(auth, product.business_id)
  if (forbidden) return forbidden

  // Search unmatched lines (no alias yet) at this business. If the owner
  // searches with a query, ilike-filter on raw_description. Default sort
  // by invoice_date desc so the most recent purchases surface first.
  let query = db
    .from('supplier_invoice_lines')
    .select('id, raw_description, supplier_name_snapshot, supplier_fortnox_number, article_number, total_excl_vat, quantity, unit, invoice_date, match_status, fortnox_invoice_number')
    .eq('business_id', product.business_id)
    .is('product_alias_id', null)                  // only unmatched
    .neq('match_status', 'not_inventory')          // exclude not_inventory junk
    .order('invoice_date', { ascending: false })
    .limit(MAX_RESULTS)
  if (q) {
    // Substring on raw_description. Owner types e.g. "ruccola" and we
    // return any line whose description contains it.
    query = query.ilike('raw_description', `%${q}%`)
  }
  const { data: lines, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Group identical descriptions in the response for UI clarity.
  const groups = new Map<string, any>()
  for (const l of lines ?? []) {
    const key = `${l.supplier_fortnox_number ?? '?'}|${(l.raw_description ?? '').trim()}|${l.unit ?? ''}`
    const cur = groups.get(key) ?? {
      group_key:               key,
      sample_line_id:          l.id,
      raw_description:         l.raw_description,
      supplier_name:           l.supplier_name_snapshot,
      supplier_fortnox_number: l.supplier_fortnox_number,
      article_number:          l.article_number,
      unit:                    l.unit,
      line_count:              0,
      latest_invoice_date:     l.invoice_date,
      latest_price:            l.total_excl_vat != null && l.quantity
        ? Math.round((Number(l.total_excl_vat) / Number(l.quantity)) * 100) / 100
        : null,
      sample_invoice_number:   l.fortnox_invoice_number,
    }
    cur.line_count += 1
    if (l.invoice_date && (!cur.latest_invoice_date || l.invoice_date > cur.latest_invoice_date)) {
      cur.latest_invoice_date = l.invoice_date
      cur.sample_line_id      = l.id
    }
    groups.set(key, cur)
  }

  return NextResponse.json({
    ok:     true,
    groups: Array.from(groups.values()),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
