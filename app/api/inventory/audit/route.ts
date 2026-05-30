// app/api/inventory/audit/route.ts
//
// GET — list pending audit-queue items for a business, ordered by
// risk_score DESC. Used by /inventory/audit page.
//
// Query: ?business_id=<uuid>&include_reviewed=0|1&limit=N
// Returns: { ok, items: [...] }
//
// LEARNING-LOOP-PHASE1-PLAN.md D2 §3.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const businessId = url.searchParams.get('business_id')?.trim() ?? ''
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const includeReviewed = url.searchParams.get('include_reviewed') === '1'
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '50')))

  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  let q = db
    .from('inventory_audit_queue')
    .select(`
      id, business_id, alias_id, line_id, reason, risk_score,
      alias_match_method, alias_match_confidence, alias_times_demoted,
      sampled_at, reviewed_at, reviewer_decision,
      product_aliases(id, product_id, raw_description, supplier_name_snapshot, is_active,
                      times_demoted, last_demoted_at, corrections_against,
                      products(id, name, category)),
      supplier_invoice_lines(id, raw_description, total_excl_vat, invoice_date,
                             fortnox_invoice_number)
    `)
    .eq('business_id', businessId)
    .order('risk_score', { ascending: false, nullsFirst: false })
    .order('sampled_at', { ascending: false })
    .limit(limit)
  if (!includeReviewed) q = q.is('reviewed_at', null)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // pending_count: cheap dedicated COUNT so the /inventory/review banner
  // can show "N to spot-check" without a second roundtrip. Always reports
  // the unreviewed total regardless of include_reviewed.
  const { count: pendingCount } = await db
    .from('inventory_audit_queue')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .is('reviewed_at', null)

  return NextResponse.json(
    { ok: true, items: data ?? [], pending_count: pendingCount ?? 0 },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
