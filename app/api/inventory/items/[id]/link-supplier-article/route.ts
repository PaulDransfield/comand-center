// app/api/inventory/items/[id]/link-supplier-article/route.ts
//
// Owner-facing way to create a product_alias linking a supplier invoice
// line (typically a needs_review queue entry) to a product. Closes the
// cost-gap for products created manually via the recipe-authoring tool
// or AI bulk importer — they have no supplier-side data without this
// link.
//
// Flow:
//   1. Verify caller owns the product (business + org check).
//   2. Load the supplier_invoice_line they picked (must be same business).
//   3. Build the alias key (business_id, supplier_fortnox_number,
//      normalised_description, unit) using lib/inventory/normalise.ts.
//   4. Look up an existing alias matching that key. If one exists for a
//      DIFFERENT product, fail (4xx with a helpful message — owner needs
//      to repoint that alias via the existing /product-aliases/[id]/repoint
//      endpoint).
//   5. Otherwise upsert the alias (create or update with this product_id).
//   6. Bulk-update every supplier_invoice_line at this business that
//      matches the alias key → product_alias_id = the new alias. This
//      back-fills history so recipe costs reflect every invoice line that
//      was actually the same article.
//
// POST { supplier_invoice_line_id }
//   → { ok, alias_id, lines_linked, alias }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { normaliseDescription } from '@/lib/inventory/normalise'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const lineId = String(body?.supplier_invoice_line_id ?? '').trim()
  if (!lineId) return NextResponse.json({ error: 'supplier_invoice_line_id required' }, { status: 400 })

  const productId = String(params.id)
  const db = createAdminClient()

  // ── Load the product ─────────────────────────────────────────────────
  const { data: product } = await db
    .from('products')
    .select('id, business_id, org_id, name, category')
    .eq('id', productId)
    .maybeSingle()
  if (!product) return NextResponse.json({ error: 'product not found' }, { status: 404 })

  const forbidden = requireBusinessAccess(auth, product.business_id)
  if (forbidden) return forbidden

  // ── Load the source line ─────────────────────────────────────────────
  const { data: line } = await db
    .from('supplier_invoice_lines')
    .select('id, business_id, supplier_fortnox_number, supplier_name_snapshot, article_number, raw_description, unit, product_alias_id')
    .eq('id', lineId)
    .maybeSingle()
  if (!line) return NextResponse.json({ error: 'supplier invoice line not found' }, { status: 404 })
  if (line.business_id !== product.business_id) {
    return NextResponse.json({ error: 'line belongs to a different business' }, { status: 400 })
  }

  // Build alias key. supplier_fortnox_number can legitimately be null for
  // certain rows; the alias's unique constraint allows that combination.
  const supplierFortnoxNumber = line.supplier_fortnox_number ?? null
  const normalised             = normaliseDescription(line.raw_description) || ''
  const unit                   = line.unit ?? null

  if (!normalised) {
    return NextResponse.json({ error: 'supplier line has no usable description to alias on' }, { status: 400 })
  }

  // ── Look up an existing alias on the same key ────────────────────────
  //
  // We MUST NOT silently rewrite an existing alias that points to a
  // different product — that would steal supplier history from another
  // product. If the owner really wants to repoint, they use the existing
  // /product-aliases/[id]/repoint endpoint.
  let aliasQuery = db
    .from('product_aliases')
    .select('id, product_id, supplier_fortnox_number, normalised_description, unit, business_id, raw_description, supplier_name_snapshot, article_number')
    .eq('business_id', product.business_id)
    .eq('normalised_description', normalised)
  if (supplierFortnoxNumber == null) {
    aliasQuery = aliasQuery.is('supplier_fortnox_number', null)
  } else {
    aliasQuery = aliasQuery.eq('supplier_fortnox_number', supplierFortnoxNumber)
  }
  if (unit == null) {
    aliasQuery = aliasQuery.is('unit', null)
  } else {
    aliasQuery = aliasQuery.eq('unit', unit)
  }
  const { data: existing } = await aliasQuery.maybeSingle()

  if (existing && existing.product_id && existing.product_id !== productId) {
    return NextResponse.json({
      error:               'alias_already_linked_to_other_product',
      message:             `This supplier article is already linked to a different product. Open that product's edit modal and repoint the alias instead.`,
      existing_alias_id:   existing.id,
      existing_product_id: existing.product_id,
    }, { status: 409 })
  }

  // ── Create or claim the alias ─────────────────────────────────────────
  let aliasId: string
  if (existing) {
    // Alias exists with no product_id (orphan) — claim it.
    const { data: claimed, error: uErr } = await db
      .from('product_aliases')
      .update({ product_id: productId, last_applied_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select('id')
      .single()
    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })
    aliasId = claimed.id
  } else {
    // Insert a fresh alias. Owner-linked match_method so the audit trail
    // shows this was a manual link, not an automated guess.
    const { data: created, error: iErr } = await db
      .from('product_aliases')
      .insert({
        business_id:              product.business_id,
        product_id:               productId,
        supplier_fortnox_number:  supplierFortnoxNumber,
        supplier_name_snapshot:   line.supplier_name_snapshot,
        article_number:           line.article_number,
        raw_description:          line.raw_description,
        normalised_description:   normalised,
        unit,
        match_method:             'owner_linked',
        match_confidence:         null,
        is_active:                true,
        seen_count:               1,
        first_seen_at:            new Date().toISOString(),
        last_seen_at:             new Date().toISOString(),
        last_applied_at:          new Date().toISOString(),
      })
      .select('id')
      .single()
    if (iErr) {
      // Race: another request created the alias between our SELECT and
      // INSERT. Refetch and claim.
      if ((iErr as any).code === '23505') {
        const { data: raced } = await aliasQuery.maybeSingle()
        if (raced) {
          if (raced.product_id && raced.product_id !== productId) {
            return NextResponse.json({
              error: 'alias_already_linked_to_other_product',
              existing_alias_id: raced.id,
              existing_product_id: raced.product_id,
            }, { status: 409 })
          }
          aliasId = raced.id
        } else {
          return NextResponse.json({ error: iErr.message }, { status: 500 })
        }
      } else {
        return NextResponse.json({ error: iErr.message }, { status: 500 })
      }
    } else {
      aliasId = created.id
    }
  }

  // ── Backfill matching supplier_invoice_lines at this business ────────
  //
  // Every line that matches the alias key gets its product_alias_id set to
  // the new alias + status flipped to 'matched' (so it leaves the review
  // queue). Owner-confirmed at this stage; the matcher will re-link
  // future matching lines automatically.
  let backfill = db
    .from('supplier_invoice_lines')
    .update({ product_alias_id: aliasId, match_status: 'matched' })
    .eq('business_id', product.business_id)
    .ilike('raw_description', line.raw_description)  // raw match first (cheap)
    .neq('match_status', 'matched')                  // idempotent
  if (supplierFortnoxNumber == null) {
    backfill = backfill.is('supplier_fortnox_number', null)
  } else {
    backfill = backfill.eq('supplier_fortnox_number', supplierFortnoxNumber)
  }
  if (unit == null) backfill = backfill.is('unit', null)
  else              backfill = backfill.eq('unit', unit)

  // Apply + count. supabase-js UPDATE chain doesn't accept a second arg
  // on .select() — we chain .select() to return rows then count them.
  const { data: updated, error: bErr } = await backfill.select('id')
  if (bErr) return NextResponse.json({ error: bErr.message }, { status: 500 })
  const count = updated?.length ?? 0

  // Re-fetch the alias for the response so the UI gets the full shape.
  const { data: aliasFull } = await db
    .from('product_aliases')
    .select('id, product_id, supplier_fortnox_number, supplier_name_snapshot, article_number, raw_description, normalised_description, unit, match_method, seen_count, last_seen_at')
    .eq('id', aliasId)
    .maybeSingle()

  return NextResponse.json({
    ok:           true,
    alias_id:     aliasId,
    lines_linked: count ?? 0,
    alias:        aliasFull,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
