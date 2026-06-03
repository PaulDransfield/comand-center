// app/api/inventory/supplier-article/batch/route.ts
//
// POST { product_ids: string[] } → { product_id → image_cached_url }
//
// Bulk lookup of supplier article thumbnails for many products at once.
// Used by:
//   - Recipe editor ingredient rows (32×32 thumb in left column)
//   - Prep list session lines
//   - Order list rows
//   - (Anywhere a list of products would benefit from images)
//
// Cross-customer: image_cached_path comes from the shared
// supplier_articles row, public CDN URL constructed here.
//
// Returns only the products that have data; the UI silent-falls-back
// to a name-only row when a product_id is absent from the response.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STORAGE_BUCKET = 'supplier-article-images'

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const productIds: string[] = Array.isArray(body.product_ids) ? body.product_ids.slice(0, 500).filter((x: any) => typeof x === 'string') : []
  if (productIds.length === 0) {
    return NextResponse.json({ ok: true, by_product: {} }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const db = createAdminClient()

  // 1. Get business_ids for these products (auth scope — only return
  // data for products the caller actually has access to).
  const allowedProducts = new Map<string, string>()   // product_id → business_id
  for (let i = 0; i < productIds.length; i += 100) {
    const slice = productIds.slice(i, i + 100)
    const { data } = await db.from('products').select('id, business_id').in('id', slice)
    for (const p of data ?? []) {
      const allowed = new Set(auth.businessIds ?? [])
      if (allowed.size === 0 || allowed.has(p.business_id)) allowedProducts.set(p.id, p.business_id)
    }
  }
  if (allowedProducts.size === 0) {
    return NextResponse.json({ ok: true, by_product: {} }, { headers: { 'Cache-Control': 'no-store' } })
  }

  // 2. Get aliases per product.
  const allowedProductIds = [...allowedProducts.keys()]
  const aliasesByProduct = new Map<string, string[]>()
  for (let i = 0; i < allowedProductIds.length; i += 100) {
    const slice = allowedProductIds.slice(i, i + 100)
    const { data } = await db.from('product_aliases').select('id, product_id').in('product_id', slice).eq('is_active', true)
    for (const a of data ?? []) {
      const arr = aliasesByProduct.get(a.product_id) ?? []
      arr.push(a.id); aliasesByProduct.set(a.product_id, arr)
    }
  }
  // alias → product back-map
  const aliasToProduct = new Map<string, string>()
  for (const [pid, ids] of aliasesByProduct) for (const aid of ids) aliasToProduct.set(aid, pid)
  const allAliasIds = [...aliasToProduct.keys()]
  if (allAliasIds.length === 0) {
    return NextResponse.json({ ok: true, by_product: {} }, { headers: { 'Cache-Control': 'no-store' } })
  }

  // 3. Pull recent supplier_invoice_lines for those aliases — we need
  // the (supplier, article) combo per product, latest first.
  const productToCombos = new Map<string, Set<string>>()
  for (let i = 0; i < allAliasIds.length; i += 100) {
    const slice = allAliasIds.slice(i, i + 100)
    const { data } = await db.from('supplier_invoice_lines')
      .select('supplier_fortnox_number, article_number, product_alias_id')
      .in('product_alias_id', slice)
      .not('article_number', 'is', null)
      .not('supplier_fortnox_number', 'is', null)
      .order('invoice_date', { ascending: false })
      .limit(1000)
    for (const l of data ?? []) {
      const pid = aliasToProduct.get(l.product_alias_id); if (!pid) continue
      const set = productToCombos.get(pid) ?? new Set()
      set.add(`${l.supplier_fortnox_number}|${l.article_number}`)
      productToCombos.set(pid, set)
    }
  }

  // 4. Unique (supplier, article) combos → fetch supplier_articles in bulk.
  const allCombos = new Set<string>()
  for (const set of productToCombos.values()) for (const k of set) allCombos.add(k)
  if (allCombos.size === 0) {
    return NextResponse.json({ ok: true, by_product: {} }, { headers: { 'Cache-Control': 'no-store' } })
  }

  // Build the OR filter — chunk 60 at a time to keep the URL under 16 KB.
  const articleByCombo = new Map<string, any>()
  const comboArr = [...allCombos]
  for (let i = 0; i < comboArr.length; i += 60) {
    const slice = comboArr.slice(i, i + 60)
    const orParts = slice.map(k => {
      const [sup, art] = k.split('|')
      return `and(supplier_fortnox_number.eq.${sup},article_number.eq.${art})`
    })
    const { data, error } = await db.from('supplier_articles')
      .select('supplier_fortnox_number, article_number, image_cached_path, official_name, brand')
      .or(orParts.join(','))
      .eq('fetch_status', 'ok')
    if (error) continue
    for (const a of data ?? []) {
      articleByCombo.set(`${a.supplier_fortnox_number}|${a.article_number}`, a)
    }
  }

  // 5. Build the by_product map. For each product, pick the first combo
  // that has data with a cached image (prefer cached over upstream).
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const cdnBase    = supabaseUrl ? `${supabaseUrl}/storage/v1/object/public/${STORAGE_BUCKET}` : null
  const by_product: Record<string, { image_url: string; brand: string | null; official_name: string | null }> = {}
  for (const [pid, combos] of productToCombos) {
    for (const k of combos) {
      const a = articleByCombo.get(k); if (!a) continue
      if (a.image_cached_path && cdnBase) {
        by_product[pid] = {
          image_url:     `${cdnBase}/${a.image_cached_path}`,
          brand:         a.brand ?? null,
          official_name: a.official_name ?? null,
        }
        break
      }
    }
  }

  return NextResponse.json({ ok: true, by_product }, { headers: { 'Cache-Control': 'no-store' } })
}
