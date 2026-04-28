// app/api/overheads/flags/[id]/decide/route.ts
//
// Records the owner's decision on a single overhead flag.
//
// Body: { decision: 'essential' | 'dismissed' | 'deferred', reason?: string }
//
// "Essential"  → write classification.status='essential', resolve flag as accepted.
// "Dismissed"  → write classification.status='dismissed' (plan-to-cancel),
//                resolve flag as dismissed. Counts toward the savings projection.
// "Deferred"   → don't classify; snooze the flag for 30 days. The detection
//                worker still sees the supplier next period, but a periodic
//                sweep (PR 5) re-surfaces deferred flags after defer_until.
//
// Idempotent — re-deciding the same flag overwrites the classification +
// updates the flag. Owner changing their mind is normal.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const DEFER_DAYS = 30

const DECISION_TO_RESOLUTION: Record<string, string> = {
  essential: 'accepted',
  dismissed: 'dismissed',
  deferred:  'deferred',
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { id: flagId } = params
  if (!flagId) return NextResponse.json({ error: 'flag id required' }, { status: 400 })

  let body: any = {}
  try { body = await req.json() } catch {}

  const decision = String(body?.decision ?? '').toLowerCase()
  const reason   = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 1000) : null

  if (!DECISION_TO_RESOLUTION[decision]) {
    return NextResponse.json({ error: 'decision must be one of: essential, dismissed, deferred' }, { status: 400 })
  }

  const db = createAdminClient()

  // Load the flag, verify scope.
  const { data: flag, error: lErr } = await db
    .from('overhead_flags')
    .select('id, org_id, business_id, supplier_name, supplier_name_normalised, amount_sek, prior_avg_sek')
    .eq('id', flagId)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (lErr)  return NextResponse.json({ error: lErr.message }, { status: 500 })
  if (!flag) return NextResponse.json({ error: 'flag not found in your org' }, { status: 404 })

  // ── Classification side ─────────────────────────────────────────────────
  // 'deferred' doesn't write a classification — we want the next period to
  // re-flag if the supplier is still in the books.
  if (decision !== 'deferred') {
    // Baseline = current period's amount (the snapshot used for the >15%
    // re-flag rule). Falls back to prior average if the line was unusually
    // high this month — but defaulting to current is the safer "mark as
    // current cost" semantic the owner expects.
    const baseline = Number(flag.amount_sek)
    const status   = decision  // 'essential' or 'dismissed'

    // Upsert by (business_id, supplier_name_normalised). If a row already
    // exists (e.g. owner changed essential → dismissed), update it.
    const { error: cErr } = await db.from('overhead_classifications').upsert({
      org_id:                   flag.org_id,
      business_id:              flag.business_id,
      supplier_name:            flag.supplier_name,
      supplier_name_normalised: flag.supplier_name_normalised,
      status,
      decided_by:               auth.userId,
      decided_at:               new Date().toISOString(),
      reason,
      baseline_avg_sek:         baseline,
      baseline_set_at:          new Date().toISOString(),
      backfill:                 false,
    }, {
      onConflict: 'business_id,supplier_name_normalised',
    })
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 })
  }

  // ── Flag side ───────────────────────────────────────────────────────────
  // 'essential' / 'dismissed' decisions are supplier-wide (the classification
  // applies to all periods), so bulk-resolve every pending flag for this
  // supplier in this business — not just the one the user clicked. Without
  // this, a supplier flagged across 5 months would leave 4 stale rows in the
  // queue after the owner already made the call.
  // 'deferred' is per-flag (snooze this specific instance only).
  const update: Record<string, any> = {
    resolution_status: DECISION_TO_RESOLUTION[decision],
    resolved_at:       new Date().toISOString(),
    resolved_by:       auth.userId,
  }
  if (decision === 'deferred') {
    update.defer_until = new Date(Date.now() + DEFER_DAYS * 86_400_000).toISOString()
  } else {
    update.defer_until = null
  }

  let updateQuery = db
    .from('overhead_flags')
    .update(update)
    .eq('org_id', auth.orgId)
    .eq('business_id', flag.business_id)
    .eq('resolution_status', 'pending')

  if (decision === 'deferred') {
    // Only snooze this specific flag.
    updateQuery = updateQuery.eq('id', flagId)
  } else {
    // Bulk-resolve every pending flag for this supplier across all periods.
    updateQuery = updateQuery.eq('supplier_name_normalised', flag.supplier_name_normalised)
  }

  const { data: updatedRows, error: fErr } = await updateQuery
    .select('id, supplier_name, flag_type, amount_sek, period_year, period_month, resolution_status, resolved_at, defer_until')
  if (fErr) return NextResponse.json({ error: fErr.message }, { status: 500 })

  return NextResponse.json({
    flags_resolved: (updatedRows ?? []).length,
    flag: (updatedRows ?? []).find((r: any) => r.id === flagId) ?? null,
    bulk_supplier:  decision !== 'deferred' ? flag.supplier_name : null,
  })
}
