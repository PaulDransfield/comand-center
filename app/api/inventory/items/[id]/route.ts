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
import { loadFxIndex, getFxRate } from '@/lib/inventory/fx'
import { getFortnoxWorkspaceId, supplierInvoiceUrl } from '@/lib/fortnox/web-url'

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
    .select('id, org_id, business_id, name, category, default_supplier_fortnox_number, default_supplier_name, invoice_unit, count_unit, unit_conversion, pack_size, base_unit, source_recipe_id, price_override, price_override_currency, price_override_set_at, archived_at, created_at, updated_at')
    .eq('id', id)
    .maybeSingle()
  if (pErr)      return NextResponse.json({ error: pErr.message }, { status: 500 })
  if (!product)  return NextResponse.json({ error: 'product not found' }, { status: 404 })

  const forbidden = requireBusinessAccess(auth, product.business_id)
  if (forbidden) return forbidden

  // 2. Aliases for this product. The actual column names in M075 are
  //    raw_description / supplier_name_snapshot / seen_count — alias them
  //    so the UI doesn't need to know about the schema-vs-API mapping.
  //    Error IS checked here now: this query silently returning nothing
  //    cascades into the price history pull returning nothing, which
  //    silently rendered an empty product detail page.
  const { data: aliases, error: aErr } = await db
    .from('product_aliases')
    .select('id, raw_description, supplier_fortnox_number, supplier_name_snapshot, seen_count, first_seen_at, last_seen_at')
    .eq('product_id', id)
    .order('last_seen_at', { ascending: false, nullsFirst: false })
  if (aErr) return NextResponse.json({ error: `aliases lookup failed: ${aErr.message}` }, { status: 500 })

  const aliasIds = (aliases ?? []).map((a: any) => a.id)

  // Reshape to the UI's expected field names.
  const aliasesOut = (aliases ?? []).map((a: any) => ({
    id:                a.id,
    alias_text:        a.raw_description,
    supplier_fortnox_number: a.supplier_fortnox_number,
    supplier_name:     a.supplier_name_snapshot,
    observation_count: a.seen_count ?? 0,
    first_seen_at:     a.first_seen_at,
    last_seen_at:      a.last_seen_at,
  }))

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
          .select('id, invoice_date, fortnox_invoice_number, supplier_name_snapshot, supplier_fortnox_number, raw_description, article_number, quantity, unit, price_per_unit, total_excl_vat, vat_rate, currency')
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

  // FX conversion for non-SEK lines so the UI can show "≈ X SEK"
  // next to the native amount. Owner-flipped EUR/USD/etc rows light
  // up visibly so the metadata change feels like it did something.
  const fxIndex     = await loadFxIndex(db, ['EUR', 'USD', 'NOK', 'DKK', 'GBP'])
  const workspaceId = await getFortnoxWorkspaceId(db, product.business_id)

  // Pull pdf_file_id per invoice number so the price-history rows can
  // surface a "View PDF" affordance (inline modal via the proxy).
  // Single batched query keyed on the distinct invoice numbers in history.
  const distinctInvoices = Array.from(new Set(history.map((h: any) => h.fortnox_invoice_number).filter(Boolean)))
  const fileByInvoice = new Map<string, string>()
  if (distinctInvoices.length > 0) {
    const { data: extractions } = await db
      .from('invoice_pdf_extractions')
      .select('fortnox_invoice_number, pdf_file_id')
      .eq('business_id', product.business_id)
      .in('fortnox_invoice_number', distinctInvoices)
    for (const e of extractions ?? []) {
      if (e.pdf_file_id) fileByInvoice.set(e.fortnox_invoice_number, e.pdf_file_id)
    }
  }

  return NextResponse.json({
    product,
    aliases:    aliasesOut,
    history:    history.map(h => {
      const currency = h.currency ?? 'SEK'
      let priceSek: number | null = null
      let totalSek: number | null = null
      let fxRate:   number | null = null
      if (currency === 'SEK') {
        priceSek = h.price_per_unit != null ? Number(h.price_per_unit) : null
        totalSek = h.total_excl_vat != null ? Number(h.total_excl_vat) : null
        fxRate   = 1
      } else {
        const rate = getFxRate(currency, h.invoice_date, fxIndex)
        if (rate != null) {
          fxRate   = rate
          priceSek = h.price_per_unit != null ? Math.round(Number(h.price_per_unit) * rate * 100) / 100 : null
          totalSek = h.total_excl_vat != null ? Math.round(Number(h.total_excl_vat) * rate * 100) / 100 : null
        }
      }
      const fileId = fileByInvoice.get(h.fortnox_invoice_number) ?? null
      return {
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
        currency,
        price_per_unit_sek: priceSek,
        total_sek:          totalSek,
        fx_rate:            fxRate,
        fortnox_url:     supplierInvoiceUrl(workspaceId, h.fortnox_invoice_number),
        pdf_file_id:     fileId,
        pdf_proxy_url:   fileId
          ? `/api/integrations/fortnox/file?file_id=${encodeURIComponent(fileId)}&business_id=${product.business_id}`
          : null,
      }
    }),
    aggregates,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

// PATCH — edit product header fields. Used by the detail page's inline
// edit affordances (Rename, change category, change invoice unit).
//
// Body: { name?, category?, invoice_unit? }
// Returns: { ok, product }
//
// Collision: products has UNIQUE (business_id, name). If the new name
// already exists for another product in this business, returns 409 with
// a useful message — owner can either pick a different name or, in a
// future iteration, merge the two products.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const id = params.id
  let body: any
  try { body = await req.json() } catch { body = {} }

  const patch: Record<string, any> = {}
  if (typeof body.name === 'string') {
    const trimmed = body.name.trim()
    if (!trimmed) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    if (trimmed.length > 200) return NextResponse.json({ error: 'name too long (max 200)' }, { status: 400 })
    patch.name = trimmed
  }
  if (typeof body.category === 'string') {
    const valid = ['food', 'beverage', 'alcohol', 'cleaning', 'takeaway_material', 'disposables', 'other']
    if (!valid.includes(body.category)) {
      return NextResponse.json({ error: `category must be one of: ${valid.join(', ')}` }, { status: 400 })
    }
    patch.category = body.category
  }
  if (body.invoice_unit !== undefined) {
    patch.invoice_unit = body.invoice_unit ? String(body.invoice_unit).trim() : null
  }
  if (body.pack_size !== undefined) {
    if (body.pack_size === null || body.pack_size === '') patch.pack_size = null
    else {
      const ps = Number(body.pack_size)
      if (!Number.isFinite(ps) || ps <= 0) return NextResponse.json({ error: 'pack_size must be > 0' }, { status: 400 })
      patch.pack_size = ps
    }
  }
  if (body.base_unit !== undefined) {
    if (body.base_unit === null || body.base_unit === '') patch.base_unit = null
    else {
      const valid = ['g', 'ml', 'st']
      const bu = String(body.base_unit).trim().toLowerCase()
      if (!valid.includes(bu)) return NextResponse.json({ error: `base_unit must be one of: ${valid.join(', ')}` }, { status: 400 })
      patch.base_unit = bu
    }
  }
  if (body.price_override !== undefined) {
    if (body.price_override === null || body.price_override === '') {
      patch.price_override = null
      patch.price_override_set_at = null
    } else {
      const p = Number(body.price_override)
      if (!Number.isFinite(p) || p < 0) return NextResponse.json({ error: 'price_override must be >= 0' }, { status: 400 })
      patch.price_override = p
      patch.price_override_set_at = new Date().toISOString()
    }
  }
  if (body.price_override_currency !== undefined) {
    if (body.price_override_currency === null || body.price_override_currency === '') patch.price_override_currency = null
    else {
      const valid = ['SEK', 'EUR', 'USD', 'NOK', 'DKK', 'GBP']
      const c = String(body.price_override_currency).trim().toUpperCase()
      if (!valid.includes(c)) return NextResponse.json({ error: `currency must be one of: ${valid.join(', ')}` }, { status: 400 })
      patch.price_override_currency = c
    }
  }
  if (body.default_supplier_name !== undefined) {
    patch.default_supplier_name = body.default_supplier_name ? String(body.default_supplier_name).trim() : null
  }
  if (body.default_supplier_fortnox_number !== undefined) {
    patch.default_supplier_fortnox_number = body.default_supplier_fortnox_number ? String(body.default_supplier_fortnox_number).trim() : null
  }
  if (body.archived !== undefined) {
    patch.archived_at = body.archived ? new Date().toISOString() : null
  }
  // M110 — default yield-loss for this product. Auto-fills recipe_ingredients
  // .waste_pct at link time so the same product costs consistently across
  // dishes. Bounds match the recipe-line CHECK (0..<100); 95% is the hard
  // ceiling per inflateForWaste's clamp.
  if (body.default_waste_pct !== undefined) {
    if (body.default_waste_pct === null) patch.default_waste_pct = 0
    else {
      const w = Number(body.default_waste_pct)
      if (!Number.isFinite(w) || w < 0 || w >= 100) {
        return NextResponse.json({ error: 'default_waste_pct must be between 0 and < 100' }, { status: 400 })
      }
      patch.default_waste_pct = w
    }
  }
  // M122 — weight_per_piece_g for count-based products (eggs, brioche,
  // etc.). When the owner sets it manually the source flips to 'manual'
  // so the backfill script never overwrites it. Bounds match the CHECK.
  if (body.weight_per_piece_g !== undefined) {
    if (body.weight_per_piece_g === null || body.weight_per_piece_g === '') {
      patch.weight_per_piece_g      = null
      patch.weight_per_piece_source = null
    } else {
      const v = Number(body.weight_per_piece_g)
      if (!Number.isFinite(v) || v <= 0 || v > 100000) {
        return NextResponse.json({ error: 'weight_per_piece_g must be > 0 and ≤ 100000' }, { status: 400 })
      }
      patch.weight_per_piece_g      = Math.round(v * 1000) / 1000
      patch.weight_per_piece_source = 'manual'
    }
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no editable fields supplied' }, { status: 400 })
  }

  const db = createAdminClient()

  // Auth: load the product first so we can verify business ownership.
  const { data: existing, error: exErr } = await db
    .from('products')
    .select('id, business_id')
    .eq('id', id)
    .maybeSingle()
  if (exErr)     return NextResponse.json({ error: exErr.message }, { status: 500 })
  if (!existing) return NextResponse.json({ error: 'product not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, existing.business_id)
  if (forbidden) return forbidden

  const { data, error } = await db
    .from('products')
    .update(patch)
    .eq('id', id)
    .select('id, name, category, default_supplier_name, default_supplier_fortnox_number, invoice_unit, count_unit, pack_size, base_unit, price_override, price_override_currency, archived_at, updated_at')
    .single()

  if (error) {
    if ((error as any).code === '23505') {
      return NextResponse.json({
        error: `A product called "${patch.name}" already exists in this business — pick a different name, or merge the two products manually.`,
      }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, product: data }, { headers: { 'Cache-Control': 'no-store' } })
}
