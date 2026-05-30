// app/api/inventory/lines/[id]/correct-attribution/route.ts
//
// POST — owner says "this line's matched product is wrong, send it back
// to the review queue and count it as a strike against the alias that
// produced the wrong link".
//
// The line stops being matched; its product_alias_id clears; the alias
// gets a corrections_against++ via the M105 RPC. When corrections cross
// the threshold (2 by default), the RPC deactivates the alias (sets
// is_active=FALSE, deactivated_reason='corrections_threshold'). The
// matcher's Steps 1-2 + trigram RPC all filter is_active=TRUE, so the
// next time a similar line ingests, the demoted alias is skipped and
// the line either falls through to a better alias or to needs_review.
//
// This is THE demotion signal hook from LEARNING-LOOP-PHASE1-PLAN.md
// Deliverable 1.
//
// Auth: line.business_id → requireBusinessAccess
// Body: {} (none required — the line's product_alias_id is read from the row)
// Returns: { ok, line_id, alias_id, alias_demoted_now, corrections_against_after }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { DEMOTION_THRESHOLD } from '@/lib/inventory/demotion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()

  // 1. Load the line + verify it's currently matched.
  const { data: line, error: lErr } = await db
    .from('supplier_invoice_lines')
    .select('id, business_id, product_alias_id, match_status')
    .eq('id', params.id)
    .maybeSingle()
  if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 })
  if (!line) return NextResponse.json({ error: 'line not found' }, { status: 404 })

  const forbidden = requireBusinessAccess(auth, line.business_id)
  if (forbidden) return forbidden

  if (line.match_status !== 'matched' || !line.product_alias_id) {
    return NextResponse.json({
      error: 'line is not currently matched — nothing to correct',
      current_status: line.match_status,
    }, { status: 400 })
  }

  const aliasId = line.product_alias_id

  // 2. Record the correction (atomic increment + maybe-deactivate via RPC).
  const { data: demoted, error: rpcErr } = await db.rpc('product_aliases_record_correction', {
    p_alias_id:  aliasId,
    p_threshold: DEMOTION_THRESHOLD,
  })
  if (rpcErr) return NextResponse.json({
    error: `record_correction RPC failed: ${rpcErr.message}`,
  }, { status: 500 })

  // 3. Read the post-state count so the caller knows where the alias stands
  //    (e.g. "1 correction recorded — 1 more triggers demotion").
  const { data: aliasPost } = await db
    .from('product_aliases')
    .select('corrections_against, is_active, deactivated_reason')
    .eq('id', aliasId)
    .maybeSingle()

  // 4. Flip the line back to needs_review + clear the alias link.
  const { error: upErr } = await db
    .from('supplier_invoice_lines')
    .update({
      match_status:     'needs_review',
      product_alias_id: null,
    })
    .eq('id', line.id)
  if (upErr) return NextResponse.json({
    ok: false,
    alias_id: aliasId,
    alias_demoted_now: demoted === true,
    error: `line revert failed: ${upErr.message}`,
  }, { status: 500 })

  return NextResponse.json({
    ok: true,
    line_id: line.id,
    alias_id: aliasId,
    alias_demoted_now: demoted === true,
    corrections_against_after: aliasPost?.corrections_against ?? null,
    alias_is_active_after: aliasPost?.is_active ?? null,
    threshold: DEMOTION_THRESHOLD,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
