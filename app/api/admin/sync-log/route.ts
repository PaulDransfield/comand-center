// @ts-nocheck
// app/api/admin/sync-log/route.ts
// Returns recent sync runs from the sync_log table.
// Also supports POST to trigger the master-sync manually.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// GET — last 50 sync runs across all orgs
export async function GET(req: NextRequest) {
  const db = createAdminClient()

  const { data: logs, error } = await db
    .from('sync_log')
    .select('id, org_id, provider, status, records_synced, date_from, date_to, error_msg, duration_ms, created_at')
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Enrich with org name
  const orgIds = [...new Set((logs ?? []).map((l: any) => l.org_id))]
  const { data: orgs } = await db
    .from('organisations')
    .select('id, name')
    .in('id', orgIds)

  const orgMap: Record<string, string> = {}
  for (const o of orgs ?? []) orgMap[o.id] = o.name

  const enriched = (logs ?? []).map((l: any) => ({
    ...l,
    org_name: orgMap[l.org_id] ?? l.org_id.slice(0, 8),
  }))

  return NextResponse.json({ logs: enriched })
}

// POST — trigger master-sync immediately (admin use only)
export async function POST(req: NextRequest) {
  // Call the master-sync endpoint with the cron secret
  const baseUrl   = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const cronSecret = process.env.CRON_SECRET ?? 'commandcenter123'

  const res = await fetch(`${baseUrl}/api/cron/master-sync?secret=${cronSecret}`, {
    method: 'GET',
  })

  const data = await res.json()
  return NextResponse.json(data, { status: res.status })
}
