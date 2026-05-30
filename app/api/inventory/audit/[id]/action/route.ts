// app/api/inventory/audit/[id]/action/route.ts
//
// POST — owner reviews a queue item. Decision: confirm | correct | skip.
//
// Body: { decision: 'confirm' | 'correct' | 'skip', notes?: string }
//
// On `confirm`:
//   - Marks the queue row reviewed (reviewer_decision='confirm', reviewer_user_id, reviewed_at)
//   - Writes an inventory_review_outcomes row with context='audit_sample',
//     agreed=true (the AI's auto-link was correct).
//
// On `correct`:
//   - Marks the queue row reviewed (reviewer_decision='correct').
//   - Calls product_aliases_record_correction(p_threshold=1) — audit-time
//     correction is enough to demote because the auditor is explicitly
//     reviewing. (DEMOTION_THRESHOLD_AUDIT in lib/inventory/demotion.ts)
//   - Writes an inventory_review_outcomes row with context='audit_sample',
//     agreed=false.
//   - Flips any lines linked to the demoted alias back to needs_review.
//
// On `skip`:
//   - Marks the queue row reviewed (reviewer_decision='skip').
//   - No outcome row written (auditor deferred without a positive or
//     negative signal).
//
// Returns: { ok, queue_id, decision, alias_demoted_now, lines_reverted }
//
// LEARNING-LOOP-PHASE1-PLAN.md §3.3.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { DEMOTION_THRESHOLD_AUDIT } from '@/lib/inventory/demotion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VALID_DECISIONS = ['confirm', 'correct', 'skip'] as const
type Decision = typeof VALID_DECISIONS[number]

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const decision = body.decision as Decision
  if (!VALID_DECISIONS.includes(decision)) {
    return NextResponse.json({ error: `decision must be one of: ${VALID_DECISIONS.join(', ')}` }, { status: 400 })
  }

  const db = createAdminClient()

  // Load the queue item + its alias
  const { data: item, error: itemErr } = await db
    .from('inventory_audit_queue')
    .select('id, org_id, business_id, alias_id, reviewed_at, reason, alias_match_method, alias_match_confidence')
    .eq('id', params.id)
    .maybeSingle()
  if (itemErr) return NextResponse.json({ error: itemErr.message }, { status: 500 })
  if (!item)   return NextResponse.json({ error: 'queue item not found' }, { status: 404 })

  const forbidden = requireBusinessAccess(auth, item.business_id)
  if (forbidden) return forbidden

  if (item.reviewed_at) {
    return NextResponse.json({ error: 'queue item already reviewed', reviewed_at: item.reviewed_at }, { status: 409 })
  }

  let aliasDemotedNow = false
  let linesReverted   = 0

  // Decision-specific side effects
  if (decision === 'correct') {
    // 1. Demote the alias via the audit threshold (1 correction = deactivate)
    const { data: demoted, error: rpcErr } = await db.rpc('product_aliases_record_correction', {
      p_alias_id:  item.alias_id,
      p_threshold: DEMOTION_THRESHOLD_AUDIT,
    })
    if (rpcErr) return NextResponse.json({ error: `record_correction RPC: ${rpcErr.message}` }, { status: 500 })
    aliasDemotedNow = demoted === true

    // 2. Flip every matched line that links to this alias back to needs_review
    const { data: revertedLines, error: lErr } = await db
      .from('supplier_invoice_lines')
      .update({ match_status: 'needs_review', product_alias_id: null })
      .eq('product_alias_id', item.alias_id)
      .eq('match_status', 'matched')
      .select('id')
    if (lErr) return NextResponse.json({ error: `line revert: ${lErr.message}` }, { status: 500 })
    linesReverted = revertedLines?.length ?? 0
  }

  // Write the outcome row (confirm + correct only; skip writes nothing)
  if (decision !== 'skip') {
    const outcome = {
      org_id:        item.org_id,
      business_id:   item.business_id,
      group_key:     `audit:${item.id}`,           // synthetic group key — audit outcomes don't share groups with needs_review outcomes
      ai_action:     'approve_existing',           // the matcher's original auto-link was an implicit "approve_existing" decision
      ai_confidence: item.alias_match_confidence,
      ai_product_id: null,                          // would require a join to look up; the alias_id is the cleaner reference
      ai_suggested_name: null,
      owner_action:   decision === 'confirm' ? 'approve_existing' : 'approve_other',
      owner_product_id: null,
      owner_chosen_name: null,
      agreed:         decision === 'confirm',
      context:        'audit_sample',
    }
    const { error: oErr } = await db.from('inventory_review_outcomes').insert(outcome)
    if (oErr) {
      // Don't fail the request on outcome write — the demotion already happened.
      console.error('[audit-action] outcome insert failed:', oErr.message)
    }
  }

  // Mark queue item reviewed
  const { error: upErr } = await db
    .from('inventory_audit_queue')
    .update({
      reviewed_at:       new Date().toISOString(),
      reviewer_decision: decision,
      reviewer_user_id:  auth.userId,
    })
    .eq('id', item.id)
  if (upErr) return NextResponse.json({ error: `queue update: ${upErr.message}` }, { status: 500 })

  return NextResponse.json({
    ok: true,
    queue_id: item.id,
    decision,
    alias_demoted_now: aliasDemotedNow,
    lines_reverted: linesReverted,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
