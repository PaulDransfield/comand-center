// @ts-nocheck
// app/api/admin/route.ts
// Admin API — protected by ADMIN_SECRET header
// All actions are logged to admin_log table

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'
import { checkAdminSecret } from '@/lib/admin/check-secret'

function checkAuth(req: NextRequest): boolean {
  return checkAdminSecret(req)
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const action = searchParams.get('action') ?? 'dashboard'
  const orgId  = searchParams.get('org_id')
  const db     = createAdminClient()

  if (action === 'dashboard') {
    // Overview stats
    const [orgs, users, integrations, alerts, invoices] = await Promise.all([
      db.from('organisations').select('id, name, is_active, created_at, billing_email').order('created_at', { ascending: false }),
      db.from('organisation_members').select('org_id, user_id, role'),
      db.from('integrations').select('org_id, provider, status, last_sync_at, last_error'),
      db.from('anomaly_alerts').select('org_id, severity, is_read, created_at').eq('is_dismissed', false).order('created_at', { ascending: false }).limit(20),
      db.from('invoices').select('org_id, status, amount, created_at').order('created_at', { ascending: false }).limit(20),
    ])

    return NextResponse.json({
      stats: {
        total_orgs:         orgs.data?.length ?? 0,
        active_orgs:        orgs.data?.filter((o: any) => o.is_active).length ?? 0,
        total_users:        users.data?.length ?? 0,
        connected_fortnox:  integrations.data?.filter((i: any) => i.provider === 'fortnox' && i.status === 'connected').length ?? 0,
        unread_alerts:      alerts.data?.filter((a: any) => !a.is_read).length ?? 0,
        critical_alerts:    alerts.data?.filter((a: any) => a.severity === 'critical').length ?? 0,
      },
      orgs:        orgs.data ?? [],
      recent_alerts: alerts.data ?? [],
      recent_invoices: invoices.data ?? [],
      integrations: integrations.data ?? [],
    })
  }

  if (action === 'org' && orgId) {
    // Full org detail
    const [org, members, bizs, integs, trackerData, alerts, invoices, notes] = await Promise.all([
      db.from('organisations').select('*').eq('id', orgId).single(),
      db.from('organisation_members').select('user_id, role, created_at'),
      db.from('businesses').select('*').eq('org_id', orgId),
      db.from('integrations').select('*').eq('org_id', orgId),
      db.from('tracker_data').select('period_year, period_month, revenue, net_profit, margin_pct').eq('org_id', orgId).order('period_year', { ascending: false }).order('period_month', { ascending: false }).limit(12),
      db.from('anomaly_alerts').select('*').eq('org_id', orgId).order('created_at', { ascending: false }).limit(10),
      db.from('invoices').select('*').eq('org_id', orgId).order('created_at', { ascending: false }).limit(10),
      db.from('support_notes').select('*').eq('org_id', orgId).order('created_at', { ascending: false }),
    ])

    // Get user emails from auth
    const userIds = members.data?.map((m: any) => m.user_id) ?? []
    const authUsers: any[] = []
    for (const uid of userIds) {
      const { data } = await db.auth.admin.getUserById(uid)
      if (data?.user) authUsers.push({ id: uid, email: data.user.email, last_sign_in: data.user.last_sign_in_at })
    }

    return NextResponse.json({
      org:           org.data,
      members:       members.data?.map((m: any) => ({ ...m, ...authUsers.find(u => u.id === m.user_id) })) ?? [],
      businesses:    bizs.data ?? [],
      integrations:  integs.data ?? [],
      tracker_data:  trackerData.data ?? [],
      alerts:        alerts.data ?? [],
      invoices:      invoices.data ?? [],
      support_notes: notes.data ?? [],
    })
  }

  if (action === 'logs') {
    const { data } = await db.from('admin_log').select('*').order('created_at', { ascending: false }).limit(50)
    return NextResponse.json(data ?? [])
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body        = await req.json()
  const { action, org_id, admin_email = 'admin', ...params } = body
  const db          = createAdminClient()

  // Extend trial
  if (action === 'extend_trial') {
    const days = parseInt(params.days ?? 14)
    const newEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
    await db.from('organisations').update({ trial_end: newEnd }).eq('id', org_id)
    await recordAdminAction(db, { action: ADMIN_ACTIONS.EXTEND_TRIAL, orgId: org_id, targetType: 'org', targetId: org_id, payload: { days, new_end: newEnd }, actor: admin_email, req })
    return NextResponse.json({ ok: true, new_trial_end: newEnd })
  }

  // Toggle org active
  if (action === 'toggle_active') {
    const { data: org } = await db.from('organisations').select('is_active').eq('id', org_id).single()
    const newState = !org.is_active
    await db.from('organisations').update({ is_active: newState }).eq('id', org_id)
    await recordAdminAction(db, { action: ADMIN_ACTIONS.TOGGLE_ACTIVE, orgId: org_id, targetType: 'org', targetId: org_id, payload: { new_state: newState }, actor: admin_email, req })
    return NextResponse.json({ ok: true, is_active: newState })
  }

  // Trigger Fortnox sync for org
  if (action === 'trigger_fortnox_sync') {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL
    const res = await fetch(`${appUrl}/api/integrations/fortnox?action=sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `admin_org_id=${org_id}` },
    })
    await recordAdminAction(db, { action: ADMIN_ACTIONS.INTEGRATION_SYNC, orgId: org_id, targetType: 'integration', payload: { provider: 'fortnox' }, actor: admin_email, req })
    return NextResponse.json({ ok: true })
  }

  // Trigger weekly digest for org
  if (action === 'trigger_digest') {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL
    await fetch(`${appUrl}/api/cron/weekly-digest?secret=${process.env.CRON_SECRET}&org_id=${org_id}`, {
      headers: { 'x-cron-secret': process.env.CRON_SECRET ?? '' }
    })
    await recordAdminAction(db, { action: 'trigger_digest', orgId: org_id, targetType: 'org', targetId: org_id, actor: admin_email, req })
    return NextResponse.json({ ok: true })
  }

  // Trigger anomaly check for org
  if (action === 'trigger_anomaly_check') {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL
    const res = await fetch(`${appUrl}/api/cron/anomaly-check?secret=${process.env.CRON_SECRET}&org_id=${org_id}`)
    const data = await res.json()
    await recordAdminAction(db, { action: 'trigger_anomaly_check', orgId: org_id, targetType: 'org', targetId: org_id, payload: data, actor: admin_email, req })
    return NextResponse.json({ ok: true, ...data })
  }

  // Add support note
  if (action === 'add_note') {
    await db.from('support_notes').insert({ org_id, note: params.note, author: admin_email })
    await recordAdminAction(db, { action: ADMIN_ACTIONS.NOTE_ADD, orgId: org_id, targetType: 'org', targetId: org_id, payload: { length: (params.note ?? '').length }, actor: admin_email, req })
    return NextResponse.json({ ok: true })
  }

  // Set feature flag
  if (action === 'set_feature_flag') {
    await db.from('feature_flags').upsert(
      { org_id, flag: params.flag, enabled: params.enabled, notes: params.notes, set_by: admin_email },
      { onConflict: 'org_id,flag' }
    )
    await recordAdminAction(db, { action: 'set_feature_flag', orgId: org_id, targetType: 'org', targetId: org_id, payload: { flag: params.flag, enabled: params.enabled }, actor: admin_email, req })
    return NextResponse.json({ ok: true })
  }

  // Change org plan
  if (action === 'set_plan') {
    await db.from('organisations').update({ plan: params.plan }).eq('id', org_id)
    await recordAdminAction(db, { action: 'set_plan', orgId: org_id, targetType: 'org', targetId: org_id, payload: { plan: params.plan }, actor: admin_email, req })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
