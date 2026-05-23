// app/api/inventory/needs-review/approve/route.ts
//
// POST — owner clicks "Approve" on a bulk-review group. Creates ONE
// product + alias for the group, then re-links every needs_review line
// in the group to match_status='matched' under that alias.
//
// Body:
//   {
//     business_id:  string,
//     group_key:    string,           // opaque base64url from the GET response
//     product_name: string,           // owner can edit before approval
//     category:     InventoryCategory // default = group's suggested_category
//   }
//
// Returns:
//   { ok, product_id, alias_id, lines_linked }
//
// Idempotent against double-clicks: the second call decodes the same key,
// finds zero needs_review lines (already matched), and is a no-op — but
// the product/alias upsert may have already created the row, so we re-
// resolve and return the existing IDs.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { normaliseDescription } from '@/lib/inventory/normalise'
import { createProductFromLine } from '@/lib/inventory/matcher'
import type { InventoryCategory } from '@/lib/inventory/categories'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VALID_CATEGORIES: InventoryCategory[] = [
  'food', 'beverage', 'alcohol', 'cleaning', 'takeaway_material', 'disposables', 'other',
]

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId  = String(body.business_id  ?? '').trim()
  const groupKey    = String(body.group_key    ?? '').trim()
  const productName = String(body.product_name ?? '').trim()
  const category    = String(body.category     ?? 'other').trim() as InventoryCategory

  if (!businessId)  return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!groupKey)    return NextResponse.json({ error: 'group_key required' },   { status: 400 })
  if (!productName) return NextResponse.json({ error: 'product_name required' }, { status: 400 })
  if (!VALID_CATEGORIES.includes(category)) {
    return NextResponse.json({ error: `category must be one of: ${VALID_CATEGORIES.join(', ')}` }, { status: 400 })
  }
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  // Decode the opaque key — supplier\x1f normalised\x1f unit
  let supplierFortnoxNumber: string
  let normalisedTarget:      string
  let unitTarget:            string
  try {
    const decoded = Buffer.from(groupKey, 'base64url').toString('utf-8')
    const parts = decoded.split('\x1f')
    if (parts.length !== 3) throw new Error('bad part count')
    supplierFortnoxNumber = parts[0]
    normalisedTarget      = parts[1]
    unitTarget            = parts[2]
  } catch {
    return NextResponse.json({ error: 'group_key invalid (cannot decode)' }, { status: 400 })
  }

  const db = createAdminClient()

  // Resolve the business org_id (needed for createProductFromLine).
  const { data: biz, error: bizErr } = await db
    .from('businesses')
    .select('id, org_id')
    .eq('id', businessId)
    .maybeSingle()
  if (bizErr) return NextResponse.json({ error: bizErr.message }, { status: 500 })
  if (!biz)   return NextResponse.json({ error: 'business not found' }, { status: 404 })

  // Pull every needs_review line for this (business, supplier). We have
  // to normalise in JS because supplier_invoice_lines doesn't store the
  // normalised form. Pagination not needed — even busy suppliers don't
  // exceed a few hundred lines per business.
  const { data: candidateLines, error: cErr } = await db
    .from('supplier_invoice_lines')
    .select('id, raw_description, unit, article_number, account_number, supplier_name_snapshot, supplier_fortnox_number, business_id, org_id')
    .eq('business_id', businessId)
    .eq('supplier_fortnox_number', supplierFortnoxNumber)
    .eq('match_status', 'needs_review')
    .limit(5000)
  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 })
  if (!candidateLines || candidateLines.length === 0) {
    return NextResponse.json({ ok: true, lines_linked: 0, message: 'No needs_review lines remain for this group (already processed)' })
  }

  const matching = candidateLines.filter((l: any) =>
    normaliseDescription(l.raw_description) === normalisedTarget &&
    (l.unit ?? '').trim().toLowerCase() === unitTarget
  )
  if (matching.length === 0) {
    return NextResponse.json({ ok: true, lines_linked: 0, message: 'No matching lines (group may already be processed)' })
  }

  // Pick the first line as the representative for product creation.
  // The matcher's createProductFromLine seeds the product + alias from
  // its raw values — supplier + first-spelling description go onto the
  // alias row; the canonical product name is what the owner typed.
  const seed = matching[0]
  let product_id: string
  let alias_id:   string
  try {
    const created = await createProductFromLine(
      db,
      {
        id:                       seed.id,
        business_id:              seed.business_id,
        org_id:                   seed.org_id,
        supplier_fortnox_number:  seed.supplier_fortnox_number,
        supplier_name_snapshot:   seed.supplier_name_snapshot,
        article_number:           seed.article_number,
        raw_description:          seed.raw_description,
        unit:                     seed.unit,
        account_number:           seed.account_number,
      },
      productName,
      category,
    )
    product_id = created.product_id
    alias_id   = created.alias_id
  } catch (err: any) {
    return NextResponse.json({ error: `createProduct failed: ${err?.message ?? err}` }, { status: 500 })
  }

  // Re-link every matching line. Chunk into 500-row batches for the .in()
  // limit.
  const ids = matching.map((l: any) => l.id)
  let updated = 0
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500)
    const { data, error } = await db
      .from('supplier_invoice_lines')
      .update({
        match_status:     'matched',
        product_alias_id: alias_id,
      })
      .in('id', slice)
      .select('id')
    if (error) {
      // Best effort — return what we managed to link.
      return NextResponse.json({
        ok: false,
        product_id,
        alias_id,
        lines_linked: updated,
        error: `partial: ${error.message}`,
      }, { status: 500 })
    }
    updated += data?.length ?? 0
  }

  return NextResponse.json({
    ok: true,
    product_id,
    alias_id,
    lines_linked: updated,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
