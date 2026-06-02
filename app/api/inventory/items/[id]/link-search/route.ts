// app/api/inventory/items/[id]/link-search/route.ts
//
// Search supplier_invoice_lines the owner could link to this product as a
// supplier article. Returns TWO buckets:
//
//   1. unmatched groups   — supplier lines with no alias yet (safe to link
//                           via /link-supplier-article)
//   2. matched groups     — supplier lines already pointing at a DIFFERENT
//                           product. Owner can repoint the alias via
//                           /product-aliases/[id]/repoint. Surfaced so the
//                           owner can consolidate duplicate-product cases
//                           (e.g. "Burrata 125g" vs "Mozzarella Burrata
//                           8x125g" being two products that should be one).
//
// Same product's own aliases are excluded — they're already linked here.
//
// GET ?q=burrata → { unmatched_groups: [...], matched_groups: [...] }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_RESULTS = 100   // bumped from 50 since we now serve two buckets

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

  // Pull every line containing the query at this business — DON'T
  // pre-filter on alias state; we need both buckets. Limit + recency-
  // order so the picker doesn't drown in 10k results.
  let query = db
    .from('supplier_invoice_lines')
    .select('id, raw_description, supplier_name_snapshot, supplier_fortnox_number, article_number, total_excl_vat, quantity, unit, invoice_date, match_status, fortnox_invoice_number, product_alias_id')
    .eq('business_id', product.business_id)
    .neq('match_status', 'not_inventory')   // exclude deliberate-noise bucket
    .order('invoice_date', { ascending: false })
    .limit(MAX_RESULTS)
  if (q) query = query.ilike('raw_description', `%${q}%`)
  const { data: lines, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Resolve alias → product for every matched line (so we can label
  // "currently linked to: X" and skip lines pointing at THIS product).
  // Two-step pattern. Batch=100 protects against silent-null .in() cap.
  const aliasIds = Array.from(new Set((lines ?? []).map(l => l.product_alias_id).filter(Boolean) as string[]))
  const aliasToProduct = new Map<string, string>()    // alias_id → product_id
  for (let i = 0; i < aliasIds.length; i += 100) {
    const slice = aliasIds.slice(i, i + 100)
    const { data: aliases, error: aErr } = await db
      .from('product_aliases')
      .select('id, product_id')
      .in('id', slice)
    if (aErr) return NextResponse.json({ error: `alias lookup: ${aErr.message}` }, { status: 500 })
    for (const a of aliases ?? []) {
      if (a.product_id) aliasToProduct.set(a.id, a.product_id)
    }
  }
  const productIds = Array.from(new Set(aliasToProduct.values()))
  const productNames = new Map<string, string>()      // product_id → name
  for (let i = 0; i < productIds.length; i += 100) {
    const slice = productIds.slice(i, i + 100)
    const { data: prods, error: pErr } = await db
      .from('products')
      .select('id, name')
      .in('id', slice)
    if (pErr) return NextResponse.json({ error: `product lookup: ${pErr.message}` }, { status: 500 })
    for (const p of prods ?? []) productNames.set(p.id, p.name)
  }

  // Group identical descriptions per bucket. Within a group we surface
  // the most-recent line as the "sample" so the link endpoint has a
  // representative id to work with.
  type Group = {
    group_key:               string
    sample_line_id:          string
    raw_description:         string | null
    supplier_name:           string | null
    supplier_fortnox_number: string | null
    article_number:          string | null
    unit:                    string | null
    line_count:              number
    latest_invoice_date:     string | null
    latest_price:            number | null
    sample_invoice_number:   string | null
    // matched-bucket only:
    current_product_id?:     string | null
    current_product_name?:   string | null
    sample_alias_id?:        string | null
  }
  const unmatched = new Map<string, Group>()
  const matched   = new Map<string, Group>()

  for (const l of lines ?? []) {
    const aliasId = l.product_alias_id as string | null
    // Skip lines already pointing AT this product — they're already linked here.
    if (aliasId && aliasToProduct.get(aliasId) === product.id) continue

    const key = `${l.supplier_fortnox_number ?? '?'}|${(l.raw_description ?? '').trim()}|${l.unit ?? ''}`
    const dest = aliasId ? matched : unmatched
    const cur = dest.get(key) ?? {
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
      ...(aliasId ? {
        current_product_id:   aliasToProduct.get(aliasId) ?? null,
        current_product_name: aliasToProduct.get(aliasId) ? (productNames.get(aliasToProduct.get(aliasId)!) ?? null) : null,
        sample_alias_id:      aliasId,
      } : {}),
    }
    cur.line_count += 1
    if (l.invoice_date && (!cur.latest_invoice_date || l.invoice_date > cur.latest_invoice_date)) {
      cur.latest_invoice_date = l.invoice_date
      cur.sample_line_id      = l.id
      if (aliasId) cur.sample_alias_id = aliasId
    }
    dest.set(key, cur)
  }

  return NextResponse.json({
    ok:                true,
    unmatched_groups:  Array.from(unmatched.values()),
    matched_groups:    Array.from(matched.values()),
    // legacy field — keep so older callers don't break; equals unmatched.
    groups:            Array.from(unmatched.values()),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
