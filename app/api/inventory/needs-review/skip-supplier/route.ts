// app/api/inventory/needs-review/skip-supplier/route.ts
//
// POST — owner clicks "Skip ALL from this supplier" on the bulk-review
// queue. Does two things in one call:
//
//   1. UPSERT into supplier_classifications so future invoices from this
//      supplier auto-classify as not_inventory at extract time (no more
//      review-queue noise).
//   2. UPDATE every existing needs_review line from this supplier to
//      match_status='not_inventory' so they vanish from the queue right
//      now.
//
// Per-business override — won't affect other tenants. Reversible via
// admin (delete the supplier_classifications row + re-run rematch).
//
// Body: { business_id, supplier_fortnox_number, supplier_name?: string }
// Returns: { ok, lines_skipped, classification_id }

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
  const businessId   = String(body.business_id ?? '').trim()
  const supplierNum  = String(body.supplier_fortnox_number ?? '').trim()
  const supplierName = body.supplier_name ? String(body.supplier_name).trim() : null
  if (!businessId)  return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!supplierNum) return NextResponse.json({ error: 'supplier_fortnox_number required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // 1. Persist the override (SELECT-then-INSERT-or-UPDATE — partial
  //    unique index avoidance same as the matcher; here we have a real
  //    full unique index on (business_id, supplier_fortnox_number) so
  //    upsert WOULD work, but use the safer pattern for consistency).
  const { data: existing } = await db
    .from('supplier_classifications')
    .select('id')
    .eq('business_id', businessId)
    .eq('supplier_fortnox_number', supplierNum)
    .maybeSingle()

  let classificationId: string
  if (existing?.id) {
    const { error } = await db
      .from('supplier_classifications')
      .update({
        classification:        'not_inventory',
        supplier_name_snapshot: supplierName ?? undefined,
        classified_at:         new Date().toISOString(),
        classified_by:         (auth as any).user?.id ?? null,
      })
      .eq('id', existing.id)
    if (error) return NextResponse.json({ error: `classification update failed: ${error.message}` }, { status: 500 })
    classificationId = existing.id
  } else {
    const { data, error } = await db
      .from('supplier_classifications')
      .insert({
        business_id:            businessId,
        supplier_fortnox_number: supplierNum,
        supplier_name_snapshot:  supplierName,
        classification:         'not_inventory',
        classified_by:          (auth as any).user?.id ?? null,
      })
      .select('id')
      .single()
    if (error) return NextResponse.json({ error: `classification insert failed: ${error.message}` }, { status: 500 })
    classificationId = data.id
  }

  // 2. Bulk-flip every existing needs_review line from this supplier.
  //    Paginate updates the same way the approve flow does in case a
  //    big supplier has 1000+ lines.
  let totalSkipped = 0
  while (true) {
    const { data: batch, error: selErr } = await db
      .from('supplier_invoice_lines')
      .select('id')
      .eq('business_id', businessId)
      .eq('supplier_fortnox_number', supplierNum)
      .eq('match_status', 'needs_review')
      .limit(500)
    if (selErr) {
      return NextResponse.json({
        ok: false, classification_id: classificationId,
        lines_skipped: totalSkipped,
        error: `select failed: ${selErr.message}`,
      }, { status: 500 })
    }
    if (!batch || batch.length === 0) break
    const ids = batch.map((b: any) => b.id)
    const { data: updated, error: upErr } = await db
      .from('supplier_invoice_lines')
      .update({ match_status: 'not_inventory' })
      .in('id', ids)
      .select('id')
    if (upErr) {
      return NextResponse.json({
        ok: false, classification_id: classificationId,
        lines_skipped: totalSkipped,
        error: `update failed: ${upErr.message}`,
      }, { status: 500 })
    }
    totalSkipped += updated?.length ?? 0
    if (batch.length < 500) break
  }

  return NextResponse.json({
    ok: true,
    classification_id: classificationId,
    lines_skipped:     totalSkipped,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
