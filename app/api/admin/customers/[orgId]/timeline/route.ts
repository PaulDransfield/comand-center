// @ts-nocheck
// app/api/admin/customers/[orgId]/timeline/route.ts
//
// Unified chronological event feed for one customer — no new tables needed,
// just merges rows from existing sources at query time:
//   - organisation.created_at              → signup
//   - onboarding_progress.completed_at     → onboarding completed
//   - onboarding_progress.updated_at when step='setup_requested' → setup request submitted
//   - integrations.created_at              → integration connected
//   - integrations.last_sync_at            → last sync per integration
//   - sync_log (first few)                 → sync runs (successes + failures)
//   - anomaly_alerts.created_at            → AI alerts fired
//   - support_notes.created_at             → internal notes added
//   - admin_log (if schema matches)        → admin actions on this customer
//
// Returns { events: [{ at, type, icon, title, body, color }, ...] } sorted newest first.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

function checkAuth(req: NextRequest): boolean {
  const secret = req.headers.get('x-admin-secret') ?? req.cookies.get('admin_secret')?.value
  return secret === process.env.ADMIN_SECRET
}

export async function GET(req: NextRequest, { params }: { params: { orgId: string } }) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const orgId = params.orgId
  const db = createAdminClient()

  const events: any[] = []

  const [orgRes, obRes, integsRes, syncLogsRes, alertsRes, notesRes, adminLogsRes] = await Promise.all([
    db.from('organisations').select('created_at, name').eq('id', orgId).maybeSingle(),
    db.from('onboarding_progress').select('*').eq('org_id', orgId).maybeSingle(),
    db.from('integrations').select('id, provider, department, status, created_at, last_sync_at, last_error').eq('org_id', orgId),
    db.from('sync_log').select('provider, status, records_synced, error_msg, created_at, duration_ms').eq('org_id', orgId).order('created_at', { ascending: false }).limit(30),
    db.from('anomaly_alerts').select('severity, title, description, created_at, is_dismissed').eq('org_id', orgId).order('created_at', { ascending: false }).limit(20),
    db.from('support_notes').select('note, author, created_at').eq('org_id', orgId).order('created_at', { ascending: false }),
    db.from('admin_log').select('action, details, created_at, admin_email').eq('target_id', orgId).order('created_at', { ascending: false }).limit(30).then((r: any) => r).catch(() => ({ data: null })),
  ])

  // Signup
  if (orgRes.data) {
    events.push({
      at:    orgRes.data.created_at,
      type:  'signup',
      icon:  '✨',
      color: '#6366f1',
      title: 'Signed up',
      body:  orgRes.data.name ? `Organisation "${orgRes.data.name}" created` : null,
    })
  }

  // Onboarding — completed or setup requested
  if (obRes.data) {
    if (obRes.data.completed_at) {
      events.push({
        at:    obRes.data.completed_at,
        type:  'onboarding_completed',
        icon:  '✓',
        color: '#15803d',
        title: 'Onboarding complete',
        body:  obRes.data.step === 'setup_requested' ? 'Requested setup assistance' : null,
      })
    }
    if (obRes.data.step === 'setup_requested' && obRes.data.metadata) {
      events.push({
        at:    obRes.data.updated_at ?? obRes.data.created_at,
        type:  'setup_request',
        icon:  '📋',
        color: '#d97706',
        title: 'Setup request submitted',
        body:  `${obRes.data.metadata.restaurantName ?? 'Unknown restaurant'}${obRes.data.metadata.city ? ` · ${obRes.data.metadata.city}` : ''}`,
      })
    }
  }

  // Integrations connected (one event per integration)
  for (const i of integsRes.data ?? []) {
    events.push({
      at:    i.created_at,
      type:  'integration_connected',
      icon:  '🔌',
      color: '#3b82f6',
      title: `Connected ${i.provider}${i.department ? ` · ${i.department}` : ''}`,
      body:  i.status === 'connected' ? null : `Status: ${i.status}`,
    })
    if (i.last_sync_at) {
      events.push({
        at:    i.last_sync_at,
        type:  'last_sync',
        icon:  '↻',
        color: i.last_error ? '#dc2626' : '#6b7280',
        title: `Last sync · ${i.provider}${i.department ? ` / ${i.department}` : ''}`,
        body:  i.last_error ? `Error: ${i.last_error.slice(0, 120)}` : null,
      })
    }
  }

  // Recent sync_log entries
  for (const s of syncLogsRes.data ?? []) {
    events.push({
      at:    s.created_at,
      type:  'sync_run',
      icon:  s.status === 'success' ? '↻' : '⚠',
      color: s.status === 'success' ? '#15803d' : '#dc2626',
      title: `Sync · ${s.provider} · ${s.status}`,
      body:  s.status === 'success'
        ? `${s.records_synced ?? 0} records · ${s.duration_ms ? Math.round(s.duration_ms / 100) / 10 + 's' : '—'}`
        : (s.error_msg?.slice(0, 120) ?? 'Failed'),
    })
  }

  // Anomaly alerts
  for (const a of alertsRes.data ?? []) {
    events.push({
      at:    a.created_at,
      type:  'alert',
      icon:  a.severity === 'critical' ? '⚠' : '•',
      color: a.severity === 'critical' ? '#dc2626' : a.severity === 'warning' || a.severity === 'high' ? '#d97706' : '#6b7280',
      title: `Alert · ${a.severity}: ${a.title}`,
      body:  a.is_dismissed ? `(dismissed) ${(a.description ?? '').slice(0, 140)}` : (a.description ?? '').slice(0, 140),
    })
  }

  // Support notes
  for (const n of notesRes.data ?? []) {
    events.push({
      at:    n.created_at,
      type:  'note',
      icon:  '✎',
      color: '#6366f1',
      title: 'Internal note',
      body:  `${n.author ? `(${n.author}) ` : ''}${n.note}`,
    })
  }

  // Admin actions (if admin_log schema matches)
  for (const l of adminLogsRes?.data ?? []) {
    events.push({
      at:    l.created_at,
      type:  'admin_action',
      icon:  '⚙',
      color: '#8b5cf6',
      title: `Admin · ${l.action}`,
      body:  l.admin_email ? `by ${l.admin_email}` : null,
    })
  }

  // Sort newest first, filter invalid, cap at 200 for perf
  const sorted = events
    .filter(e => e.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 200)

  return NextResponse.json({ events: sorted })
}
