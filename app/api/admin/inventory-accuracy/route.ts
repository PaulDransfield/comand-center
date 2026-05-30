// app/api/admin/inventory-accuracy/route.ts
//
// GET — read recent inventory_accuracy_snapshots for the admin view.
// Admin-only (gated by ADMIN_SECRET). Owner-facing surfacing is
// deliberately not built per §7.2 of LEARNING-LOOP-PHASE1-PLAN.md.
//
// Query: ?days=N&org_id=<uuid>
//   days     default 90, max 365
//   org_id   optional — if omitted, returns all orgs the service role
//            can see (i.e. everything)
//
// Returns: { ok, snapshots: [...] }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const adminSecret = process.env.ADMIN_SECRET
  const header = req.headers.get('x-admin-secret') ?? ''
  if (!adminSecret || header !== adminSecret) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const url   = new URL(req.url)
  const days  = Math.min(365, Math.max(1, Number(url.searchParams.get('days') ?? '90')))
  const orgId = url.searchParams.get('org_id')?.trim() ?? null

  const db = createAdminClient()
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

  let q = db
    .from('inventory_accuracy_snapshots')
    .select(`
      id, org_id, business_id, snapshot_date, window_days,
      needs_review_outcomes_total, needs_review_outcomes_agreed, needs_review_agreement_pct,
      audit_sample_outcomes_total, audit_sample_outcomes_agreed, audit_sample_agreement_pct,
      audit_sample_confirmations, audit_sample_corrections, audit_sample_precision_pct,
      needs_review_lines_count, total_lines_in_window, needs_review_rate_pct,
      demotions_in_window, active_aliases_window_start, demotion_rate_pct,
      ai_create_new_count, owner_create_new_count, create_new_divergence_pct,
      rebate_noise_count,
      alert_level, alert_reason, baseline_needs_review_pct, delta_vs_baseline_pp,
      computed_at,
      businesses(name),
      organisations(name)
    `)
    .gte('snapshot_date', cutoff)
    .order('snapshot_date', { ascending: false })
    .limit(2000)
  if (orgId) q = q.eq('org_id', orgId)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json(
    { ok: true, snapshots: data ?? [] },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
