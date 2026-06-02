// app/api/inventory/items/route.ts
//
// GET — full inventory catalogue for one business with price-tracking
// derivatives. For each product:
//   - latest observed price (price_per_unit on the most recent matched line)
//   - count of observations
//   - prior-window median price (30-90 days before latest)
//   - change_pct vs prior median
//   - latest supplier
//
// Used by /inventory/items list page and (eventually) the price-creep cron.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface CatalogueItem {
  product_id:           string
  name:                 string
  category:             string
  default_supplier:     string | null
  latest_price:         number | null
  latest_unit:          string | null
  latest_supplier:      string | null
  latest_date:          string | null
  prior_median_price:   number | null
  change_pct:           number | null     // (latest - prior_median) / prior_median
  observation_count:    number
  is_recipe_sourced:    boolean           // M089 — true when this product is a promoted recipe
  source_recipe_id:     string | null
  // Needs-attention signals (Session 25 — items-upgrade-plus-recipe-qol-prompt
  // Part A). Each signal is a flag the owner can act on from the modal.
  needs_attention:      boolean
  attention_reasons:    Array<'no_article' | 'no_price' | 'unreliable' | 'no_supplier'>
}

const VALID_CATEGORIES = ['food', 'beverage', 'alcohol', 'cleaning', 'takeaway_material', 'disposables', 'other']

