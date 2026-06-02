// app/api/inventory/orders/build/route.ts
//
// POST /api/inventory/orders/build
//   body {
//     business_id,
//     prep_session_ids?: string[],           // any prep sessions to include (raw ingredient lines)
//     pre_order_date_from?: string,          // 'YYYY-MM-DD' (inclusive)
//     pre_order_date_to?: string,            // 'YYYY-MM-DD' (inclusive)
//   }
//   → 200 {
//     items: [{
//       product_id, name, category, needed_qty, unit,
//       pack_size, base_unit,
//       latest_supplier_name, latest_supplier_number,
//       source_count,                        // how many sources contributed
//     }],
//     uncertainties: [{ kind, reason }],     // yield-less subs that didn't expand etc.
//   }
//
// This is a READ-ONLY guide endpoint. The chef picks their own order
// quantities based on what they see — we never claim to know exactly
// what they need to buy. Stock-on-hand is deliberately NOT subtracted
// (Phase 2 work); the needed_qty is the demand from prep alone.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { loadRecipeIndex } from '@/lib/inventory/recipe-cost'
import { aggregatePrepRequirements } from '@/lib/inventory/prep-list'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body {
  business_id?:         string
  prep_session_ids?:    string[]
  pre_order_date_from?: string
  pre_order_date_to?:   string
}

