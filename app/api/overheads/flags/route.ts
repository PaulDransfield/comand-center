// app/api/overheads/flags/route.ts
//
// Lists pending overhead-review flags for a business. PR 1 of the overhead
// review feature — schema-only PR, so this endpoint just reads (no detection
// runs yet). Once PR 2 ships the worker, the same endpoint surfaces real
// data without a UI change.
//
// Filters:
//   business_id (required)
//   include_resolved=1 (optional) — include accepted/dismissed/deferred
//
// Response shape is the same the UI will consume across the rest of the
// feature, so PR 3 (UI) doesn't need to refit.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { expireDeferredFlags } from '@/lib/overheads/expire-deferred'

export const dynamic = 'force-dynamic'

const isMissingTable = (err: any): boolean => {
  if (!err) return false
  if (err.code === '42P01' || err.code === 'PGRST205') return true
  const msg = String(err.message ?? '').toLowerCase()
  return msg.includes('does not exist') || msg.includes('could not find the table')
}

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const u          = new URL(req.url)
  const businessId = u.searchParams.get('business_id')
  const includeResolved = u.searchParams.get('include_resolved') === '1'

  if (!businessId) {
    return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  }

  const db = createAdminClient()

  // PR 5: revive any deferred flags whose 30-day snooze has expired BEFORE
  // we read so the queue reflects current state. Best-effort.
  await expireDeferredFlags(db, auth.orgId, businessId)

  let q = db
    .from('overhead_flags')
    .select('id, supplier_name, supplier_name_normalised, category, flag_type, reason, amount_sek, prior_avg_sek, period_year, period_month, surfaced_at, resolution_status, resolved_at, resolved_by, defer_until, ai_explanation, ai_confidence')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .order('surfaced_at', { ascending: false })
    .limit(500)

  if (!includeResolved) {
    q = q.eq('resolution_status', 'pending')
  }

  const { data, error } = await q
  if (error) {
    if (isMissingTable(error)) {
      // PR 1 ships before M039 may have applied. Empty + a hint, never 500.
      return NextResponse.json({
        flags: [],
        total_pending: 0,
        total_monthly_savings_sek: 0,
        table_missing: true,
        note: 'overhead_flags table missing — run M039-OVERHEAD-REVIEW.sql in Supabase SQL Editor.',
      }, { headers: { 'Cache-Control': 'no-store' } })
    }
    return NextResponse.json({ error: error.message, code: error.code ?? null }, { status: 500 })
  }

  const flags         = data ?? []
  const pending       = flags.filter(f => f.resolution_status === 'pending')
  const totalSavings  = pending.reduce((s, f) => s + Number(f.amount_sek ?? 0), 0)

  return NextResponse.json({
    flags,
    total_pending: pending.length,
    total_monthly_savings_sek: Math.round(totalSavings),
    table_missing: false,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
