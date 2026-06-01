// app/api/inventory/product-aliases/[id]/deactivate/route.ts
//
// POST — set an alias is_active=false. The matcher's gates filter
// is_active=TRUE, so the disconnected alias is skipped on future invoice
// ingest. Existing supplier_invoice_lines that linked through this alias
// still reference it for historical traceability (deactivation does NOT
// orphan history).
//
// Propagation: same as repoint — purely live-on-read. After deactivation:
//   - getProductLatestPrices(product) no longer picks this alias up
//     (filters is_active=TRUE), so the product's price reads from other
//     active aliases (if any).
//   - Historical supplier_invoice_lines still reference this alias for
//     audit; their match_status stays 'matched'.
//
// Body: { reason?: string }  — optional, stored on the row
// Returns: { ok, alias_id, dependent_lines_count }
//
// Idempotent: deactivating an already-inactive alias is a no-op.

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
  const reason = body.reason ? String(body.reason).trim().slice(0, 200) : 'owner_disconnected'

  const db = createAdminClient()

  const { data: alias, error: aErr } = await db
    .from('product_aliases')
    .select('id, business_id, product_id, is_active')
    .eq('id', params.id)
    .maybeSingle()
  if (aErr) return NextResponse.json({ error: aErr.message }, { status: 500 })
  if (!alias) return NextResponse.json({ error: 'alias not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, alias.business_id)
  if (forbidden) return forbidden

  if (!alias.is_active) {
    return NextResponse.json({
      ok: true, alias_id: alias.id, no_op: true, dependent_lines_count: null,
    })
  }

  const { count: depCount } = await db
    .from('supplier_invoice_lines')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', alias.business_id)
    .eq('product_alias_id', alias.id)

  const { error: uErr } = await db
    .from('product_aliases')
    .update({
      is_active:          false,
      deactivated_at:     new Date().toISOString(),
      deactivated_reason: reason,
    })
    .eq('id', alias.id)
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })

  return NextResponse.json({
    ok: true,
    alias_id:              alias.id,
    no_op:                 false,
    dependent_lines_count: depCount ?? null,
    propagation:           'live-on-read: this alias is excluded from future cost reads; historical lines remain matched for audit',
  }, { headers: { 'Cache-Control': 'no-store' } })
}
