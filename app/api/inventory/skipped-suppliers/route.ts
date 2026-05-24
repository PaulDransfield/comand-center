// app/api/inventory/skipped-suppliers/route.ts
//
// GET — list every supplier the owner has explicitly marked as
//       not-inventory for this business. Each row includes the count of
//       lines that are sitting as not_inventory because of this rule,
//       so the owner can see what "Restore" would unhide.

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
  const businessId = String(url.searchParams.get('business_id') ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  const { data: classifications, error } = await db
    .from('supplier_classifications')
    .select('id, supplier_fortnox_number, supplier_name_snapshot, classification, classified_at')
    .eq('business_id', businessId)
    .order('classified_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Count not_inventory lines per supplier so the UI shows what would
  // come back if you remove the rule. Single batched aggregate.
  const supplierNums = (classifications ?? []).map((c: any) => c.supplier_fortnox_number)
  const counts: Record<string, number> = {}
  if (supplierNums.length > 0) {
    const { data: lines } = await db
      .from('supplier_invoice_lines')
      .select('supplier_fortnox_number')
      .eq('business_id', businessId)
      .eq('match_status', 'not_inventory')
      .in('supplier_fortnox_number', supplierNums)
    for (const l of lines ?? []) {
      const k = (l as any).supplier_fortnox_number
      counts[k] = (counts[k] ?? 0) + 1
    }
  }

  const out = (classifications ?? []).map((c: any) => ({
    id:                      c.id,
    supplier_fortnox_number: c.supplier_fortnox_number,
    supplier_name:           c.supplier_name_snapshot,
    classification:          c.classification,
    classified_at:           c.classified_at,
    line_count:              counts[c.supplier_fortnox_number] ?? 0,
  }))

  return NextResponse.json({
    classifications: out,
    total:           out.length,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
