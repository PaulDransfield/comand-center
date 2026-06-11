// app/api/inventory/counts/[id]/route.ts
//
// GET — returns the count header + every catalogue product joined with
//       any existing count line. Shape is designed for a mobile-first
//       page that lets owner walk shelves and type counts.
//       Per row, returns:
//         · product (id, name, category, invoice_unit, base_unit, pack_size)
//         · current_unit_price_sek  (LIVE — what it's worth today)
//         · saved_quantity, saved_unit, saved_unit_price_at_count
//           (if a line exists for this product in this count)
//         · current_line_value      (if saved_quantity → quantity × current price)
//         · snapshot_line_value     (if saved_quantity → quantity × snapshot price)
//
// PATCH — accepts either:
//   { line: { product_id, quantity, unit, notes? } }   — save/update one line
//   { complete: true }                                  — mark count complete + freeze totals
//   { archive: true }                                   — soft-delete the count
//
// All editing happens through PATCH to keep concurrency simple. No
// transactional submit — owner can leave & resume mid-walk.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { getProductLatestPrices } from '@/lib/inventory/recipe-cost'
import { loadFxIndex } from '@/lib/inventory/fx'
import { convertQuantity } from '@/lib/inventory/unit-conversion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: count, error: cErr } = await db
    .from('stock_counts')
    .select('id, business_id, count_date, location_id, notes, started_at, completed_at, created_by, total_value_at_count, total_lines, location:stock_locations(name)')
    .eq('id', params.id)
    .maybeSingle()
  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 })
  if (!count) return NextResponse.json({ error: 'count not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, count.business_id)
  if (forbidden) return forbidden

  // Resolve who ran the count (created_by → public.users) so the header +
  // Excel export can show accountability. Same resolver the prep view uses.
  let countedByName: string | null = null
  if (count.created_by) {
    const { data: u } = await db.from('users').select('full_name, email').eq('id', count.created_by).maybeSingle()
    countedByName = (u as any)?.full_name || (u as any)?.email || null
  }

  // Duration = started_at → completed_at (only once completed).
  let durationSeconds: number | null = null
  if (count.started_at && count.completed_at) {
    const ms = new Date(count.completed_at).getTime() - new Date(count.started_at).getTime()
    if (Number.isFinite(ms) && ms >= 0) durationSeconds = Math.round(ms / 1000)
  }

  // All non-archived products for the business. M130 — also pull
  // created_via so the recipe-import-draft tag flows through to the
  // is_recipe_sourced flag below (matches the items API).
  const { data: products } = await db
    .from('products')
    .select('id, name, category, invoice_unit, base_unit, pack_size, default_supplier_name, source_recipe_id, created_via')
    .eq('business_id', count.business_id)
    .is('archived_at', null)
    .order('category')
    .order('name')

  // All existing lines for this count
  const { data: lines } = await db
    .from('stock_count_lines')
    .select('id, product_id, quantity, unit, unit_price_at_count, line_value_at_count, pack_size_at_count, base_unit_at_count, invoice_unit_at_count, notes, updated_at')
    .eq('count_id', count.id)

  // Live prices for all products (so we can show current value side-by-side)
  const fxIndex  = await loadFxIndex(db, ['EUR', 'USD', 'NOK', 'DKK', 'GBP'])
  const productIds = (products ?? []).map((p: any) => p.id)
  const priceMap = await getProductLatestPrices(db, count.business_id, productIds, fxIndex)

  const linesByProduct = new Map<string, any>()
  for (const l of lines ?? []) linesByProduct.set(l.product_id, l)

  const rows = (products ?? []).map((p: any) => {
    const line = linesByProduct.get(p.id)
    const pricing = priceMap.get(p.id)
    const currentPricePerInvoiceUnit = pricing?.latest_price_sek ?? null

    // For SAVED lines: snapshot value (already on the row) + current
    // value (recompute quantity × current unit price, converted to
    // product's invoice_unit via the same base-unit math the recipe
    // cost uses).
    let currentLineValue: number | null = null
    if (line && line.quantity != null && currentPricePerInvoiceUnit != null) {
      const packSize = p.pack_size != null ? Number(p.pack_size) : null
      const baseUnit = p.base_unit
      if (packSize && baseUnit) {
        const qtyInBase = convertQuantity(Number(line.quantity), line.unit, baseUnit)
        if (qtyInBase != null) {
          currentLineValue = Math.round(qtyInBase * (currentPricePerInvoiceUnit / packSize) * 100) / 100
        }
      } else {
        // No pack data — treat count unit as the invoice unit (1:1)
        currentLineValue = Math.round(Number(line.quantity) * currentPricePerInvoiceUnit * 100) / 100
      }
    }

    return {
      product_id:        p.id,
      product_name:      p.name,
      category:          p.category,
      invoice_unit:      p.invoice_unit,
      base_unit:         p.base_unit,
      pack_size:         p.pack_size != null ? Number(p.pack_size) : null,
      default_supplier:  p.default_supplier_name,
      // M130 — recipe-import drafts (products created from the recipe
      // editor's "Add ingredient → new product" path) deserve the same
      // RECIPE badge / suppressed warnings as promoted recipe products.
      // Mirrors items/route.ts:439,489.
      is_recipe_sourced: !!p.source_recipe_id || p.created_via === 'recipe_import_draft',
      current_unit_price_sek: currentPricePerInvoiceUnit,
      saved: line ? {
        line_id:                line.id,
        quantity:               Number(line.quantity),
        unit:                   line.unit,
        unit_price_at_count:    line.unit_price_at_count != null ? Number(line.unit_price_at_count) : null,
        line_value_at_count:    line.line_value_at_count != null ? Number(line.line_value_at_count) : null,
        invoice_unit_at_count:  line.invoice_unit_at_count,
        pack_size_at_count:     line.pack_size_at_count != null ? Number(line.pack_size_at_count) : null,
        base_unit_at_count:     line.base_unit_at_count,
        notes:                  line.notes,
        updated_at:             line.updated_at,
        current_line_value:     currentLineValue,
      } : null,
    }
  })

  // Total snapshot value is the count's stored field if completed;
  // otherwise sum of saved lines' line_value_at_count.
  const totalSnapshot = count.total_value_at_count != null
    ? Number(count.total_value_at_count)
    : (lines ?? []).reduce((s: number, l: any) => s + (Number(l.line_value_at_count) || 0), 0)

  const totalCurrent = rows.reduce((s, r) => s + (r.saved?.current_line_value ?? 0), 0)

  return NextResponse.json({
    count: {
      ...count,
      location_name: (count.location as any)?.name ?? null,
      counted_by_name: countedByName,
      duration_seconds: durationSeconds,
      total_value_at_count: count.total_value_at_count != null ? Number(count.total_value_at_count) : null,
    },
    rows,
    totals: {
      snapshot_value: Math.round(totalSnapshot * 100) / 100,
      current_value:  Math.round(totalCurrent  * 100) / 100,
      lines_counted:  (lines ?? []).length,
      products_total: (products ?? []).length,
    },
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: count } = await db
    .from('stock_counts')
    .select('id, business_id, completed_at')
    .eq('id', params.id)
    .maybeSingle()
  if (!count) return NextResponse.json({ error: 'count not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, count.business_id)
  if (forbidden) return forbidden

  let body: any
  try { body = await req.json() } catch { body = {} }

  // Archive ---------------------------------------------------------
  if (body.archive === true) {
    const { error } = await db.from('stock_counts')
      .update({ archived_at: new Date().toISOString() })
      .eq('id', params.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  // Complete --------------------------------------------------------
  if (body.complete === true) {
    if (count.completed_at) return NextResponse.json({ ok: true, already_completed: true })
    // Freeze totals from saved lines
    const { data: lines } = await db
      .from('stock_count_lines')
      .select('id, line_value_at_count')
      .eq('count_id', params.id)
    const totalValue = (lines ?? []).reduce((s, l: any) => s + (Number(l.line_value_at_count) || 0), 0)
    const { error } = await db.from('stock_counts')
      .update({
        completed_at:         new Date().toISOString(),
        total_value_at_count: Math.round(totalValue * 100) / 100,
        total_lines:          (lines ?? []).length,
      })
      .eq('id', params.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  // Edit header -----------------------------------------------------
  if (body.header) {
    const headerPatch: any = {}
    if (body.header.count_date)  headerPatch.count_date  = String(body.header.count_date)
    if (body.header.location_id !== undefined) headerPatch.location_id = body.header.location_id || null
    if (body.header.notes      !== undefined) headerPatch.notes       = body.header.notes ? String(body.header.notes).trim() : null
    if (Object.keys(headerPatch).length === 0) return NextResponse.json({ error: 'header: no editable fields' }, { status: 400 })
    const { error } = await db.from('stock_counts').update(headerPatch).eq('id', params.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  // Save / update line ----------------------------------------------
  if (body.line) {
    if (count.completed_at) return NextResponse.json({ error: 'count is completed — cannot edit lines (re-open or create a new count)' }, { status: 409 })
    const productId = String(body.line.product_id ?? '').trim()
    if (!productId) return NextResponse.json({ error: 'line.product_id required' }, { status: 400 })

    // Treat quantity=0 + delete=true as a remove operation
    if (body.line.delete === true) {
      const { error } = await db
        .from('stock_count_lines')
        .delete()
        .eq('count_id', params.id)
        .eq('product_id', productId)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, deleted: true })
    }

    const quantity = Number(body.line.quantity)
    const unit     = String(body.line.unit ?? '').trim()
    if (!Number.isFinite(quantity) || quantity < 0) return NextResponse.json({ error: 'quantity must be >= 0' }, { status: 400 })
    if (!unit) return NextResponse.json({ error: 'unit required' }, { status: 400 })

    // Snapshot current price + pack info
    const { data: prod } = await db
      .from('products')
      .select('id, business_id, invoice_unit, base_unit, pack_size')
      .eq('id', productId)
      .maybeSingle()
    if (!prod) return NextResponse.json({ error: 'product not found' }, { status: 404 })
    if (prod.business_id !== count.business_id) return NextResponse.json({ error: 'product is from a different business' }, { status: 403 })

    const fxIndex  = await loadFxIndex(db, ['EUR', 'USD', 'NOK', 'DKK', 'GBP'])
    const priceMap = await getProductLatestPrices(db, count.business_id, [productId], fxIndex)
    const pricing  = priceMap.get(productId)
    const unitPriceSek = pricing?.latest_price_sek ?? null

    // line value = qty (converted to base_unit) × (unitPriceSek / pack_size)
    // When pack data missing, fall back to qty × unitPriceSek (1:1)
    let lineValue: number | null = null
    if (unitPriceSek != null) {
      const packSize = prod.pack_size != null ? Number(prod.pack_size) : null
      if (packSize && prod.base_unit) {
        const qtyInBase = convertQuantity(quantity, unit, prod.base_unit)
        if (qtyInBase != null) {
          lineValue = Math.round(qtyInBase * (unitPriceSek / packSize) * 100) / 100
        }
      } else {
        lineValue = Math.round(quantity * unitPriceSek * 100) / 100
      }
    }

    // SELECT-then-INSERT-or-UPDATE — UNIQUE(count_id, product_id) is full so upsert WOULD work; using the safer pattern.
    const { data: existing } = await db
      .from('stock_count_lines')
      .select('id')
      .eq('count_id', params.id)
      .eq('product_id', productId)
      .maybeSingle()

    const lineRow = {
      count_id:               params.id,
      product_id:             productId,
      quantity,
      unit,
      unit_price_at_count:    unitPriceSek,
      line_value_at_count:    lineValue,
      pack_size_at_count:     prod.pack_size,
      base_unit_at_count:     prod.base_unit,
      invoice_unit_at_count:  prod.invoice_unit,
      notes:                  body.line.notes ? String(body.line.notes).trim() : null,
    }

    if (existing?.id) {
      const { error } = await db.from('stock_count_lines').update(lineRow).eq('id', existing.id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    } else {
      const { error } = await db.from('stock_count_lines').insert(lineRow)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true, line_value: lineValue, unit_price: unitPriceSek })
  }

  return NextResponse.json({ error: 'nothing to patch — supply { line }, { header }, { complete } or { archive }' }, { status: 400 })
}
