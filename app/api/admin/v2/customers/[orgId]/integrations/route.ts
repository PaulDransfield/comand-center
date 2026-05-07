// app/api/admin/v2/customers/[orgId]/integrations/route.ts
//
// READ-ONLY integration list for the customer-detail Integrations tab.
// Per-integration: provider, status, last_sync_at, last_error, business
// name, sync recency badge.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const DAY_MS = 86_400_000

export async function GET(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  const db = createAdminClient()
  const now = Date.now()

  const [integsRes, bizRes] = await Promise.all([
    db.from('integrations')
      .select('id, business_id, provider, status, last_sync_at, last_error, reauth_notified_at, created_at, backfill_status, backfill_progress, backfill_error, backfill_started_at, backfill_finished_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: true }),
    db.from('businesses')
      .select('id, name')
      .eq('org_id', orgId),
  ])

  const bizName: Record<string, string> = {}
  for (const b of bizRes.data ?? []) bizName[b.id] = b.name

  const integrations = (integsRes.data ?? []).map((i: any) => {
    const lastMs = i.last_sync_at ? new Date(i.last_sync_at).getTime() : 0
    const ageDays = lastMs > 0 ? Math.floor((now - lastMs) / DAY_MS) : null
    let healthBadge: 'ok' | 'warn' | 'critical' = 'ok'
    if (i.status === 'error')               healthBadge = 'critical'
    else if (i.status === 'needs_reauth')   healthBadge = 'warn'
    else if (i.status === 'disconnected')   healthBadge = 'critical'
    else if (ageDays != null && ageDays > 1) healthBadge = 'warn'
    else if (ageDays == null)               healthBadge = 'warn'    // never synced
    return {
      id:               i.id,
      business_id:      i.business_id,
      business_name:    bizName[i.business_id] ?? '—',
      provider:         i.provider,
      status:           i.status,
      last_sync_at:     i.last_sync_at,
      last_sync_age_days: ageDays,
      last_error:       i.last_error,
      reauth_notified_at: i.reauth_notified_at,
      created_at:       i.created_at,
      health:           healthBadge,
      backfill_status:  i.backfill_status ?? null,
      backfill_progress: i.backfill_progress ?? null,
      backfill_error:   i.backfill_error ?? null,
      backfill_started_at: i.backfill_started_at ?? null,
      backfill_finished_at: i.backfill_finished_at ?? null,
    }
  })

  return NextResponse.json({
    integrations,
    total: integrations.length,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