// POST — create a product (article) by hand. The catalogue is normally built
// by the invoice matcher, but when supplier invoices carry no line text
// (amounts-per-account bookkeeping — see Vero) there's nothing to match, so
// owners build/extend the catalogue manually: here, and inline while counting
// stock. Dedups by (business_id, name) like the matcher does.
export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  const name       = String(body.name ?? '').trim()
  const category   = String(body.category ?? 'other').trim()
  const unit       = body.unit ? String(body.unit).trim() : null
  const baseUnit   = body.base_unit ? String(body.base_unit).trim() : null
  const packSize   = body.pack_size != null && body.pack_size !== '' ? Number(body.pack_size) : null

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!name)       return NextResponse.json({ error: 'name required' }, { status: 400 })
  if (name.length > 200) return NextResponse.json({ error: 'name too long (max 200)' }, { status: 400 })
  if (!VALID_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` }, { status: 400 })
  }
  if (packSize != null && (!Number.isFinite(packSize) || packSize <= 0)) {
    return NextResponse.json({ error: 'pack_size must be a positive number' }, { status: 400 })
  }

  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  // Fail-fast on every supabase-js call — a silent { data: null } from a
  // transport error must not be confused with a "no rows" finding. See
  // docs/investigation/no-price-root-cause.md for the failure mode.
  const { data: biz, error: bizErr } = await db
    .from('businesses').select('id, org_id').eq('id', businessId).maybeSingle()
  if (bizErr) return NextResponse.json({ error: `business lookup failed: ${bizErr.message}` }, { status: 500 })
  if (!biz)   return NextResponse.json({ error: 'business not found' }, { status: 404 })

  // Find-or-create by name (matches the matcher's dedup key).
  const { data: existing, error: exErr } = await db
    .from('products').select('id').eq('business_id', businessId).eq('name', name).maybeSingle()
  if (exErr) return NextResponse.json({ error: `existing-product lookup failed: ${exErr.message}` }, { status: 500 })
  if (existing?.id) {
    return NextResponse.json({ ok: true, product_id: existing.id, reused: true, message: `"${name}" already exists.` })
  }

  const { data: prod, error } = await db
    .from('products')
    .insert({
      org_id:       biz.org_id,
      business_id:  businessId,
      name,
      category,
      invoice_unit: unit,
      base_unit:    baseUnit,
      pack_size:    packSize,
      created_via:  'owner_review',   // known-good enum value (same as matcher-created products)
    })
    .select('id')
    .single()
  if (error) {
    // 23505 = lost a race to a concurrent create of the same name — reuse it.
    if ((error as any).code === '23505') {
      const { data: race } = await db
        .from('products').select('id').eq('business_id', businessId).eq('name', name).maybeSingle()
      if (race?.id) return NextResponse.json({ ok: true, product_id: race.id, reused: true })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, product_id: prod.id, reused: false }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const businessId = String(url.searchParams.get('business_id') ?? '').trim()
  const categoryFilter = String(url.searchParams.get('category') ?? 'all').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // 1. Pull every product for this business — UNFILTERED. The counts on
  //    the response need to reflect the WHOLE catalogue so the filter
  //    tabs render real numbers. Filtering happens after the count
  //    aggregation. Pre-fix this query was `.eq('category', filter)`
  //    when filter !== 'all', which made tab counts collapse to 0 for
  //    every category other than the active one.
  const { data: allProducts, error: pErr } = await db
    .from('products')
    .select('id, name, category, default_supplier_fortnox_number, default_supplier_name, source_recipe_id, price_override')
    .eq('business_id', businessId)
    .is('archived_at', null)
    .order('name')
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 })

  if (!allProducts || allProducts.length === 0) {
    return NextResponse.json({
      counts: {},
      items: [],
      message: 'Catalogue is empty. It fills automatically from your supplier invoices — for invoices booked without line text, items are pulled from the attached PDF (extraction runs after the invoice import and can take a little while). You can also add articles by hand with "+ Add article", including while counting.',
    }, { headers: { 'Cache-Control': 'no-store' } })
  }

  // Filtered subset — only this is fed into the items aggregation below
  // and returned to the UI. The unfiltered `allProducts` set drives counts.
  const products = categoryFilter !== 'all'
    ? allProducts.filter((p: any) => p.category === categoryFilter)
    : allProducts

  // 2. Pull every matched supplier_invoice_lines row for this business in
  //    one paginated sweep. For Chicce-scale (~3 k lines) this is cheap;
  //    a future migration to a Postgres view would speed up larger orgs.
  const allLines: any[] = []
  let from = 0
  while (true) {
    const { data, error } = await db
      .from('supplier_invoice_lines')
      .select('product_alias_id, price_per_unit, total_excl_vat, quantity, unit, invoice_date, supplier_name_snapshot, fortnox_invoice_number')
      .eq('business_id', businessId)
      .eq('match_status', 'matched')
      .not('product_alias_id', 'is', null)
      .order('invoice_date', { ascending: false })
      .range(from, from + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data || data.length === 0) break
    allLines.push(...data)
    if (data.length < 1000) break
    from += 1000
    if (from > 50_000) break
  }

  // 3. Resolve product_alias_id → product_id via product_aliases.
  //
  // ── BATCH_IN constant ─────────────────────────────────────────────
  // 500 UUIDs in a .in() filter exceeds Supabase's ~16 KB HTTP header
  // limit (UND_ERR_HEADERS_OVERFLOW). The error is silent in supabase-
  // js — it returns { data: null } with no thrown error — so the
  // resulting empty alias map silently mis-reported ~770 Chicce + ~930
  // Vero products as needing attention. See docs/investigation/
  // no-price-root-cause.md. Keep at 100; do NOT raise without re-
  // measuring URL length.
  const BATCH_IN = 100

  const aliasIds = Array.from(new Set(allLines.map(l => l.product_alias_id).filter(Boolean)))
  const aliasToProduct = new Map<string, string>()
  if (aliasIds.length > 0) {
    for (let i = 0; i < aliasIds.length; i += BATCH_IN) {
      const slice = aliasIds.slice(i, i + BATCH_IN)
      const { data: aliases, error: aErr } = await db
        .from('product_aliases')
        .select('id, product_id')
        .in('id', slice)
      // Fail-fast — a silent { data: null } would empty the map and
      // produce a wrong-but-plausible report (the exact failure mode
      // that caused the false 954/930 alarm). Network failures here
      // are an error condition, not a data fact.
      if (aErr) {
        console.error('[items] alias→product batch failed', { batch_size: slice.length, err: aErr })
        return NextResponse.json({ error: `alias→product lookup failed: ${aErr.message}` }, { status: 500 })
      }
      for (const a of aliases ?? []) aliasToProduct.set((a as any).id, (a as any).product_id)
    }
  }

  // 3b. Needs-attention preflight — compute per-product signal inputs in
  //     batched queries so the per-row builder below can derive flags
  //     without N+1. Two extra batches:
  //     - Active alias count per product (for "no article")
  //     - Set of fortnox_invoice_numbers flagged unreliable
  //       (for "unreliable extraction")
  const productIds = products.map((p: any) => p.id)
  const aliasCountByProduct = new Map<string, number>()
  if (productIds.length > 0) {
    for (let i = 0; i < productIds.length; i += BATCH_IN) {
      const slice = productIds.slice(i, i + BATCH_IN)
      const { data: aliasRows, error: acErr } = await db
        .from('product_aliases')
        .select('product_id')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .in('product_id', slice)
      if (acErr) {
        console.error('[items] alias-count batch failed', { batch_size: slice.length, err: acErr })
        return NextResponse.json({ error: `alias-count lookup failed: ${acErr.message}` }, { status: 500 })
      }
      for (const a of aliasRows ?? []) {
        const pid = (a as any).product_id
        aliasCountByProduct.set(pid, (aliasCountByProduct.get(pid) ?? 0) + 1)
      }
    }
  }
  // Pull all extractions with validation_warnings for this business in a
  // single query. Index by fortnox_invoice_number → flagged?
  const flaggedInvoiceNumbers = new Set<string>()
  const { data: extractions, error: eErr } = await db
    .from('invoice_pdf_extractions')
    .select('fortnox_invoice_number, validation_warnings')
    .eq('business_id', businessId)
    .not('validation_warnings', 'is', null)
  if (eErr) {
    console.error('[items] extractions lookup failed', { err: eErr })
    return NextResponse.json({ error: `extractions lookup failed: ${eErr.message}` }, { status: 500 })
  }
  for (const e of extractions ?? []) {
    const warnings = Array.isArray((e as any).validation_warnings) ? (e as any).validation_warnings : []
    const flagged = warnings.some((w: any) => w?.code === 'over_extraction' || w?.code === 'total_mismatch')
    if (flagged && (e as any).fortnox_invoice_number) {
      flaggedInvoiceNumbers.add(String((e as any).fortnox_invoice_number))
    }
  }

  // 4. Aggregate per product.
  const NOW = Date.now()
  const NINETY_DAYS_MS = 90 * 86_400_000
  const linesByProduct = new Map<string, any[]>()
  for (const l of allLines) {
    const pid = aliasToProduct.get(l.product_alias_id)
    if (!pid) continue
    if (!linesByProduct.has(pid)) linesByProduct.set(pid, [])
    linesByProduct.get(pid)!.push(l)
  }

  const items: CatalogueItem[] = products.map((p: any) => {
    const lines = (linesByProduct.get(p.id) ?? []).slice().sort((a, b) =>
      (b.invoice_date ?? '').localeCompare(a.invoice_date ?? '')
    )
    if (lines.length === 0) {
      // No matched invoice lines yet. attention signals derive from
      // the product alone: alias count + price_override + default
      // supplier. Recipe-sourced products get their price below; do
      // NOT pre-flag those as no_price here — the linked-recipe
      // pass overwrites latest_price.
      const reasons: Array<'no_article' | 'no_price' | 'unreliable' | 'no_supplier'> = []
      if ((aliasCountByProduct.get(p.id) ?? 0) === 0) reasons.push('no_article')
      if (p.price_override == null && !p.source_recipe_id) reasons.push('no_price')
      if (!p.default_supplier_name) reasons.push('no_supplier')
      // No matched lines → no extraction to flag → 'unreliable' is N/A.
      return {
        product_id:         p.id,
        name:               p.name,
        category:           p.category,
        default_supplier:   p.default_supplier_name,
        latest_price:       null,
        latest_unit:        null,
        latest_supplier:    null,
        latest_date:        null,
        prior_median_price: null,
        change_pct:         null,
        observation_count:  0,
        is_recipe_sourced:  !!p.source_recipe_id,
        source_recipe_id:   p.source_recipe_id ?? null,
        needs_attention:    reasons.length > 0,
        attention_reasons:  reasons,
      }
    }
    const latest = lines[0]
    // prior-median: lines older than the latest, within 90 days before the latest
    const latestTs = new Date(latest.invoice_date).getTime()
    const cutoffTs = latestTs - NINETY_DAYS_MS
    const priorPrices = lines.slice(1)
      .filter(l => {
        const t = new Date(l.invoice_date).getTime()
        return t < latestTs && t >= cutoffTs && l.price_per_unit != null
      })
      .map(l => Number(l.price_per_unit))
    const priorMedian = priorPrices.length > 0
      ? median(priorPrices)
      : null
    const changePct = priorMedian != null && priorMedian !== 0 && latest.price_per_unit != null
      ? (Number(latest.price_per_unit) - priorMedian) / priorMedian
      : null
    // Needs-attention signals for products with matched lines.
    //
    // no_price: mirrors the engine's "any usable price?" derivation —
    // the cost reader prefers total_excl_vat/quantity (more reliable
    // than raw price_per_unit), so flag no_price only when BOTH are
    // missing AND there's no price_override.
    const hasUsablePrice =
      p.price_override != null
      || latest.price_per_unit != null
      || (latest.total_excl_vat != null && latest.quantity != null && Number(latest.quantity) > 0)
    const reasons: Array<'no_article' | 'no_price' | 'unreliable' | 'no_supplier'> = []
    if ((aliasCountByProduct.get(p.id) ?? 0) === 0) reasons.push('no_article')
    if (!hasUsablePrice) reasons.push('no_price')
    if (latest.fortnox_invoice_number && flaggedInvoiceNumbers.has(String(latest.fortnox_invoice_number))) {
      reasons.push('unreliable')
    }
    if (!p.default_supplier_name && !latest.supplier_name_snapshot) reasons.push('no_supplier')

    return {
      product_id:         p.id,
      name:               p.name,
      category:           p.category,
      default_supplier:   p.default_supplier_name,
      latest_price:       latest.price_per_unit != null ? Number(latest.price_per_unit) : null,
      latest_unit:        latest.unit,
      latest_supplier:    latest.supplier_name_snapshot,
      latest_date:        latest.invoice_date,
      prior_median_price: priorMedian,
      change_pct:         changePct,
      observation_count:  lines.length,
      is_recipe_sourced:  !!p.source_recipe_id,
      source_recipe_id:   p.source_recipe_id ?? null,
      needs_attention:    reasons.length > 0,
      attention_reasons:  reasons,
    }
  })

  // Recipe-sourced products won't have supplier_invoice_lines, so their
  // latest_price slot is currently null. Fill from the linked recipes'
  // current cost-per-portion (food_cost / portions). Single batched
  // query for all linked recipes.
  const recipeIds = items.filter(i => i.is_recipe_sourced && i.source_recipe_id).map(i => i.source_recipe_id!) as string[]
  if (recipeIds.length > 0) {
    // Pull each recipe's food_cost via the cost helper. To avoid pulling
    // every recipe in the business twice, we'll compute inline.
    const { loadRecipeIndex, getProductLatestPrices, computeRecipeCost } = await import('@/lib/inventory/recipe-cost')
    const { loadFxIndex } = await import('@/lib/inventory/fx')
    const fxIndex = await loadFxIndex(db, ['EUR', 'USD', 'NOK', 'DKK', 'GBP'])
    const recipeIndex = await loadRecipeIndex(db, businessId)
    const allLeafProductIds = new Set<string>()
    for (const entry of recipeIndex.values()) {
      for (const ing of entry.ingredients) if (ing.product_id) allLeafProductIds.add(ing.product_id)
    }
    const priceMap = await getProductLatestPrices(db, businessId, Array.from(allLeafProductIds), fxIndex)
    for (const it of items) {
      if (!it.is_recipe_sourced || !it.source_recipe_id) continue
      const entry = recipeIndex.get(it.source_recipe_id)
      if (!entry) continue
      const summary = computeRecipeCost(entry.ingredients, priceMap, null, {
        recipeIndex, recipeId: it.source_recipe_id,
      })
      const portions = Math.max(1, entry.portions)
      it.latest_price = Math.round((summary.food_cost / portions) * 100) / 100
      it.latest_unit  = 'portion'
    }
  }

  // Counts by category for filter tabs — computed from the UNFILTERED
  // catalogue so each tab shows the real number even when a non-'all'
  // filter is active.
  const counts: Record<string, number> = { all: allProducts.length }
  for (const p of allProducts) counts[p.category] = (counts[p.category] ?? 0) + 1
  // needs_attention count uses the CURRENT items[] (which is already
  // filtered by category if the owner selected one). For the filter
  // chip to feel like a worklist, we surface it at the response root
  // and (separately) compute a "global" total across all categories so
  // the chip reads the same regardless of category filter.
  const needsAttentionInView = items.filter(i => i.needs_attention).length
  return NextResponse.json({
    counts,
    items,
    needs_attention_count: needsAttentionInView,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}
