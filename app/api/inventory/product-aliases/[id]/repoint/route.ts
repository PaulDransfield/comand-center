// app/api/inventory/product-aliases/[id]/repoint/route.ts
//
// POST — change which product an alias points to. This is the article-
// connection edit from the Edit-Item modal.
//
// PROPAGATION DESIGN (see edit-item-modal-propagation-addendum.md):
//
//   supplier_invoice_lines link to product_aliases.id via product_alias_id.
//   The product_alias_id → product_id join is resolved AT READ TIME in
//   every cost reader (getProductLatestPrices: SELECT aliases WHERE
//   product_id=X → then SELECT supplier_invoice_lines WHERE
//   product_alias_id IN (aliases)). So:
//
//   - Repointing alias X from product A to product B requires ONE
//     UPDATE on product_aliases.product_id.
//   - product A's next cost read no longer sees X's invoice history.
//   - product B's next cost read DOES see it.
//   - Recipes consuming either product re-cost from the new attribution
//     on next render — no synchronous cascade, no Save hang.
//
//   That's why this endpoint completes in milliseconds even when the
//   alias has hundreds of historical lines: nothing about those lines
//   changes; only the alias's pointer does, and the cost reader follows
//   the new pointer on next read.
//
// Body: { product_id: string }   — the new product target
// Returns: { ok, alias_id, previous_product_id, new_product_id, dependent_lines_count }
//
// Idempotent: repointing to the current product is a no-op (returns ok with
// previous=new). Idempotent on retries — same UPDATE.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const newProductId = body.product_id ? String(body.product_id).trim() : null
  if (!newProductId) return NextResponse.json({ error: 'product_id required' }, { status: 400 })

  const db = createAdminClient()

  // Load alias + its business + verify access.
  const { data: alias, error: aErr } = await db
    .from('product_aliases')
    .select('id, business_id, product_id, supplier_fortnox_number, raw_description, is_active')
    .eq('id', params.id)
    .maybeSingle()
  if (aErr) return NextResponse.json({ error: aErr.message }, { status: 500 })
  if (!alias) return NextResponse.json({ error: 'alias not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, alias.business_id)
  if (forbidden) return forbidden

  if (!alias.is_active) {
    return NextResponse.json({ error: 'alias is inactive — reactivate before repointing' }, { status: 400 })
  }

  // Verify the target product exists AND is in the same business.
  // Cross-business repointing would corrupt attribution; reject loudly.
  const { data: target, error: tErr } = await db
    .from('products')
    .select('id, business_id, name')
    .eq('id', newProductId)
    .maybeSingle()
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 })
  if (!target) return NextResponse.json({ error: 'target product not found' }, { status: 404 })
  if (target.business_id !== alias.business_id) {
    return NextResponse.json({ error: 'target product belongs to a different business' }, { status: 403 })
  }

  // Idempotent: already pointing where we want?
  if (alias.product_id === newProductId) {
    return NextResponse.json({
      ok: true,
      alias_id:            alias.id,
      previous_product_id: alias.product_id,
      new_product_id:      newProductId,
      no_op:               true,
      dependent_lines_count: null,
    })
  }

  // Count dependent lines for the response so the UI can show "this
  // affected N historical lines" — informational only, not a cascade.
  const { count: depCount } = await db
    .from('supplier_invoice_lines')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', alias.business_id)
    .eq('product_alias_id', alias.id)

  // The single UPDATE — propagation is computational from this point.
  const { error: uErr } = await db
    .from('product_aliases')
    .update({ product_id: newProductId })
    .eq('id', alias.id)
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })

  return NextResponse.json({
    ok: true,
    alias_id:              alias.id,
    previous_product_id:   alias.product_id,
    new_product_id:        newProductId,
    no_op:                 false,
    dependent_lines_count: depCount ?? null,
    propagation:           'live-on-read: dependent cost reads now resolve to the new product on next render',
  }, { headers: { 'Cache-Control': 'no-store' } })
}
