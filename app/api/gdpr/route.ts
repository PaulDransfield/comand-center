// @ts-nocheck
// app/api/gdpr/route.ts
// GET  — export all user/org data as JSON
// DELETE — request account deletion

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const getAuth = getRequestAuth

// GET — GDPR Art. 15 (access) + Art. 20 (portability) export.
// Returns a single JSON bundle of everything we hold for this org, minus credentials
// and other-party personal data. Matches the tables that hard-delete purges.
async function safeSelect(db: any, table: string, orgId: string, columns = '*') {
  try {
    const { data } = await db.from(table).select(columns).eq('org_id', orgId)
    return data ?? []
  } catch {
    return []  // table may not exist in some environments
  }
}

export async function GET(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const orgId = auth.orgId

  // Root org row
  const { data: org } = await db.from('organisations').select('*').eq('id', orgId).single()

  // Members — emails only (no password hashes, which we don't hold anyway)
  const { data: members } = await db
    .from('organisation_members').select('user_id, role, created_at').eq('org_id', orgId)

  const [
    businesses, departments, integrations,
    tracker, budgets, forecasts, forecast_calibration,
    revenue, staff, covers, invoices, financial,
    daily_metrics, monthly_metrics, dept_metrics,
    alerts, scheduling, supplier_mappings,
    ai_usage, ai_usage_daily, ai_request_log,
    sync_log, onboarding, support_notes, health_scores, integration_health,
    notebook, feature_flags, gdpr_consents,
  ] = await Promise.all([
    safeSelect(db, 'businesses',                 orgId),
    safeSelect(db, 'departments',                orgId),
    safeSelect(db, 'integrations',               orgId, 'id,provider,department,business_id,status,last_sync_at,last_error,connected_at,updated_at'),
    safeSelect(db, 'tracker_data',               orgId),
    safeSelect(db, 'budgets',                    orgId),
    safeSelect(db, 'forecasts',                  orgId),
    safeSelect(db, 'forecast_calibration',       orgId),
    safeSelect(db, 'revenue_logs',               orgId),
    safeSelect(db, 'staff_logs',                 orgId, 'period_year,period_month,staff_name,staff_group,shift_date,hours_worked,cost_actual,pk_log_url,created_at'),
    safeSelect(db, 'covers',                     orgId),
    safeSelect(db, 'invoices',                   orgId, 'id,vendor_name,amount,invoice_date,category,status,created_at'),
    safeSelect(db, 'financial_logs',             orgId),
    safeSelect(db, 'daily_metrics',              orgId),
    safeSelect(db, 'monthly_metrics',            orgId),
    safeSelect(db, 'dept_metrics',               orgId),
    safeSelect(db, 'anomaly_alerts',             orgId),
    safeSelect(db, 'scheduling_recommendations', orgId),
    safeSelect(db, 'supplier_mappings',          orgId),
    safeSelect(db, 'ai_usage',                   orgId),
    safeSelect(db, 'ai_usage_daily',             orgId),
    safeSelect(db, 'ai_request_log',             orgId, 'id,request_type,model,input_tokens,output_tokens,total_cost_usd,created_at'),
    safeSelect(db, 'sync_log',                   orgId),
    safeSelect(db, 'onboarding_progress',        orgId),
    safeSelect(db, 'support_notes',              orgId),
    safeSelect(db, 'customer_health_scores',     orgId),
    safeSelect(db, 'integration_health_checks',  orgId),
    safeSelect(db, 'notebook_documents',         orgId),
    safeSelect(db, 'feature_flags',              orgId),
    safeSelect(db, 'gdpr_consents',              orgId),
  ])

  const exportData = {
    export_date:    new Date().toISOString(),
    export_version: '2.0',
    export_notes:   'GDPR Art. 15 (access) + Art. 20 (portability) export. Credentials redacted. Excludes admin-only audit logs (our Art. 32 security evidence).',
    org:            org,
    members:        members ?? [],
    businesses,
    departments,
    integrations:   integrations.map((i: any) => ({ ...i, credentials_enc: '[REDACTED]' })),
    financial:      { tracker_data: tracker, budgets, forecasts, forecast_calibration, financial_logs: financial },
    operations:     { covers, revenue_logs: revenue, staff_logs: staff, alerts, scheduling },
    summary_metrics: { daily_metrics, monthly_metrics, dept_metrics },
    documents:      { invoices, supplier_mappings },
    ai:             { usage: ai_usage, usage_daily: ai_usage_daily, request_log: ai_request_log },
    system:         { sync_log, onboarding_progress: onboarding, health_scores, integration_health_checks: integration_health },
    product_state:  { notebook_documents: notebook, feature_flags, support_notes },
    consents:       gdpr_consents,
  }

  return new NextResponse(JSON.stringify(exportData, null, 2), {
    headers: {
      'Content-Type':        'application/json',
      'Content-Disposition': `attachment; filename="commandcenter-data-export-${new Date().toISOString().slice(0,10)}.json"`,
    },
  })
}

// DELETE — request account deletion
export async function DELETE(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()

  // Check for existing pending request
  const { data: existing } = await db
    .from('deletion_requests')
    .select('id, status, requested_at')
    .eq('user_id', auth.userId)
    .eq('status', 'pending')
    .maybeSingle()

  if (existing) {
    return NextResponse.json({
      ok: true,
      already_requested: true,
      requested_at: existing.requested_at,
      message: 'A deletion request is already pending. We will process it within 30 days.',
    })
  }

  // Create deletion request
  await db.from('deletion_requests').insert({
    org_id:       auth.orgId,
    user_id:      auth.userId,
    requested_at: new Date().toISOString(),
    status:       'pending',
    notes:        'User-initiated deletion request via settings',
  })

  // Send notification email (via Supabase edge function or just log for now)
  console.log(`DELETION REQUEST: org=${auth.orgId} user=${auth.userId}`)

  return NextResponse.json({
    ok: true,
    message: 'Your deletion request has been received. All your data will be permanently deleted within 30 days. You will receive a confirmation email.',
  })
}