interface AggregatedProduct {
  total_qty:     number
  unit:          string
  source_count:  number
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: Body
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const businessId = String(body.business_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  const uncertainties: Array<{ kind: string; reason: string }> = []
  const productAccum = new Map<string, AggregatedProduct>()
  const accumProduct = (productId: string, qty: number, unit: string) => {
    const existing = productAccum.get(productId)
    if (!existing) {
      productAccum.set(productId, { total_qty: qty, unit, source_count: 1 })
      return
    }
    // Sum if the unit matches; flag if it doesn't (rare — usually means
    // a recipe quotes one ingredient in two units across recipes).
    if (existing.unit === unit) {
      existing.total_qty += qty
      existing.source_count += 1
    } else {
      uncertainties.push({
        kind: 'unit_mismatch',
        reason: `Product ${productId.slice(0, 8)} accumulated in both ${existing.unit} and ${unit} — kept ${existing.unit} only.`,
      })
    }
  }

  // 1. Frozen prep_session_lines for the selected sessions. These are
  //    already aggregated per session, so we just sum them across
  //    sessions (no engine re-run needed).
  const sessionIds = (body.prep_session_ids ?? []).filter(s => typeof s === 'string' && s.length > 0)
  // M7 — track which session_ids we silently dropped (cross-tenant or
  // simply not found) so the response can surface them. Helps the
  // frontend catch frontend bugs (wrong id sent) early.
  const droppedSessionIds: string[] = []
  if (sessionIds.length > 0) {
    // Verify the caller's business owns each session (cross-tenant guard).
    const { data: sessions } = await db
      .from('prep_sessions')
      .select('id, business_id')
      .in('id', sessionIds)
    const okSessionIds = (sessions ?? []).filter((s: any) => s.business_id === businessId).map((s: any) => s.id)
    const okSet = new Set(okSessionIds)
    for (const requested of sessionIds) {
      if (!okSet.has(requested)) droppedSessionIds.push(requested)
    }
    if (okSessionIds.length > 0) {
      const { data: lines } = await db
        .from('prep_session_lines')
        .select('session_id, kind, entity_id, total_qty, unit, uncertain, name_snapshot')
        .in('session_id', okSessionIds)
        .eq('kind', 'product')
      for (const l of lines ?? []) {
        if (l.uncertain) {
          uncertainties.push({
            kind:  'frozen_uncertain',
            reason: `${l.name_snapshot} from a prep session is flagged uncertain — included anyway, verify before ordering.`,
          })
        }
        accumProduct(l.entity_id, Number(l.total_qty ?? 0), l.unit ?? '')
      }
      // Also surface the COMPONENT lines that are flagged uncertain —
      // their leaf ingredients weren't aggregated, so the order list
      // is missing those quantities. Chef needs to know.
      const { data: comp } = await db
        .from('prep_session_lines')
        .select('name_snapshot, uncertain, uncertain_reason')
        .in('session_id', okSessionIds)
        .eq('kind', 'component')
        .not('uncertain', 'is', null)
      for (const c of comp ?? []) {
        uncertainties.push({
          kind:  'sub_recipe_unexpanded',
          reason: `${(c as any).name_snapshot}: ${(c as any).uncertain_reason ?? 'sub did not expand'} — its raw ingredients are NOT in this order list.`,
        })
      }
    }
  }

  // 2. Pre-orders in the date range. Each has items=[{recipe_id, qty}];
  //    we run them through the aggregator to expand into raw products.
  const dateFrom = String(body.pre_order_date_from ?? '').trim()
  const dateTo   = String(body.pre_order_date_to   ?? '').trim()
  if (dateFrom && dateTo) {
    const { data: preOrders } = await db
      .from('prep_pre_orders')
      .select('id, items')
      .eq('business_id', businessId)
      .gte('service_date', dateFrom)
      .lte('service_date', dateTo)
      .is('archived_at', null)
    if (preOrders && preOrders.length > 0) {
      // Aggregator needs a recipe index + a name map. One index per business.
      const recipeIndex = await loadRecipeIndex(db, businessId)
      const { data: nameRows } = await db
        .from('recipes')
        .select('id, name')
        .eq('business_id', businessId)
        .is('archived_at', null)
      const recipeNames = new Map<string, string | null>()
      for (const r of nameRows ?? []) recipeNames.set(r.id, r.name ?? null)

      // Combine every pre-order's items into one input list, then aggregate.
      const combinedItems: Array<{ recipe_id: string; qty: number }> = []
      for (const po of preOrders) {
        const items = Array.isArray((po as any).items) ? (po as any).items : []
        for (const it of items) {
          if (it?.recipe_id && Number.isFinite(Number(it?.qty)) && Number(it.qty) > 0) {
            combinedItems.push({ recipe_id: it.recipe_id, qty: Number(it.qty) })
          }
        }
      }
      if (combinedItems.length > 0) {
        const safeItems = combinedItems.filter(i => recipeIndex.has(i.recipe_id))
        const result = aggregatePrepRequirements(safeItems, recipeIndex, recipeNames)
        for (const p of result.products) {
          accumProduct(p.product_id, p.total_qty, p.unit)
        }
        // Pull uncertain-component flags from the pre-order pass too.
        for (const c of result.components) {
          if (c.uncertain) {
            uncertainties.push({
              kind:   'sub_recipe_unexpanded',
              reason: `${c.name ?? c.subrecipe_id.slice(0, 8)} (from pre-orders): ${c.uncertain_reason ?? 'sub did not expand'} — its raw ingredients are NOT in this order list.`,
            })
          }
        }
      }
    }
  }

  // 3. Enrich each aggregated product with name, category, pack info,
  //    and the latest-used supplier. Two lookups in parallel: products
  //    table (name, default supplier, pack), supplier_invoice_lines via
  //    product_aliases (latest historic supplier when default isn't set).
  // M3 — products table + product_aliases are independent queries; fire
  // them in parallel. The aliases→supplier_invoice_lines lookup has to
  // wait for aliases, but parallelising the first two halves the
  // round-trip latency at low cost.
  const productIds = [...productAccum.keys()]
  const productMeta = new Map<string, {
    name:                   string | null
    category:               string | null
    invoice_unit:           string | null
    pack_size:              number | null
    base_unit:              string | null
    default_supplier_name:  string | null
    default_supplier_num:   string | null
  }>()
  const latestSupplierByProduct = new Map<string, { name: string | null; number: string | null }>()

  if (productIds.length > 0) {
    const [prodResp, aliasResp] = await Promise.all([
      db.from('products')
        .select('id, name, category, invoice_unit, pack_size, base_unit, default_supplier_name, default_supplier_fortnox_number')
        .in('id', productIds),
      db.from('product_aliases')
        .select('id, product_id')
        .eq('business_id', businessId)
        .in('product_id', productIds)
        .eq('is_active', true),
    ])
    for (const p of prodResp.data ?? []) {
      productMeta.set((p as any).id, {
        name:                  (p as any).name ?? null,
        category:              (p as any).category ?? null,
        invoice_unit:          (p as any).invoice_unit ?? null,
        pack_size:             (p as any).pack_size != null ? Number((p as any).pack_size) : null,
        base_unit:             (p as any).base_unit ?? null,
        default_supplier_name: (p as any).default_supplier_name ?? null,
        default_supplier_num:  (p as any).default_supplier_fortnox_number ?? null,
      })
    }

    // M2 — process aliases in batches of 50, each batch limited to the
    // 200 most-recent lines. Guarantees per-product coverage even at
    // high invoice volumes (the old single-shot limit(2000) could miss
    // products whose last invoice was older than 2000 lines back).
    const aliasIds = (aliasResp.data ?? []).map((a: any) => a.id)
    const aliasToProduct = new Map<string, string>()
    for (const a of aliasResp.data ?? []) aliasToProduct.set((a as any).id, (a as any).product_id)
    const BATCH = 50
    for (let i = 0; i < aliasIds.length; i += BATCH) {
      const slice = aliasIds.slice(i, i + BATCH)
      const { data: lines } = await db
        .from('supplier_invoice_lines')
        .select('product_alias_id, supplier_name_snapshot, supplier_fortnox_number, invoice_date')
        .eq('business_id', businessId)
        .eq('match_status', 'matched')
        .in('product_alias_id', slice)
        .order('invoice_date', { ascending: false })
        .limit(200)
      for (const l of lines ?? []) {
        const pid = aliasToProduct.get((l as any).product_alias_id)
        if (!pid || latestSupplierByProduct.has(pid)) continue
        latestSupplierByProduct.set(pid, {
          name:   (l as any).supplier_name_snapshot ?? null,
          number: (l as any).supplier_fortnox_number ?? null,
        })
      }
    }
  }

  // Build the response items.
  const items = productIds.map(pid => {
    const acc = productAccum.get(pid)!
    const meta = productMeta.get(pid)
    const def = meta?.default_supplier_name
    const fallback = !def ? latestSupplierByProduct.get(pid) : null
    return {
      product_id:              pid,
      name:                    meta?.name ?? null,
      category:                meta?.category ?? null,
      needed_qty:              Math.round(acc.total_qty * 100) / 100,
      unit:                    acc.unit,
      pack_size:               meta?.pack_size ?? null,
      base_unit:               meta?.base_unit ?? null,
      invoice_unit:            meta?.invoice_unit ?? null,
      latest_supplier_name:    def ?? fallback?.name ?? null,
      latest_supplier_number:  meta?.default_supplier_num ?? fallback?.number ?? null,
      source_count:            acc.source_count,
    }
  })
  // Sort by supplier first (so the page can group), then by qty desc.
  // L5 — explicit comparator: NULL supplier sorts last, named suppliers
  // alphabetical. No more 'zz_unknown' sentinel hack.
  items.sort((a, b) => {
    const sa = a.latest_supplier_name
    const sb = b.latest_supplier_name
    if (sa == null && sb == null) return b.needed_qty - a.needed_qty
    if (sa == null) return  1                   // a is unknown → last
    if (sb == null) return -1                   // b is unknown → last
    const cmp = sa.localeCompare(sb)
    return cmp !== 0 ? cmp : b.needed_qty - a.needed_qty
  })

  return NextResponse.json({ items, uncertainties, dropped_session_ids: droppedSessionIds }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
