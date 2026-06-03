// app/api/inventory/items/[id]/supplier-article/route.ts
//
// GET — return the supplier_articles row (image + spec table) for the
// product, looked up via its product_aliases. A product may have
// aliases from MULTIPLE suppliers; we return the most-recently-updated
// match, with all available rows as `others` for the UI to disclose.
//
// Cross-customer: supplier_articles is keyed on (supplier_fortnox_number,
// article_number), no business_id — every customer who has an alias to
// the same MS article gets the same data.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STORAGE_BUCKET = 'supplier-article-images'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()

  // 1. Auth gate via the product's business.
  const { data: product, error: pErr } = await db
    .from('products')
    .select('id, business_id, name')
    .eq('id', params.id)
    .maybeSingle()
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 })
  if (!product) return NextResponse.json({ error: 'product not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, product.business_id)
  if (forbidden) return forbidden

  // 2. Find supplier+article combos via the product's aliases. The alias
  // table doesn't store article_number; we have to go through
  // supplier_invoice_lines to find the most-recent (supplier, article)
  // for each alias. Keep this lookup small — recent N lines is enough.
  const { data: aliases } = await db
    .from('product_aliases')
    .select('id')
    .eq('product_id', params.id)
    .eq('is_active', true)
  const aliasIds = (aliases ?? []).map(a => a.id)
  if (aliasIds.length === 0) {
    return NextResponse.json({ ok: true, supplier_articles: [], cdn_base: null })
  }

  // 3. Pull latest article_number + supplier_fortnox_number per alias.
  const combos = new Map<string, { supplier_fortnox_number: string; article_number: string; last_seen: string }>()
  for (let i = 0; i < aliasIds.length; i += 100) {
    const slice = aliasIds.slice(i, i + 100)
    const { data } = await db
      .from('supplier_invoice_lines')
      .select('supplier_fortnox_number, article_number, invoice_date')
      .eq('business_id', product.business_id)
      .in('product_alias_id', slice)
      .not('article_number', 'is', null)
      .not('supplier_fortnox_number', 'is', null)
      .order('invoice_date', { ascending: false })
      .limit(200)
    for (const l of data ?? []) {
      const k = `${l.supplier_fortnox_number}|${l.article_number}`
      const cur = combos.get(k)
      if (!cur || l.invoice_date > cur.last_seen) {
        combos.set(k, {
          supplier_fortnox_number: l.supplier_fortnox_number,
          article_number:          l.article_number,
          last_seen:               l.invoice_date,
        })
      }
    }
  }
  if (combos.size === 0) {
    return NextResponse.json({ ok: true, supplier_articles: [], cdn_base: null })
  }

  // 4. Pull every supplier_articles row that matches one of our combos.
  // Build the filter as an `.or(...)` of `and(...)` clauses.
  const orParts: string[] = []
  for (const c of combos.values()) {
    // PostgREST escapes for and() group args — quote string values.
    orParts.push(`and(supplier_fortnox_number.eq.${c.supplier_fortnox_number},article_number.eq.${c.article_number})`)
  }
  const { data: articles, error: aErr } = await db
    .from('supplier_articles')
    .select('*')
    .or(orParts.join(','))
    .eq('fetch_status', 'ok')
    .order('updated_at', { ascending: false })
  if (aErr) return NextResponse.json({ error: aErr.message }, { status: 500 })

  // 5. Build public URL for each cached image. Uses the Supabase
  // image-transformation endpoint to serve resized PNGs (max 512×512,
  // contain) instead of original 1-3 MB files. The transformation is
  // CDN-cached after first request.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const cdnBase    = supabaseUrl ? `${supabaseUrl}/storage/v1/object/public/${STORAGE_BUCKET}` : null
  const transformBase = supabaseUrl ? `${supabaseUrl}/storage/v1/render/image/public/${STORAGE_BUCKET}` : null
  const withCdn = (articles ?? []).map(a => ({
    ...a,
    image_cached_url: a.image_cached_path && transformBase
      ? `${transformBase}/${a.image_cached_path}?width=512&height=512&resize=contain&quality=85`
      : null,
  }))

  return NextResponse.json({
    ok:                true,
    supplier_articles: withCdn,
    cdn_base:          cdnBase,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
