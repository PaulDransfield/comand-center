// app/api/inventory/skipped-suppliers/[id]/route.ts
//
// DELETE — remove the supplier_classifications row AND flip every
//          not_inventory line from that supplier back to needs_review.
//          Mirror of the skip-supplier endpoint.
//
// Returns: { ok, lines_restored }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: rule, error: rErr } = await db
    .from('supplier_classifications')
    .select('id, business_id, supplier_fortnox_number')
    .eq('id', params.id)
    .maybeSingle()
  if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 })
  if (!rule) return NextResponse.json({ error: 'classification not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, rule.business_id)
  if (forbidden) return forbidden

  // Flip lines back to needs_review BEFORE deleting the rule, in case
  // anything races on the FK lookup. Order matters: rule still exists
  // when lines flip, so the matcher won't pick them up as not_inventory.
  let restored = 0
  while (true) {
    const { data: batch } = await db
      .from('supplier_invoice_lines')
      .select('id')
      .eq('business_id', rule.business_id)
      .eq('supplier_fortnox_number', rule.supplier_fortnox_number)
      .eq('match_status', 'not_inventory')
      .limit(500)
    if (!batch || batch.length === 0) break
    const ids = batch.map((b: any) => b.id)
    const { data: upd, error: uErr } = await db
      .from('supplier_invoice_lines')
      .update({ match_status: 'needs_review' })
      .in('id', ids)
      .select('id')
    if (uErr) return NextResponse.json({ ok: false, lines_restored: restored, error: uErr.message }, { status: 500 })
    restored += upd?.length ?? 0
    if (batch.length < 500) break
  }

  const { error: dErr } = await db
    .from('supplier_classifications')
    .delete()
    .eq('id', params.id)
  if (dErr) return NextResponse.json({ ok: false, lines_restored: restored, error: dErr.message }, { status: 500 })

  return NextResponse.json({
    ok: true,
    lines_restored: restored,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
