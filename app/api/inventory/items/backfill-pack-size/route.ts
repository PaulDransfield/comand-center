// app/api/inventory/items/backfill-pack-size/route.ts
//
// POST — runs the canonical pack-size derivation chain on every product
// in the business where pack_size IS NULL. Resolution order:
//
//   1. supplier_articles row matched via the latest (supplier, article_number)
//      on this product's lines → packFromSupplierArticle()
//      (high confidence: pack_source='supplier_official')
//   2. parseProductPackSize (name first, invoice_unit fallback)
//      (medium confidence: 'name_parsed' or 'invoice_unit_inferred')
//   3. null — owner intervention later
//
// Body: { business_id }
// Returns: { ok, scanned, applied, applied_from_supplier_article,
//            applied_from_name, applied_from_invoice_unit,
//            still_missing, details: [{ id, name, suggestion }] }
//
// 2026-06-03 — added the supplier_articles consultation step. With the
// MS catalogue scraped (725 articles), this is the highest-authority
// source for pack info. owner_set values are NEVER touched.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { parseProductPackSize } from '@/lib/inventory/unit-conversion'
import { packFromSupplierArticle } from '@/lib/inventory/pack-from-supplier-article'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // Pull every product without pack_size. Paginate to be safe at scale.
  const candidates: any[] = []
  let from = 0
  while (true) {
    const { data, error } = await db
      .from('products')
      .select('id, name, invoice_unit, base_unit')
      .eq('business_id', businessId)
      .is('archived_at', null)
      .is('pack_size', null)
      .range(from, from + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data || data.length === 0) break
    candidates.push(...data)
    if (data.length < 1000) break
    from += 1000
    if (from > 20_000) break
  }

  // Build a product_id → latest (supplier_fortnox_number, article_number)
  // map by walking aliases → recent supplier_invoice_lines. We use this
  // to look up the supplier_articles row before falling back to the
  // name parser. ONE round-trip per chunk of 100 product_ids.
  const productCombos = new Map<string, { sup: string; art: string }>()
  const candidateIds = candidates.map(p => p.id)
  for (let i = 0; i < candidateIds.length; i += 100) {
    const slice = candidateIds.slice(i, i + 100)
    const { data: aliases } = await db.from('product_aliases')
      .select('id, product_id').in('product_id', slice).eq('is_active', true)
    if (!aliases?.length) continue
    const aliasToProduct = new Map((aliases ?? []).map(a => [a.id, a.product_id]))
    const aliasIds = (aliases ?? []).map(a => a.id)
    for (let j = 0; j < aliasIds.length; j += 200) {
      const aSlice = aliasIds.slice(j, j + 200)
      const { data: lines } = await db.from('supplier_invoice_lines')
        .select('product_alias_id, supplier_fortnox_number, article_number, invoice_date')
        .in('product_alias_id', aSlice)
        .not('article_number', 'is', null)
        .not('supplier_fortnox_number', 'is', null)
        .order('invoice_date', { ascending: false })
        .limit(2000)
      for (const l of lines ?? []) {
        const pid = aliasToProduct.get(l.product_alias_id); if (!pid) continue
        if (productCombos.has(pid)) continue   // keep most-recent (lines ordered DESC)
        productCombos.set(pid, { sup: l.supplier_fortnox_number, art: l.article_number })
      }
    }
  }

  // For every (supplier, article) combo we found, batch-load the
  // supplier_articles rows we'll need.
  const articleByCombo = new Map<string, any>()
  const combos = [...new Set([...productCombos.values()].map(c => `${c.sup}|${c.art}`))]
  for (let i = 0; i < combos.length; i += 60) {
    const slice = combos.slice(i, i + 60)
    const orParts = slice.map(k => {
      const [sup, art] = k.split('|')
      return `and(supplier_fortnox_number.eq.${sup},article_number.eq.${art})`
    })
    const { data } = await db.from('supplier_articles')
      .select('supplier_fortnox_number, article_number, unit, net_weight_g, units_per_pack, units_per_pack_label, official_name, fetch_status')
      .or(orParts.join(','))
      .eq('fetch_status', 'ok')
    for (const a of data ?? []) {
      articleByCombo.set(`${a.supplier_fortnox_number}|${a.article_number}`, a)
    }
  }

  // Phase 2 fallback: when the line's article_number doesn't match any
  // supplier_articles row (non-standard codes like "KRG336404"), search
  // by NAME against the supplier's catalogue. Useful when the PDF
  // extractor captured a custom/internal article number that isn't in
  // the public catalogue.
  function jaccard(a: string, b: string): number {
    const A = new Set(a.toLowerCase().replace(/[^\wåäöÅÄÖ]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 1))
    const B = new Set(b.toLowerCase().replace(/[^\wåäöÅÄÖ]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 1))
    if (A.size === 0 || B.size === 0) return 0
    let inter = 0; for (const t of A) if (B.has(t)) inter++
    return inter / (A.size + B.size - inter)
  }
  const productNameFallback = new Map<string, any>()   // product_id → supplier_articles row
  const suppliersByProduct  = new Map<string, string>()
  for (const [pid, combo] of productCombos.entries()) suppliersByProduct.set(pid, combo.sup)
  const orphans = candidates.filter(p => {
    const c = productCombos.get(p.id)
    return c && !articleByCombo.has(`${c.sup}|${c.art}`)
  })
  // Group by supplier so we only scan the relevant catalogue slice per
  // product. Confidence floor: Jaccard ≥ 0.5 with no ambiguous tie.
  const suppliersToScan = [...new Set(orphans.map(p => suppliersByProduct.get(p.id)).filter(Boolean))] as string[]
  const catalogueBySupplier = new Map<string, any[]>()
  for (const sup of suppliersToScan) {
    const { data } = await db.from('supplier_articles')
      .select('supplier_fortnox_number, article_number, unit, net_weight_g, units_per_pack, units_per_pack_label, official_name')
      .eq('supplier_fortnox_number', sup)
      .eq('fetch_status', 'ok')
      .limit(2000)
    catalogueBySupplier.set(sup, data ?? [])
  }
  for (const p of orphans) {
    const sup = suppliersByProduct.get(p.id); if (!sup) continue
    const catalogue = catalogueBySupplier.get(sup) ?? []
    let best: { sim: number; row: any } | null = null
    let secondBest = 0
    for (const row of catalogue) {
      if (!row.official_name) continue
      const sim = jaccard(p.name, row.official_name)
      if (!best || sim > best.sim) { secondBest = best?.sim ?? 0; best = { sim, row } }
      else if (sim > secondBest) { secondBest = sim }
    }
    if (best && best.sim >= 0.5 && (best.sim - secondBest) >= 0.1) {
      productNameFallback.set(p.id, best.row)
    }
  }

  const details: Array<{ id: string; name: string; suggestion: any }> = []
  let applied                            = 0
  let appliedFromSupplierArticle         = 0
  let appliedFromSupplierArticleNameMatch = 0
  let appliedFromName                    = 0
  let appliedFromInvoice                 = 0
  for (const p of candidates) {
    // 1a) supplier_articles via article_number (highest authority)
    const combo = productCombos.get(p.id)
    if (combo) {
      const art = articleByCombo.get(`${combo.sup}|${combo.art}`)
      if (art) {
        const decision = packFromSupplierArticle(art as any)
        if (decision.kind !== 'skip') {
          const { error } = await db
            .from('products')
            .update({
              pack_size:   decision.pack_size,
              base_unit:   decision.base_unit,
              pack_source: 'supplier_official',
            })
            .eq('id', p.id)
          if (error) {
            details.push({ id: p.id, name: p.name, suggestion: { error: error.message } })
            continue
          }
          details.push({ id: p.id, name: p.name, suggestion: { ...decision, pack_source: 'supplier_official' } })
          applied++
          appliedFromSupplierArticle++
          continue
        }
      }
    }

    // 1b) supplier_articles via NAME match (Phase 2 fallback)
    // For products whose line carries a non-standard article number
    // (e.g. "KRG336404") but a name-similar entry exists in the
    // supplier's catalogue.
    const nameMatch = productNameFallback.get(p.id)
    if (nameMatch) {
      const decision = packFromSupplierArticle(nameMatch as any)
      if (decision.kind !== 'skip') {
        const { error } = await db
          .from('products')
          .update({
            pack_size:   decision.pack_size,
            base_unit:   decision.base_unit,
            pack_source: 'supplier_official',
          })
          .eq('id', p.id)
        if (error) {
          details.push({ id: p.id, name: p.name, suggestion: { error: error.message } })
          continue
        }
        details.push({ id: p.id, name: p.name, suggestion: { ...decision, pack_source: 'supplier_official', via: 'name_match', match: nameMatch.official_name } })
        applied++
        appliedFromSupplierArticleNameMatch++
        continue
      }
    }

    // 2) Name parser (with invoice_unit fallback)
    const sug = parseProductPackSize(p.name, p.invoice_unit)
    if (!sug) {
      details.push({ id: p.id, name: p.name, suggestion: null })
      continue
    }
    const packSource = sug.source === 'name' ? 'name_parsed' : 'invoice_unit_inferred'
    const { error } = await db
      .from('products')
      .update({
        pack_size:   sug.pack_size,
        base_unit:   sug.base_unit,
        pack_source: packSource,
      })
      .eq('id', p.id)
    if (error) {
      details.push({ id: p.id, name: p.name, suggestion: { error: error.message } })
      continue
    }
    details.push({ id: p.id, name: p.name, suggestion: { ...sug, pack_source: packSource } })
    applied++
    if (sug.source === 'name') appliedFromName++
    else appliedFromInvoice++
  }

  const stillMissing = candidates.length - applied

  return NextResponse.json({
    ok: true,
    scanned:                                       candidates.length,
    applied,
    applied_from_supplier_article:                 appliedFromSupplierArticle,
    applied_from_supplier_article_name_match:      appliedFromSupplierArticleNameMatch,
    applied_from_name:                             appliedFromName,
    applied_from_invoice_unit:                     appliedFromInvoice,
    still_missing:                                 stillMissing,
    details,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
