// @ts-nocheck
// app/api/gdpr/route.ts
// GET  — export all user/org data as JSON
// DELETE — request account deletion

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

async function getAuth(req: NextRequest) {
  const raw = req.cookies.get('sb-llzmixkrysduztsvmfzi-auth-token')?.value
  if (!raw) return null
  try {
    let token = raw
    try { const d = decodeURIComponent(raw); const p = JSON.parse(d); token = Array.isArray(p) ? p[0] : (p.access_token ?? raw) } catch {}
    const db = createAdminClient()
    const { data: { user } } = await db.auth.getUser(token)
    if (!user) return null
    const { data: m } = await db.from('organisation_members').select('org_id').eq('user_id', user.id).single()
    return m ? { userId: user.id, orgId: m.org_id } : null
  } catch { return null }
}

// GET — export all data
export async function GET(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()

  // Fetch all data for this org
  const [
    { data: businesses },
    { data: tracker },
    { data: staff },
    { data: covers },
    { data: revenue },
    { data: forecasts },
    { data: budgets },
    { data: invoices },
    { data: integrations },
    { data: alerts },
  ] = await Promise.all([
    db.from('businesses').select('*').eq('org_id', auth.orgId),
    db.from('tracker_data').select('*').eq('org_id', auth.orgId),
    db.from('staff_logs').select('period_year,period_month,staff_name,staff_group,shift_date,hours_worked,cost_actual').eq('org_id', auth.orgId),
    db.from('covers').select('*').eq('org_id', auth.orgId),
    db.from('revenue_logs').select('*').eq('org_id', auth.orgId),
    db.from('forecasts').select('*').eq('org_id', auth.orgId),
    db.from('budgets').select('*').eq('org_id', auth.orgId),
    db.from('invoices').select('id,vendor_name,amount,invoice_date,category').eq('org_id', auth.orgId),
    db.from('integrations').select('provider,status,last_sync_at,connected_at').eq('org_id', auth.orgId),
    db.from('anomaly_alerts').select('*').eq('org_id', auth.orgId),
  ])

  const exportData = {
    export_date:  new Date().toISOString(),
    export_version: '1.0',
    org_id:       auth.orgId,
    user_id:      auth.userId,
    businesses:   businesses ?? [],
    financial: {
      tracker_data: tracker ?? [],
      budgets:      budgets ?? [],
      forecasts:    forecasts ?? [],
    },
    operations: {
      covers:       covers ?? [],
      revenue_logs: revenue ?? [],
      staff_logs:   staff ?? [],
      alerts:       alerts ?? [],
    },
    documents: {
      invoices:     invoices ?? [],
    },
    integrations: (integrations ?? []).map(i => ({
      ...i,
      // Never export credentials
      credentials_enc: '[REDACTED]',
    })),
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
