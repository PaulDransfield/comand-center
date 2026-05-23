// app/api/inventory/needs-review/approve/undo/route.ts
//
// POST — owner clicked Undo on a card they just approved. Reverses:
//   1. UPDATE every line where product_alias_id = alias_id back to
//      match_status='needs_review', product_alias_id=null.
//   2. DELETE FROM product_aliases WHERE id = alias_id.
//   3. DELETE FROM products WHERE id = product_id  (only if no other
//      aliases still reference it).
//
// Body: { business_id, product_id, alias_id }
// Returns: { ok, lines_reverted, product_deleted }
//
// Safety: only un-links lines pointing at THIS alias_id. If the matcher
// later auto-linked other lines to the same product via fuzzy match
// (steps 3+4), those stay matched — they have a different alias_id. The
// product itself is only deleted when no aliases remain, so undo is
// safe at any point after approve.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  const productId  = String(body.product_id  ?? '').trim()
  const aliasId    = String(body.alias_id    ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!productId)  return NextResponse.json({ error: 'product_id required' },  { status: 400 })
  if (!aliasId)    return NextResponse.json({ error: 'alias_id required' },    { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // Verify the product belongs to this business (defence against
  // cross-tenant tampering even though requireBusinessAccess + RLS
  // already cover it).
  const { data: prod, error: pErr } = await db
    .from('products')
    .select('id, business_id')
    .eq('id', productId)
    .maybeSingle()
  if (pErr)     return NextResponse.json({ error: pErr.message }, { status: 500 })
  if (!prod)    return NextResponse.json({ error: 'product not found' }, { status: 404 })
  if (prod.business_id !== businessId) {
    return NextResponse.json({ error: 'product belongs to a different business' }, { status: 403 })
  }

  // 1. Revert lines: clear alias link + flip back to needs_review.
  //    Pulls in batches of 500 to stay under the .in() row cap.
  let reverted = 0
  while (true) {
    const { data: batch, error: selErr } = await db
      .from('supplier_invoice_lines')
      .select('id')
      .eq('business_id', businessId)
      .eq('product_alias_id', aliasId)
      .limit(500)
    if (selErr) return NextResponse.json({ error: `select failed: ${selErr.message}` }, { status: 500 })
    if (!batch || batch.length === 0) break
    const ids = batch.map((b: any) => b.id)
    const { data: upd, error: upErr } = await db
      .from('supplier_invoice_lines')
      .update({ match_status: 'needs_review', product_alias_id: null })
      .in('id', ids)
      .select('id')
    if (upErr) return NextResponse.json({
      ok: false, lines_reverted: reverted, error: `update failed: ${upErr.message}`,
    }, { status: 500 })
    reverted += upd?.length ?? 0
    if (batch.length < 500) break
  }

  // 2. Delete the alias.
  const { error: aErr } = await db
    .from('product_aliases')
    .delete()
    .eq('id', aliasId)
  if (aErr) return NextResponse.json({
    ok: false, lines_reverted: reverted, error: `alias delete failed: ${aErr.message}`,
  }, { status: 500 })

  // 3. Delete the product IF no other aliases reference it. The matcher
  //    may have created sibling aliases via fuzzy auto-match later —
  //    those should keep working.
  const { count: siblingCount } = await db
    .from('product_aliases')
    .select('id', { count: 'exact', head: true })
    .eq('product_id', productId)
  let productDeleted = false
  if ((siblingCount ?? 0) === 0) {
    const { error: prErr } = await db
      .from('products')
      .delete()
      .eq('id', productId)
    if (prErr) return NextResponse.json({
      ok: false, lines_reverted: reverted, error: `product delete failed: ${prErr.message}`,
    }, { status: 500 })
    productDeleted = true
  }

  return NextResponse.json({
    ok: true,
    lines_reverted: reverted,
    product_deleted: productDeleted,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
