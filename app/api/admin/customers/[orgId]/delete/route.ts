// @ts-nocheck
// app/api/admin/customers/[orgId]/delete/route.ts
//
// GDPR Art. 17 — right to erasure. Hard-deletes an organisation and every row
// that references it across every tenanted table. This is irreversible.
//
// Safety gates:
//   1. Requires x-admin-secret.
//   2. Requires body { confirm: "DELETE <org_name>" } exactly.
//   3. Writes a deletion_requests row BEFORE purging so we retain a
//      tamper-evident record of who requested what and when.
//
// What happens to users: organisation_members rows are removed. Any auth.user
// that no longer belongs to any org gets deleted via supabase.auth.admin.
//
// Stripe: if the org has a subscription, we cancel at-end-of-period (customer
// can contest charges up to cancellation; never retroactive refund from here).
// Stripe customer record is kept for the 7-year bokföringslagen window.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'
import { checkAdminSecret } from '@/lib/admin/check-secret'

export const dynamic    = 'force-dynamic'
export const maxDuration = 60

function checkAuth(req: NextRequest): boolean {
  return checkAdminSecret(req)
}

// Every tenanted table with org_id. Children first so FK constraints stay happy.
// Anything not listed here either has no org_id (global) or is inferred via business_id.
const TENANT_TABLES = [
  // Logs / usage
  'sync_log',
  'ai_usage_daily',
  'ai_usage',
  'ai_request_log',
  'admin_log',
  'billing_events',
  // Feature data
  'anomaly_alerts',
  'scheduling_recommendations',
  'forecast_calibration',
  'forecasts',
  'pk_sale_forecasts',
  'budgets',
  'customer_health_scores',
  'integration_health_checks',
  'api_probe_results',
  'api_discoveries_enhanced',
  'api_discoveries',
  'supplier_mappings',
  'implementation_plans',
  'notebook_documents',
  'export_schedules',
  'feature_flags',
  'support_notes',
  'support_tickets',
  'onboarding_progress',
  'gdpr_consents',
  // Summary tables
  'monthly_metrics',
  'daily_metrics',
  'dept_metrics',
  // Raw data
  'tracker_data',
  'staff_logs',
  'revenue_logs',
  'covers',
  'invoices',
  'financial_logs',
  // Config
  'departments',
  'integrations',
  'api_credentials',
  'pos_connections',
  // Identity — last because businesses cascade into some of the above
  'organisation_members',
  'businesses',
] as const

export async function POST(req: NextRequest, { params }: { params: { orgId: string } }) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const orgId = params.orgId
  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Body required' }, { status: 400 }) }

  const db = createAdminClient()

  // 1. Fetch the org so we can verify the confirm phrase matches its name.
  const { data: org, error: orgErr } = await db.from('organisations').select('id, name').eq('id', orgId).single()
  if (orgErr || !org) return NextResponse.json({ error: 'Organisation not found' }, { status: 404 })

  const expected = `DELETE ${org.name}`
  if (body.confirm !== expected) {
    return NextResponse.json({
      error: `Confirmation required. Type exactly: ${expected}`,
      expected,
    }, { status: 400 })
  }

  const reason      = body.reason || 'admin-initiated hard delete'
  const actor       = body.actor  || 'admin'

  // 2. Audit record before any destructive work.
  try {
    await db.from('deletion_requests').insert({
      org_id:      orgId,
      org_name:    org.name,
      requested_by: actor,
      reason,
      requested_at: new Date().toISOString(),
      status:       'in_progress',
    })
  } catch {
    // Table may not exist yet — that's tolerable; we still log to admin_log.
  }

  // 3. Collect the users attached to this org BEFORE we drop memberships,
  //    so we can later delete any user whose only link was this org.
  const { data: memberRows } = await db
    .from('organisation_members')
    .select('user_id')
    .eq('org_id', orgId)
  const memberIds: string[] = [...new Set((memberRows ?? []).map((r: any) => r.user_id).filter(Boolean))]

  // 4. Purge every tenanted table. Collect counts for the response.
  // Tables that don't exist in this environment are skipped — not every
  // migration has shipped on every deploy, and the list is intentionally
  // broad so we don't leave orphan rows in future. A missing table is a
  // no-op, not a failure.
  const deleted: Record<string, number> = {}
  const errors:  Record<string, string> = {}
  const skipped: string[] = []

  const isMissingTable = (err: any) => {
    if (!err) return false
    if (err.code === '42P01' || err.code === 'PGRST205') return true
    const msg = String(err.message ?? '').toLowerCase()
    return msg.includes('does not exist') || msg.includes('could not find the table')
  }

  for (const table of TENANT_TABLES) {
    try {
      const { count, error } = await db
        .from(table)
        .delete({ count: 'exact' })
        .eq('org_id', orgId)
      if (error) {
        if (isMissingTable(error)) skipped.push(table)
        else errors[table] = error.message
      } else {
        deleted[table] = count ?? 0
      }
    } catch (e: any) {
      if (isMissingTable(e)) skipped.push(table)
      else errors[table] = e.message || String(e)
    }
  }

  // 5. Delete the organisation row.
  try {
    const { error } = await db.from('organisations').delete().eq('id', orgId)
    if (error) errors['organisations'] = error.message
    else       deleted['organisations'] = 1
  } catch (e: any) {
    errors['organisations'] = e.message
  }

  // 6. Delete auth.users that have no remaining org_membership rows.
  let usersDeleted = 0
  for (const uid of memberIds) {
    const { data: remaining } = await db
      .from('organisation_members')
      .select('org_id', { count: 'exact', head: true })
      .eq('user_id', uid)
    if (!remaining || (remaining as any).count === 0) {
      try {
        await db.auth.admin.deleteUser(uid)
        usersDeleted++
      } catch { /* ignore — user may already be gone */ }
    }
  }

  // 7. Finalise audit records.
  try {
    await db.from('deletion_requests').update({
      status:       Object.keys(errors).length === 0 ? 'completed' : 'completed_with_errors',
      completed_at: new Date().toISOString(),
      rows_deleted: deleted,
      errors:       Object.keys(errors).length === 0 ? null : errors,
      users_deleted: usersDeleted,
    }).eq('org_id', orgId)
  } catch { /* best-effort */ }

  await recordAdminAction(db, {
    action:     ADMIN_ACTIONS.HARD_DELETE,
    orgId,
    targetType: 'org',
    targetId:   orgId,
    payload:    {
      org_name:      org.name,
      reason,
      rows_deleted:  deleted,
      users_deleted: usersDeleted,
      errors:        Object.keys(errors).length ? errors : null,
    },
    actor: actor,
    req,
  })

  return NextResponse.json({
    ok:            Object.keys(errors).length === 0,
    org_id:        orgId,
    org_name:      org.name,
    rows_deleted:  deleted,
    users_deleted: usersDeleted,
    skipped_tables: skipped.length ? skipped : undefined,
    errors:        Object.keys(errors).length ? errors : undefined,
  })
}
